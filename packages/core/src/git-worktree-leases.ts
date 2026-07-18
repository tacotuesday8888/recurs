import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";

import {
  isCredentialPath,
  ToolError,
  runProcess,
  safeGitArguments,
} from "@recurs/tools";

import {
  acquirePrivateOwnerLock,
  reclaimPrivateOwnerLock,
  type PrivateOwnerLock,
} from "./private-owner-lock.js";

const LEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const GIT_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_BYTES = 128 * 1024;
const DIRECTORY_MODE = 0o700;
const MAX_RECOVERY_ENTRIES = 1024;

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

export interface GitWorktreeLeaseAuthority extends GitWorktreeLeasePort {
  assertActive(lease: GitWorktreeLease): Promise<void>;
}

export interface GitWorktreeRecoveryInput {
  readonly repositoryRoot: string;
}

export interface GitWorktreeRecoveryOutcome {
  readonly removedLeaseIds: readonly string[];
  readonly busyLeaseIds: readonly string[];
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

interface WorktreeRegistration {
  readonly root: string;
  readonly revision: string;
  readonly detached: boolean;
}

interface ActiveLease {
  readonly lease: GitWorktreeLease;
  readonly owner: PrivateOwnerLock;
  worktreeRemoved: boolean;
}

async function requireCanonicalAncestor(target: string): Promise<void> {
  let ancestor = target;
  for (;;) {
    try {
      await lstat(ancestor);
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  if (await realpath(ancestor) !== ancestor) {
    throw new ToolError(
      "permission_denied",
      "The Recurs worktree directory cannot traverse symbolic links",
    );
  }
}

async function inspectPrivateRoot(
  root: string,
  allowMissing: boolean,
): Promise<boolean> {
  let details;
  try {
    details = await lstat(root);
  } catch (error) {
    if (allowMissing && isMissing(error)) return false;
    throw error;
  }
  if (!details.isDirectory() || details.isSymbolicLink() ||
    (details.mode & 0o777) !== DIRECTORY_MODE || await realpath(root) !== root) {
    throw new ToolError(
      "permission_denied",
      "The Recurs worktree directory must be private and canonical",
    );
  }
  return true;
}

async function exactWorktreeDirectory(
  root: string,
  id: string,
  target: string,
): Promise<boolean> {
  if (!LEASE_ID.test(id) || path.dirname(target) !== root ||
    path.basename(target) !== id) {
    return false;
  }
  let details;
  try {
    details = await lstat(target);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (!details.isDirectory() || details.isSymbolicLink()) return false;
  try {
    return await realpath(target) === target;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function parseWorktreeRegistrations(output: string): Map<string, WorktreeRegistration> {
  const fields = output.split("\0");
  if (fields.at(-1) !== "") {
    throw new ToolError("process_failed", "Git worktree registration is invalid");
  }
  fields.pop();
  const registrations = new Map<string, WorktreeRegistration>();
  let root: string | null = null;
  let revision: string | null = null;
  let detached = false;
  let branchState = false;
  const finish = (): void => {
    if (root === null && revision === null) return;
    if (root === null || revision === null || !path.isAbsolute(root) ||
      !GIT_REVISION.test(revision) || registrations.has(root)) {
      throw new ToolError("process_failed", "Git worktree registration is invalid");
    }
    registrations.set(root, { root, revision, detached });
    root = null;
    revision = null;
    detached = false;
    branchState = false;
  };
  for (const field of fields) {
    if (field === "") {
      finish();
    } else if (field.startsWith("worktree ")) {
      if (root !== null) {
        throw new ToolError("process_failed", "Git worktree registration is invalid");
      }
      root = field.slice("worktree ".length);
    } else if (field.startsWith("HEAD ")) {
      if (root === null || revision !== null) {
        throw new ToolError("process_failed", "Git worktree registration is invalid");
      }
      revision = field.slice("HEAD ".length);
    } else if (field === "detached") {
      if (root === null || revision === null || detached || branchState) {
        throw new ToolError("process_failed", "Git worktree registration is invalid");
      }
      detached = true;
    } else if (field.startsWith("branch ")) {
      if (root === null || revision === null || detached || branchState ||
        field.length === "branch ".length) {
        throw new ToolError("process_failed", "Git worktree registration is invalid");
      }
      branchState = true;
    } else if (field === "bare" || field === "locked" ||
      field.startsWith("locked ") || field === "prunable" ||
      field.startsWith("prunable ")) {
      if (root === null) {
        throw new ToolError("process_failed", "Git worktree registration is invalid");
      }
    } else {
      throw new ToolError("process_failed", "Git worktree registration is invalid");
    }
  }
  finish();
  return registrations;
}

export class GitWorktreeLeaseManager implements GitWorktreeLeaseAuthority {
  readonly #configuredRoot: string;
  readonly #createId: () => string;
  readonly #processRunner: typeof runProcess;
  readonly #pending = new Set<string>();
  readonly #active = new Map<string, ActiveLease>();
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
    if (!path.isAbsolute(input) || path.resolve(input) !== input) {
      throw new ToolError(
        "permission_denied",
        "Parallel delegation requires a canonical repository path",
      );
    }
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
    if (candidate !== input) {
      throw new ToolError(
        "permission_denied",
        "Parallel delegation requires a canonical repository path",
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
    if (isCredentialPath(this.#configuredRoot) ||
      within(repositoryRoot, this.#configuredRoot) ||
      within(this.#configuredRoot, repositoryRoot)) {
      throw new ToolError(
        "permission_denied",
        "The Recurs worktree directory must be disjoint from the repository",
      );
    }
    try {
      await requireCanonicalAncestor(this.#configuredRoot);
      if (!await inspectPrivateRoot(this.#configuredRoot, true)) {
        await mkdir(this.#configuredRoot, {
          recursive: true,
          mode: DIRECTORY_MODE,
        });
      }
      await inspectPrivateRoot(this.#configuredRoot, false);
      if (within(repositoryRoot, this.#configuredRoot) ||
        within(this.#configuredRoot, repositoryRoot)) {
        throw new ToolError(
          "permission_denied",
          "The Recurs worktree directory must be disjoint from the repository",
        );
      }
      return this.#configuredRoot;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(
        "process_failed",
        "The Recurs worktree directory could not be prepared",
        { cause: error },
      );
    }
  }

  async #existingLeaseRoot(repositoryRoot: string): Promise<string | null> {
    if (isCredentialPath(this.#configuredRoot) ||
      within(repositoryRoot, this.#configuredRoot) ||
      within(this.#configuredRoot, repositoryRoot)) {
      throw new ToolError(
        "permission_denied",
        "The Recurs worktree directory must be disjoint from the repository",
      );
    }
    if (!await inspectPrivateRoot(this.#configuredRoot, true)) return null;
    return this.#configuredRoot;
  }

  async #registrations(
    repositoryRoot: string,
  ): Promise<Map<string, WorktreeRegistration>> {
    return parseWorktreeRegistrations((await this.#git(repositoryRoot, [
      "worktree", "list", "--porcelain", "-z",
    ])).stdout);
  }

  async #isWorktreeRemoved(
    repositoryRoot: string,
    worktreeRoot: string,
  ): Promise<boolean> {
    return !await exists(worktreeRoot) &&
      !(await this.#registrations(repositoryRoot)).has(worktreeRoot);
  }

  async #assertOwnedTarget(
    active: ActiveLease,
    requireOriginalRevision: boolean,
  ): Promise<void> {
    await active.owner.assertOwned();
    const repository = await this.#repositoryRoot(
      active.lease.repositoryRoot,
      new AbortController().signal,
    );
    const root = await this.#existingLeaseRoot(repository);
    if (root === null ||
      !await exactWorktreeDirectory(
        root,
        active.lease.id,
        active.lease.worktreeRoot,
      )) {
      throw new ToolError("permission_denied", "The Git worktree lease is not active");
    }
    const registration = (await this.#registrations(repository))
      .get(active.lease.worktreeRoot);
    if (registration === undefined) {
      throw new ToolError("permission_denied", "The Git worktree lease is not active");
    }
    if (!requireOriginalRevision) return;
    if (!registration.detached || registration.revision !== active.lease.revision) {
      throw new ToolError("permission_denied", "The Git worktree lease is not active");
    }
    const observed = (await this.#git(active.lease.worktreeRoot, [
      "rev-parse", "--verify", "HEAD^{commit}",
    ])).stdout.trim();
    if (observed !== active.lease.revision) {
      throw new ToolError("permission_denied", "The Git worktree lease is not active");
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
    if (within(repository, this.#configuredRoot) ||
      within(this.#configuredRoot, repository)) {
      throw new ToolError(
        "permission_denied",
        "The Recurs worktree directory must be disjoint from the repository",
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
    const owner = await acquirePrivateOwnerLock(leaseRoot, {
      leaseId: id,
      repositoryRoot: repository,
      worktreeRoot: target,
      revision,
    });
    if (owner === null) {
      throw new ToolError(
        "permission_denied",
        "The Git worktree lease is already owned by another process",
      );
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
      this.#active.set(id, { lease, owner, worktreeRemoved: false });
      return lease;
    } catch (error) {
      try {
        await this.#recoverCreation(repository, target);
        await owner.release();
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

  async recoverStale(
    input: GitWorktreeRecoveryInput,
  ): Promise<GitWorktreeRecoveryOutcome> {
    if (typeof input !== "object" || input === null ||
      Object.keys(input).join(",") !== "repositoryRoot" ||
      typeof input.repositoryRoot !== "string") {
      throw new ToolError("permission_denied", "Worktree recovery input is invalid");
    }
    const repository = await this.#repositoryRoot(
      input.repositoryRoot,
      new AbortController().signal,
    );
    const root = await this.#existingLeaseRoot(repository);
    if (root === null) return { removedLeaseIds: [], busyLeaseIds: [] };
    const registrations = await this.#registrations(repository);
    const candidates: string[] = [];
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.length > MAX_RECOVERY_ENTRIES) {
      throw new ToolError(
        "permission_denied",
        "Worktree recovery directory exceeds its bounded entry limit",
      );
    }
    for (const entry of entries) {
      if (!LEASE_ID.test(entry.name) || !entry.isDirectory() ||
        entry.isSymbolicLink()) {
        continue;
      }
      const target = path.join(root, entry.name);
      const registration = registrations.get(target);
      if (registration === undefined ||
        !await exactWorktreeDirectory(root, entry.name, target)) {
        continue;
      }
      candidates.push(entry.name);
    }
    candidates.sort((left, right) => left.localeCompare(right));

    const removedLeaseIds: string[] = [];
    const busyLeaseIds: string[] = [];
    for (const id of candidates) {
      const target = path.join(root, id);
      const expected = registrations.get(target);
      if (expected === undefined) continue;
      const reclaimed = await reclaimPrivateOwnerLock(root, {
        leaseId: id,
        repositoryRoot: repository,
        worktreeRoot: target,
        revision: expected.revision,
      });
      if (reclaimed.status === "busy") {
        busyLeaseIds.push(id);
        continue;
      }
      if (reclaimed.status !== "acquired") continue;
      const owner = reclaimed.lock;
      try {
        await owner.assertOwned();
      } catch {
        busyLeaseIds.push(id);
        continue;
      }
      let registration: WorktreeRegistration | undefined;
      let revision: string;
      try {
        registration = (await this.#registrations(repository)).get(target);
        if (registration === undefined ||
          registration.revision !== owner.binding.revision ||
          !await exactWorktreeDirectory(root, id, target)) {
          await owner.abandon();
          continue;
        }
        revision = (await this.#git(target, [
          "rev-parse", "--verify", "HEAD^{commit}",
        ])).stdout.trim();
        if (revision !== registration.revision) {
          await owner.abandon();
          continue;
        }
      } catch (error) {
        try {
          await owner.abandon();
        } catch {
          // A competing recovery now owns the exact binding.
        }
        throw error;
      }
      try {
        await owner.assertOwned();
      } catch {
        busyLeaseIds.push(id);
        continue;
      }
      try {
        await this.#git(repository, ["worktree", "remove", "--force", target]);
      } catch (error) {
        if (!await this.#isWorktreeRemoved(repository, target)) {
          try {
            await owner.abandon();
          } catch {
            // Preserve the primary Git failure if ownership changed concurrently.
          }
          throw error;
        }
      }
      if (!await this.#isWorktreeRemoved(repository, target)) {
        try {
          await owner.abandon();
        } catch {
          // Preserve the ambiguous removal result if ownership changed concurrently.
        }
        throw new ToolError("process_failed", "Stale worktree recovery was ambiguous");
      }
      removedLeaseIds.push(id);
      try {
        await owner.release();
      } catch {
        // The worktree is confirmed absent; owner cleanup is now orphan collection.
      }
    }
    return { removedLeaseIds, busyLeaseIds };
  }

  async assertActive(lease: GitWorktreeLease): Promise<void> {
    if (!validLeaseShape(lease)) {
      throw new ToolError("permission_denied", "The Git worktree lease is invalid");
    }
    const active = this.#active.get(lease.id);
    if (active === undefined || active.worktreeRemoved ||
      !sameLease(active.lease, lease) ||
      path.basename(active.lease.worktreeRoot) !== active.lease.id) {
      throw new ToolError("permission_denied", "The Git worktree lease is not owned");
    }
    await this.#assertOwnedTarget(active, true);
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
    if (!sameLease(active.lease, lease)) {
      throw new ToolError("permission_denied", "The Git worktree lease is not owned");
    }
    if (!active.worktreeRemoved) {
      await this.#assertOwnedTarget(active, false);
      try {
        await this.#git(active.lease.repositoryRoot, [
          "worktree", "remove", "--force", active.lease.worktreeRoot,
        ]);
      } catch (error) {
        if (!await this.#isWorktreeRemoved(
          active.lease.repositoryRoot,
          active.lease.worktreeRoot,
        )) {
          throw new ToolError(
            "process_failed",
            "Git worktree cleanup failed",
            { cause: error },
          );
        }
      }
      if (!await this.#isWorktreeRemoved(
        active.lease.repositoryRoot,
        active.lease.worktreeRoot,
      )) {
        throw new ToolError("process_failed", "Git worktree cleanup was ambiguous");
      }
      active.worktreeRemoved = true;
    }
    try {
      await active.owner.release();
    } catch (error) {
      throw new ToolError(
        "process_failed",
        "Git worktree owner cleanup failed",
        { cause: error },
      );
    }
    this.#active.delete(active.lease.id);
    this.#released.set(active.lease.id, active.lease);
  }
}
