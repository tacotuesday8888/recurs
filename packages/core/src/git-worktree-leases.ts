import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";

import {
  ToolError,
  runProcess,
  safeGitArguments,
} from "@recurs/tools";

const LEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const GIT_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_BYTES = 128 * 1024;

export interface GitWorktreeLease {
  readonly id: string;
  readonly repositoryRoot: string;
  readonly worktreeRoot: string;
  readonly revision: string;
}

export interface GitWorktreeLeasePort {
  create(
    repositoryRoot: string,
    signal: AbortSignal,
  ): Promise<GitWorktreeLease>;
  release(lease: GitWorktreeLease): Promise<void>;
}

export interface GitWorktreeLeaseManagerOptions {
  readonly rootDirectory: string;
  readonly createId?: () => string;
  readonly processRunner?: typeof runProcess;
}

function aborted(): ToolError {
  return new ToolError("cancelled", "Git worktree creation was cancelled");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "ENOENT";
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function within(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sameLease(left: GitWorktreeLease, right: GitWorktreeLease): boolean {
  return left.id === right.id &&
    left.repositoryRoot === right.repositoryRoot &&
    left.worktreeRoot === right.worktreeRoot &&
    left.revision === right.revision;
}

function validLeaseShape(value: unknown): value is GitWorktreeLease {
  return typeof value === "object" && value !== null &&
    "id" in value && typeof value.id === "string" && LEASE_ID.test(value.id) &&
    "repositoryRoot" in value && typeof value.repositoryRoot === "string" &&
    path.isAbsolute(value.repositoryRoot) &&
    path.resolve(value.repositoryRoot) === value.repositoryRoot &&
    "worktreeRoot" in value && typeof value.worktreeRoot === "string" &&
    path.isAbsolute(value.worktreeRoot) &&
    path.resolve(value.worktreeRoot) === value.worktreeRoot &&
    "revision" in value && typeof value.revision === "string" &&
    GIT_REVISION.test(value.revision);
}

export class GitWorktreeLeaseManager implements GitWorktreeLeasePort {
  readonly #configuredRoot: string;
  readonly #createId: () => string;
  readonly #processRunner: typeof runProcess;
  readonly #pending = new Set<string>();
  readonly #active = new Map<string, GitWorktreeLease>();
  readonly #released = new Map<string, GitWorktreeLease>();

  constructor(options: GitWorktreeLeaseManagerOptions) {
    this.#configuredRoot = path.resolve(options.rootDirectory);
    this.#createId = options.createId ?? randomUUID;
    this.#processRunner = options.processRunner ?? runProcess;
  }

  async #git(
    repositoryRoot: string,
    command: readonly string[],
    signal?: AbortSignal,
  ) {
    const args = await safeGitArguments(
      repositoryRoot,
      command,
      signal,
      this.#processRunner,
    );
    return this.#processRunner("git", args, {
      cwd: repositoryRoot,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_OUTPUT_BYTES,
    });
  }

  async #repositoryRoot(input: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw aborted();
    let candidate: string;
    try {
      candidate = await realpath(input);
    } catch (error) {
      throw new ToolError(
        "tool_unavailable",
        "The Git repository root is unavailable",
        { cause: error },
      );
    }
    const discovered = await this.#git(
      candidate,
      ["rev-parse", "--show-toplevel"],
      signal,
    );
    let root: string;
    try {
      root = await realpath(discovered.stdout.trim());
    } catch (error) {
      throw new ToolError(
        "tool_unavailable",
        "The Git repository root could not be verified",
        { cause: error },
      );
    }
    if (root !== candidate) {
      throw new ToolError(
        "permission_denied",
        "Parallel delegation must start at the Git repository root",
      );
    }
    return root;
  }

  async #leaseRoot(repositoryRoot: string): Promise<string> {
    if (within(repositoryRoot, this.#configuredRoot)) {
      throw new ToolError(
        "permission_denied",
        "The Recurs worktree directory must be outside the repository",
      );
    }
    try {
      await mkdir(this.#configuredRoot, { recursive: true, mode: 0o700 });
      const root = await realpath(this.#configuredRoot);
      if (within(repositoryRoot, root)) {
        throw new ToolError(
          "permission_denied",
          "The Recurs worktree directory must be outside the repository",
        );
      }
      return root;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(
        "process_failed",
        "The Recurs worktree directory could not be prepared",
        { cause: error },
      );
    }
  }

  async #recoverCreation(
    repositoryRoot: string,
    worktreeRoot: string,
  ): Promise<void> {
    try {
      await this.#git(repositoryRoot, [
        "worktree", "remove", "--force", worktreeRoot,
      ]);
    } catch {
      // A partially created target may not yet be registered with Git.
    }
    try {
      if (await exists(worktreeRoot)) {
        await rm(worktreeRoot, { recursive: true, force: true });
      }
      await this.#git(repositoryRoot, ["worktree", "prune", "--expire=now"]);
      if (await exists(worktreeRoot)) {
        throw new Error("worktree target remains");
      }
    } catch (error) {
      throw new ToolError(
        "process_failed",
        "Git worktree cleanup failed after creation",
        { cause: error },
      );
    }
  }

  async create(
    repositoryRoot: string,
    signal: AbortSignal,
  ): Promise<GitWorktreeLease> {
    if (signal.aborted) throw aborted();
    const id = this.#createId();
    if (!LEASE_ID.test(id) || this.#pending.has(id) ||
      this.#active.has(id) || this.#released.has(id)) {
      throw new ToolError("permission_denied", "The Git worktree lease ID is invalid");
    }
    this.#pending.add(id);
    try {
      return await this.#createReserved(id, repositoryRoot, signal);
    } finally {
      this.#pending.delete(id);
    }
  }

  async #createReserved(
    id: string,
    repositoryRoot: string,
    signal: AbortSignal,
  ): Promise<GitWorktreeLease> {
    const repository = await this.#repositoryRoot(repositoryRoot, signal);
    if (within(repository, this.#configuredRoot)) {
      throw new ToolError(
        "permission_denied",
        "The Recurs worktree directory must be outside the repository",
      );
    }
    const status = await this.#git(repository, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ], signal);
    if (status.stdout.length !== 0) {
      throw new ToolError(
        "permission_denied",
        "Parallel delegation requires a clean Git working tree",
      );
    }
    const revisionResult = await this.#git(
      repository,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      signal,
    );
    const revision = revisionResult.stdout.trim();
    if (!GIT_REVISION.test(revision)) {
      throw new ToolError("process_failed", "The Git revision could not be verified");
    }
    const leaseRoot = await this.#leaseRoot(repository);
    const target = path.join(leaseRoot, id);
    if (path.dirname(target) !== leaseRoot || await exists(target)) {
      throw new ToolError("permission_denied", "The Git worktree target is unavailable");
    }

    try {
      await this.#git(repository, [
        "worktree", "add", "--detach", target, revision,
      ], signal);
      const created = await realpath(target);
      if (created !== target) {
        throw new ToolError("permission_denied", "The Git worktree target is invalid");
      }
      const lease = Object.freeze({
        id,
        repositoryRoot: repository,
        worktreeRoot: created,
        revision,
      });
      this.#active.set(id, lease);
      return lease;
    } catch (error) {
      try {
        await this.#recoverCreation(repository, target);
      } catch (cleanupError) {
        throw new ToolError(
          "process_failed",
          "Git worktree cleanup failed after creation",
          { cause: cleanupError },
        );
      }
      if (error instanceof ToolError) throw error;
      throw new ToolError(
        "process_failed",
        "Git worktree creation failed",
        { cause: error },
      );
    }
  }

  async release(lease: GitWorktreeLease): Promise<void> {
    if (!validLeaseShape(lease)) {
      throw new ToolError("permission_denied", "The Git worktree lease is invalid");
    }
    const active = this.#active.get(lease.id);
    if (active === undefined) {
      const released = this.#released.get(lease.id);
      if (released !== undefined && sameLease(released, lease)) return;
      throw new ToolError("permission_denied", "The Git worktree lease is not owned");
    }
    if (!sameLease(active, lease) ||
      path.basename(active.worktreeRoot) !== active.id) {
      throw new ToolError("permission_denied", "The Git worktree lease is not owned");
    }
    try {
      await this.#git(active.repositoryRoot, [
        "worktree", "remove", "--force", active.worktreeRoot,
      ]);
      if (await exists(active.worktreeRoot)) {
        throw new Error("worktree target remains");
      }
    } catch (error) {
      throw new ToolError(
        "process_failed",
        "Git worktree cleanup failed",
        { cause: error },
      );
    }
    this.#active.delete(active.id);
    this.#released.set(active.id, active);
  }
}
