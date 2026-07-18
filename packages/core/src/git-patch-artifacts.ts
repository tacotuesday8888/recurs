import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  isCredentialPath,
  runProcess,
  safeGitArguments,
  ToolError,
  type Checkpoint,
  type CheckpointStore,
  type WorkspaceManifest,
} from "@recurs/tools";

import type {
  GitWorktreeLease,
  GitWorktreeLeaseAuthority,
} from "./git-worktree-leases.js";
import { compareStrings, uniqueSortedStrings } from "./stable-order.js";

const GIT_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const RAW_DIFF_HEADER = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/u;
const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_PATCH_PROCESS_BYTES = MAX_PATCH_BYTES + 64 * 1024;
const MAX_RESULT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_STATUS_BYTES = 256 * 1024;
const MAX_PATHS = 256;
const GIT_TIMEOUT_MS = 30_000;
const ALLOWED_FILE_MODES = new Set(["000000", "100644", "100755"]);

type GitProcessRunner = typeof runProcess;

export interface GitPatchBase {
  readonly repositoryRoot: string;
  readonly revision: string;
}

export interface GitPatchArtifactHandle {
  readonly id: string;
  readonly leaseId: string;
  readonly baseRevision: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly paths: readonly string[];
}

export type GitPatchResultFingerprint =
  | {
      readonly path: string;
      readonly kind: "file";
      readonly sha256: string;
      readonly byteLength: number;
      readonly mode: "100644" | "100755";
    }
  | {
      readonly path: string;
      readonly kind: "deleted";
    };

export interface StoredGitPatchArtifact {
  readonly handle: GitPatchArtifactHandle;
  readonly repositoryRoot: string;
  readonly patch: string;
  readonly after: readonly GitPatchResultFingerprint[];
}

export interface GitPatchArtifactStore {
  put(artifact: StoredGitPatchArtifact): Promise<void>;
  load(handle: GitPatchArtifactHandle): Promise<StoredGitPatchArtifact>;
  remove(handles: readonly GitPatchArtifactHandle[]): Promise<void>;
}

export interface GitPatchArtifactManagerOptions {
  readonly createId?: () => string;
  readonly processRunner?: GitProcessRunner;
  readonly leases?: Pick<GitWorktreeLeaseAuthority, "assertActive">;
  readonly store?: GitPatchArtifactStore;
}

export interface GitPatchStageInput {
  readonly lease: GitWorktreeLease;
  readonly artifacts: readonly GitPatchArtifactHandle[];
  readonly signal: AbortSignal;
}

export interface GitPatchStageOutcome {
  readonly changedFiles: readonly string[];
}

export interface GitPatchCandidatePrepareInput {
  readonly base: GitPatchBase;
  readonly artifact: GitPatchArtifactHandle;
  readonly sessionId: string;
  readonly operationId: string;
  readonly checkpoints: CheckpointStore;
  readonly signal: AbortSignal;
}

export interface GitPatchCandidateApplyInput {
  readonly base: GitPatchBase;
  readonly artifact: GitPatchArtifactHandle;
  readonly checkpoint: Checkpoint;
  readonly checkpoints: CheckpointStore;
  readonly signal: AbortSignal;
}

export interface GitPatchCandidateApplyOutcome {
  readonly changedFiles: readonly string[];
}

export type GitPatchCandidateCompleteInput = GitPatchCandidateApplyInput;

export interface GitPatchCandidateCompleteOutcome {
  readonly checkpoint: Checkpoint;
  readonly changedFiles: readonly string[];
}

export interface GitPatchIntegrationInput {
  readonly base: GitPatchBase;
  readonly artifacts: readonly GitPatchArtifactHandle[];
  readonly sessionId: string;
  readonly operationId: string;
  readonly checkpoints: CheckpointStore;
  readonly signal: AbortSignal;
}

export type GitPatchIntegrationOutcome =
  | {
      readonly ok: true;
      readonly artifactIds: readonly string[];
      readonly changedFiles: readonly string[];
      readonly checkpointId: string;
    }
  | {
      readonly ok: false;
      readonly code: "patch_failed" | "cancelled";
      readonly message: string;
      readonly artifactId: string;
      readonly integratedArtifactIds: readonly string[];
      readonly rolledBack: boolean;
      readonly restored: readonly string[];
      readonly deleted: readonly string[];
    };

function cancelled(message: string): ToolError {
  return new ToolError("cancelled", message);
}

function safeRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 4096 ||
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
    })
  ) {
    throw new ToolError(
      "permission_denied",
      "Patch paths must use unambiguous workspace-relative spelling",
    );
  }
  if (isCredentialPath(value)) {
    throw new ToolError(
      "permission_denied",
      "Credential paths cannot enter a team patch artifact",
    );
  }
  return value;
}

function boundedPaths(values: Iterable<string>): string[] {
  const paths = uniqueSortedStrings(values);
  if (paths.length === 0 || paths.length > MAX_PATHS) {
    throw new ToolError(
      "permission_denied",
      `A team patch must change between 1 and ${MAX_PATHS} files`,
    );
  }
  return paths;
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function changedManifestPaths(
  before: WorkspaceManifest,
  after: WorkspaceManifest,
): string[] {
  return uniqueSortedStrings([...Object.keys(before), ...Object.keys(after)])
    .filter((candidate) =>
      !isDeepStrictEqual(before[candidate], after[candidate])
    );
}

function manifestMatchesArtifact(
  after: WorkspaceManifest,
  fingerprints: readonly GitPatchResultFingerprint[],
): boolean {
  return fingerprints.every((fingerprint) => {
    const entry = after[fingerprint.path];
    if (fingerprint.kind === "deleted") return entry === undefined;
    return entry?.kind === "file" && entry.blob === fingerprint.sha256 &&
      entry.size === fingerprint.byteLength &&
      entry.mode === (fingerprint.mode === "100755" ? 0o755 : 0o644);
  });
}

function sameHandle(
  left: GitPatchArtifactHandle,
  right: GitPatchArtifactHandle,
): boolean {
  return left.id === right.id &&
    left.leaseId === right.leaseId &&
    left.baseRevision === right.baseRevision &&
    left.sha256 === right.sha256 &&
    left.byteLength === right.byteLength &&
    samePaths(left.paths, right.paths);
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : null;
}

async function fingerprintResult(
  worktreeRoot: string,
  files: readonly string[],
  signal: AbortSignal,
): Promise<GitPatchResultFingerprint[]> {
  const results: GitPatchResultFingerprint[] = [];
  for (const file of files) {
    if (signal.aborted) throw cancelled("Patch capture was cancelled");
    const target = path.join(worktreeRoot, safeRelativePath(file));
    let handle;
    try {
      handle = await open(
        target,
        constants.O_RDONLY |
          (constants.O_NONBLOCK ?? 0) |
          (constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        results.push({ path: file, kind: "deleted" });
        continue;
      }
      if (errorCode(error) === "ELOOP") {
        throw new ToolError(
          "permission_denied",
          "Team patch artifacts cannot contain symbolic links",
        );
      }
      throw new ToolError(
        "process_failed",
        "A team patch result could not be inspected",
        { cause: error },
      );
    }
    try {
      const before = await handle.stat();
      if (!before.isFile() || !Number.isSafeInteger(before.size) ||
        before.size < 0) {
        throw new ToolError(
          "permission_denied",
          "Team patch artifacts can contain only regular files",
        );
      }
      if (before.size > MAX_RESULT_FILE_BYTES) {
        throw new ToolError(
          "permission_denied",
          `A team patch result file exceeds the ${MAX_RESULT_FILE_BYTES}-byte limit`,
        );
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let byteLength = 0;
      while (byteLength < before.size) {
        if (signal.aborted) throw cancelled("Patch capture was cancelled");
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, before.size - byteLength),
          byteLength,
        );
        if (bytesRead === 0) {
          throw new ToolError(
            "permission_denied",
            "A team patch result changed while it was fingerprinted",
          );
        }
        byteLength += bytesRead;
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mode !== after.mode ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        byteLength !== after.size
      ) {
        throw new ToolError(
          "permission_denied",
          "A team patch result changed while it was fingerprinted",
        );
      }
      results.push({
        path: file,
        kind: "file",
        sha256: hash.digest("hex"),
        byteLength,
        mode: (after.mode & 0o111) === 0 ? "100644" : "100755",
      });
    } finally {
      await handle.close();
    }
  }
  return results;
}

function cloneFreeze<T>(value: T): T {
  const cloned = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (typeof item !== "object" || item === null || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(cloned);
  return cloned;
}

export class InMemoryGitPatchArtifactStore implements GitPatchArtifactStore {
  readonly #artifacts = new Map<string, StoredGitPatchArtifact>();

  async put(artifact: StoredGitPatchArtifact): Promise<void> {
    const existing = this.#artifacts.get(artifact.handle.id);
    if (existing !== undefined && !isDeepStrictEqual(existing, artifact)) {
      throw new ToolError(
        "permission_denied",
        "Patch artifact ID is already bound to different content",
      );
    }
    if (existing === undefined) {
      this.#artifacts.set(artifact.handle.id, cloneFreeze(artifact));
    }
  }

  async load(handle: GitPatchArtifactHandle): Promise<StoredGitPatchArtifact> {
    const artifact = this.#artifacts.get(handle.id);
    if (artifact === undefined || !sameHandle(handle, artifact.handle)) {
      throw new ToolError("not_found", "Patch artifact was not found");
    }
    return cloneFreeze(artifact);
  }

  async remove(handles: readonly GitPatchArtifactHandle[]): Promise<void> {
    for (const handle of handles) {
      const artifact = this.#artifacts.get(handle.id);
      if (artifact !== undefined && !sameHandle(handle, artifact.handle)) {
        throw new ToolError(
          "permission_denied",
          "Patch artifact handle failed its integrity check",
        );
      }
    }
    for (const handle of handles) this.#artifacts.delete(handle.id);
  }
}

function parseStatus(output: string): {
  readonly paths: string[];
  readonly untracked: string[];
} {
  const records = output.split("\0");
  if (records.at(-1) === "") records.pop();
  const paths: string[] = [];
  const untracked: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length < 4 || record[2] !== " ") {
      throw new ToolError("permission_denied", "Git status could not be validated");
    }
    const status = record.slice(0, 2);
    const file = safeRelativePath(record.slice(3));
    paths.push(file);
    if (status === "??") untracked.push(file);
    if (status.includes("R") || status.includes("C")) {
      const source = records[index + 1];
      if (source === undefined) {
        throw new ToolError("permission_denied", "Git status could not be validated");
      }
      safeRelativePath(source);
      throw new ToolError(
        "permission_denied",
        "Rename and copy changes are unavailable in team patch artifacts",
      );
    }
  }
  return { paths: boundedPaths(paths), untracked };
}

function parseRawDiff(output: string): string[] {
  const records = output.split("\0");
  if (records.at(-1) === "") records.pop();
  const paths: string[] = [];
  for (let index = 0; index < records.length;) {
    const rawHeader = records[index++]!;
    const tab = rawHeader.indexOf("\t");
    const header = tab < 0 ? rawHeader : rawHeader.slice(0, tab);
    const inlinePath = tab < 0 ? null : rawHeader.slice(tab + 1);
    const match = RAW_DIFF_HEADER.exec(header);
    const file = inlinePath ?? records[index++];
    if (match === null || file === undefined) {
      throw new ToolError("permission_denied", "Git patch modes could not be validated");
    }
    const oldMode = match[1]!;
    const newMode = match[2]!;
    const status = match[3]!;
    if (!ALLOWED_FILE_MODES.has(oldMode) || !ALLOWED_FILE_MODES.has(newMode)) {
      throw new ToolError(
        "permission_denied",
        "Team patch artifacts cannot contain symbolic links or submodules",
      );
    }
    if (oldMode !== "000000" && newMode !== "000000" && oldMode !== newMode) {
      throw new ToolError(
        "permission_denied",
        "Team patch artifacts cannot contain file-mode changes",
      );
    }
    if (status === "R" || status === "C") {
      throw new ToolError(
        "permission_denied",
        "Rename and copy changes are unavailable in team patch artifacts",
      );
    }
    paths.push(safeRelativePath(file));
  }
  return boundedPaths(paths);
}

function parseNumstat(output: string): string[] {
  const records = output.split("\0");
  if (records.at(-1) === "") records.pop();
  const paths: string[] = [];
  for (const record of records) {
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    const added = firstTab < 0 ? "" : record.slice(0, firstTab);
    const deleted = secondTab < 0 ? "" : record.slice(firstTab + 1, secondTab);
    const file = secondTab < 0 ? "" : record.slice(secondTab + 1);
    if (file.length === 0 || added.length === 0 || deleted.length === 0) {
      throw new ToolError("permission_denied", "Git patch statistics could not be validated");
    }
    if (added === "-" || deleted === "-") {
      throw new ToolError(
        "permission_denied",
        "Binary patches are unavailable in team patch artifacts",
      );
    }
    if (!/^\d+$/u.test(added) || !/^\d+$/u.test(deleted)) {
      throw new ToolError("permission_denied", "Git patch statistics could not be validated");
    }
    paths.push(safeRelativePath(file));
  }
  return boundedPaths(paths);
}

export class GitPatchArtifactManager {
  readonly #createId: () => string;
  readonly #processRunner: GitProcessRunner;
  readonly #leases: Pick<GitWorktreeLeaseAuthority, "assertActive"> | undefined;
  readonly #store: GitPatchArtifactStore;

  constructor(options: GitPatchArtifactManagerOptions = {}) {
    this.#createId = options.createId ?? randomUUID;
    this.#processRunner = options.processRunner ?? runProcess;
    this.#leases = options.leases;
    this.#store = options.store ?? new InMemoryGitPatchArtifactStore();
  }

  async #git(
    cwd: string,
    command: readonly string[],
    signal: AbortSignal,
    maxOutputBytes = MAX_STATUS_BYTES,
  ) {
    if (signal.aborted) throw cancelled("Git patch operation was cancelled");
    const args = await safeGitArguments(
      cwd,
      command,
      signal,
      this.#processRunner,
    );
    return this.#processRunner("git", args, {
      cwd,
      signal,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes,
    });
  }

  async #gitInput(
    cwd: string,
    command: readonly string[],
    patch: string,
    signal: AbortSignal,
  ) {
    if (signal.aborted) throw cancelled("Git patch operation was cancelled");
    const args = await safeGitArguments(
      cwd,
      command,
      signal,
      this.#processRunner,
    );
    return this.#processRunner("git", args, {
      cwd,
      stdin: patch,
      signal,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: MAX_STATUS_BYTES,
    });
  }

  async #canonicalRoot(input: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw cancelled("Git patch operation was cancelled");
    let candidate: string;
    try {
      candidate = await realpath(input);
    } catch (error) {
      throw new ToolError(
        "tool_unavailable",
        "The Git workspace is unavailable",
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
        "The Git workspace root could not be verified",
        { cause: error },
      );
    }
    if (root !== candidate) {
      throw new ToolError(
        "permission_denied",
        "Team implementation must start at a canonical Git root",
      );
    }
    return root;
  }

  async #revision(root: string, signal: AbortSignal): Promise<string> {
    const result = await this.#git(
      root,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      signal,
    );
    const revision = result.stdout.trim();
    if (!GIT_REVISION.test(revision)) {
      throw new ToolError("process_failed", "The Git revision could not be verified");
    }
    return revision;
  }

  async #loadOwnedArtifacts(
    handles: readonly GitPatchArtifactHandle[],
    repositoryRoot: string,
    revision: string,
  ): Promise<StoredGitPatchArtifact[]> {
    return Promise.all(handles.map(async (handle) => {
      let artifact: StoredGitPatchArtifact;
      try {
        artifact = await this.#store.load(handle);
      } catch (error) {
        throw new ToolError(
          "permission_denied",
          "The patch artifact handle is not owned by this workflow",
          { cause: error },
        );
      }
      if (
        !sameHandle(handle, artifact.handle) ||
        artifact.repositoryRoot !== repositoryRoot ||
        artifact.handle.baseRevision !== revision ||
        createHash("sha256").update(artifact.patch).digest("hex") !==
          artifact.handle.sha256 ||
        Buffer.byteLength(artifact.patch, "utf8") !== artifact.handle.byteLength
      ) {
        throw new ToolError(
          "permission_denied",
          "The patch artifact handle is not owned by this workflow",
        );
      }
      return artifact;
    }));
  }

  async preflightParent(
    repositoryRoot: string,
    signal: AbortSignal,
  ): Promise<GitPatchBase> {
    const root = await this.#canonicalRoot(repositoryRoot, signal);
    const status = await this.#git(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ], signal);
    if (status.stdout.length !== 0) {
      throw new ToolError(
        "permission_denied",
        "Team implementation requires a clean Git working tree",
      );
    }
    return { repositoryRoot: root, revision: await this.#revision(root, signal) };
  }

  async capture(
    inputLease: GitWorktreeLease,
    signal: AbortSignal,
  ): Promise<GitPatchArtifactHandle | null> {
    if (signal.aborted) throw cancelled("Patch capture was cancelled");
    let lease: GitWorktreeLease;
    try {
      lease = cloneFreeze(inputLease);
    } catch (error) {
      throw new ToolError("permission_denied", "The worktree lease is invalid", {
        cause: error,
      });
    }
    if (
      !ARTIFACT_ID.test(lease.id) ||
      !path.isAbsolute(lease.repositoryRoot) ||
      !path.isAbsolute(lease.worktreeRoot) ||
      !GIT_REVISION.test(lease.revision)
    ) {
      throw new ToolError("permission_denied", "The worktree lease is invalid");
    }
    await this.#leases?.assertActive(lease);
    const repositoryRoot = await this.#canonicalRoot(
      lease.repositoryRoot,
      signal,
    );
    if (repositoryRoot !== lease.repositoryRoot) {
      throw new ToolError("permission_denied", "The worktree lease is invalid");
    }
    const parentRevision = await this.#revision(repositoryRoot, signal);
    if (parentRevision !== lease.revision) {
      throw new ToolError(
        "permission_denied",
        "The parent Git revision changed during team implementation",
      );
    }
    const worktreeRoot = await this.#canonicalRoot(lease.worktreeRoot, signal);
    if (worktreeRoot !== lease.worktreeRoot) {
      throw new ToolError("permission_denied", "The worktree lease is invalid");
    }
    if (await this.#revision(worktreeRoot, signal) !== lease.revision) {
      throw new ToolError(
        "permission_denied",
        "The child worktree revision changed during team implementation",
      );
    }
    const statusResult = await this.#git(worktreeRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ], signal);
    if (statusResult.stdout.length === 0) return null;
    const status = parseStatus(statusResult.stdout);
    if (status.untracked.length > 0) {
      await this.#git(
        worktreeRoot,
        ["add", "--intent-to-add", "--", ...status.untracked],
        signal,
      );
    }
    const raw = parseRawDiff((await this.#git(
      worktreeRoot,
      ["diff", "--raw", "-z", "--full-index", "--no-renames", "HEAD", "--"],
      signal,
    )).stdout);
    const numstat = parseNumstat((await this.#git(
      worktreeRoot,
      ["diff", "--numstat", "-z", "--no-renames", "HEAD", "--"],
      signal,
    )).stdout);
    if (!samePaths(status.paths, raw) || !samePaths(raw, numstat)) {
      throw new ToolError(
        "permission_denied",
        "Git patch paths changed while the artifact was captured",
      );
    }
    const patchArguments = [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "HEAD",
      "--",
    ] as const;
    let patch: string;
    try {
      patch = (await this.#git(
        worktreeRoot,
        patchArguments,
        signal,
        MAX_PATCH_PROCESS_BYTES,
      )).stdout;
    } catch (error) {
      if (error instanceof ToolError && error.code === "output_limit") {
        throw new ToolError(
          "permission_denied",
          `Patch exceeds the ${MAX_PATCH_BYTES}-byte team artifact limit`,
        );
      }
      throw error;
    }
    const byteLength = Buffer.byteLength(patch, "utf8");
    if (byteLength === 0 || byteLength > MAX_PATCH_BYTES) {
      throw new ToolError(
        "permission_denied",
        `Patch exceeds the ${MAX_PATCH_BYTES}-byte team artifact limit`,
      );
    }
    const after = await fingerprintResult(worktreeRoot, raw, signal);
    const verifiedPatch = (await this.#git(
      worktreeRoot,
      patchArguments,
      signal,
      MAX_PATCH_PROCESS_BYTES,
    )).stdout;
    if (verifiedPatch !== patch) {
      throw new ToolError(
        "permission_denied",
        "The child workspace changed while the patch artifact was captured",
      );
    }
    const id = this.#createId();
    if (!ARTIFACT_ID.test(id)) {
      throw new ToolError("permission_denied", "The patch artifact ID is invalid");
    }
    const paths = Object.freeze([...raw]);
    const handle = Object.freeze({
      id,
      leaseId: lease.id,
      baseRevision: lease.revision,
      sha256: createHash("sha256").update(patch).digest("hex"),
      byteLength,
      paths,
    });
    await this.#store.put({ handle, repositoryRoot, patch, after });
    return handle;
  }

  async stage(input: GitPatchStageInput): Promise<GitPatchStageOutcome> {
    const { signal } = input;
    if (signal.aborted) throw cancelled("Patch staging was cancelled");
    if (this.#leases === undefined) {
      throw new ToolError(
        "tool_unavailable",
        "Patch staging requires an owned worktree lease authority",
      );
    }
    let lease: GitWorktreeLease;
    let handles: readonly GitPatchArtifactHandle[];
    try {
      lease = cloneFreeze(input.lease);
      handles = cloneFreeze(input.artifacts);
    } catch (error) {
      throw new ToolError("permission_denied", "The patch staging input is invalid", {
        cause: error,
      });
    }
    if (
      !ARTIFACT_ID.test(lease.id) ||
      !path.isAbsolute(lease.repositoryRoot) ||
      !path.isAbsolute(lease.worktreeRoot) ||
      !GIT_REVISION.test(lease.revision) ||
      handles.length === 0 ||
      handles.length > 8 ||
      new Set(handles.map((handle) => handle.id)).size !== handles.length
    ) {
      throw new ToolError("permission_denied", "The patch staging input is invalid");
    }

    await this.#leases.assertActive(lease);
    const repositoryRoot = await this.#canonicalRoot(lease.repositoryRoot, signal);
    const worktreeRoot = await this.#canonicalRoot(lease.worktreeRoot, signal);
    if (
      repositoryRoot !== lease.repositoryRoot ||
      worktreeRoot !== lease.worktreeRoot ||
      await this.#revision(repositoryRoot, signal) !== lease.revision ||
      await this.#revision(worktreeRoot, signal) !== lease.revision
    ) {
      throw new ToolError("permission_denied", "The staging worktree lease is invalid");
    }
    const initialStatus = await this.#git(worktreeRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ], signal);
    if (initialStatus.stdout.length !== 0) {
      throw new ToolError(
        "permission_denied",
        "Patch staging requires a clean owned worktree",
      );
    }

    const artifacts = await this.#loadOwnedArtifacts(
      handles,
      repositoryRoot,
      lease.revision,
    );
    const changed = new Set<string>();
    let actualPaths: string[] = [];
    for (const artifact of artifacts) {
      if (signal.aborted) throw cancelled("Patch staging was cancelled");
      const parsedPaths = parseNumstat((await this.#gitInput(
        worktreeRoot,
        ["apply", "--numstat", "-z", "-"],
        artifact.patch,
        signal,
      )).stdout);
      if (!samePaths(parsedPaths, artifact.handle.paths)) {
        throw new ToolError(
          "patch_files_mismatch",
          "A child patch no longer matches its captured paths",
        );
      }
      try {
        await this.#gitInput(
          worktreeRoot,
          ["apply", "--check", "--whitespace=nowarn", "-"],
          artifact.patch,
          signal,
        );
        await this.#gitInput(
          worktreeRoot,
          ["apply", "--whitespace=nowarn", "-"],
          artifact.patch,
          signal,
        );
      } catch (error) {
        if (error instanceof ToolError && error.code === "cancelled") throw error;
        throw new ToolError(
          "patch_failed",
          "A child patch conflicts with the staged team candidate",
          { cause: error },
        );
      }
      for (const file of artifact.handle.paths) changed.add(file);
      const status = await this.#git(worktreeRoot, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=none",
      ], signal);
      actualPaths = status.stdout.length === 0
        ? []
        : parseStatus(status.stdout).paths;
      const expectedPaths = [...changed].sort(compareStrings);
      if (!samePaths(actualPaths, expectedPaths)) {
        throw new ToolError(
          "patch_files_mismatch",
          "The staging workspace changed outside the team patch set",
        );
      }
      const after = await fingerprintResult(
        worktreeRoot,
        artifact.handle.paths,
        signal,
      );
      if (!isDeepStrictEqual(after, artifact.after)) {
        throw new ToolError(
          "patch_files_mismatch",
          "A staged child patch did not reproduce its captured result",
        );
      }
    }
    await this.#leases.assertActive(lease);
    return Object.freeze({ changedFiles: Object.freeze([...actualPaths]) });
  }

  async prepareCandidateApply(
    input: GitPatchCandidatePrepareInput,
  ): Promise<Checkpoint> {
    const { checkpoints, signal } = input;
    if (signal.aborted) throw cancelled("Candidate apply preparation was cancelled");
    let base: GitPatchBase;
    let artifact: GitPatchArtifactHandle;
    try {
      base = cloneFreeze(input.base);
      artifact = cloneFreeze(input.artifact);
    } catch (error) {
      throw new ToolError(
        "permission_denied",
        "The candidate apply preparation is invalid",
        { cause: error },
      );
    }
    if (
      !path.isAbsolute(base.repositoryRoot) ||
      !GIT_REVISION.test(base.revision) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(input.sessionId) ||
      !ARTIFACT_ID.test(input.operationId)
    ) {
      throw new ToolError(
        "permission_denied",
        "The candidate apply preparation is invalid",
      );
    }
    const repositoryRoot = await this.#canonicalRoot(base.repositoryRoot, signal);
    if (
      repositoryRoot !== base.repositoryRoot ||
      await this.#revision(repositoryRoot, signal) !== base.revision
    ) {
      throw new ToolError(
        "permission_denied",
        "The parent Git revision changed before candidate preparation",
      );
    }
    const status = await this.#git(repositoryRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ], signal);
    if (status.stdout.length !== 0) {
      throw new ToolError(
        "permission_denied",
        "Candidate preparation requires an unchanged clean parent workspace",
      );
    }
    await this.#loadOwnedArtifacts([artifact], repositoryRoot, base.revision);

    const checkpoint = await checkpoints.captureBefore(
      input.sessionId,
      input.operationId,
      repositoryRoot,
    );
    const verifiedStatus = await this.#git(repositoryRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ], signal);
    if (
      await this.#revision(repositoryRoot, signal) !== base.revision ||
      verifiedStatus.stdout.length !== 0
    ) {
      throw new ToolError(
        "permission_denied",
        "The parent workspace changed during candidate preparation",
      );
    }
    if (
      checkpoint.sessionId !== input.sessionId ||
      checkpoint.toolCallId !== input.operationId ||
      !ARTIFACT_ID.test(checkpoint.id) ||
      typeof checkpoint.before !== "object" ||
      checkpoint.before === null ||
      Array.isArray(checkpoint.before) ||
      checkpoint.after !== undefined
    ) {
      throw new ToolError(
        "checkpoint_corrupt",
        "Candidate preparation returned an invalid checkpoint",
      );
    }
    await checkpoints.assertPrepared(checkpoint, repositoryRoot);
    return cloneFreeze(checkpoint);
  }

  async applyCandidate(
    input: GitPatchCandidateApplyInput,
  ): Promise<GitPatchCandidateApplyOutcome> {
    const { checkpoints, signal } = input;
    if (signal.aborted) throw cancelled("Candidate apply was cancelled");
    let base: GitPatchBase;
    let artifact: GitPatchArtifactHandle;
    let checkpoint: Checkpoint;
    try {
      base = cloneFreeze(input.base);
      artifact = cloneFreeze(input.artifact);
      checkpoint = cloneFreeze(input.checkpoint);
    } catch (error) {
      throw new ToolError("permission_denied", "The candidate apply input is invalid", {
        cause: error,
      });
    }
    if (
      !path.isAbsolute(base.repositoryRoot) ||
      !GIT_REVISION.test(base.revision) ||
      !ARTIFACT_ID.test(checkpoint.id) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(checkpoint.sessionId) ||
      !ARTIFACT_ID.test(checkpoint.toolCallId) ||
      typeof checkpoint.before !== "object" ||
      checkpoint.before === null ||
      Array.isArray(checkpoint.before) ||
      checkpoint.after !== undefined
    ) {
      throw new ToolError("permission_denied", "The candidate apply input is invalid");
    }
    const repositoryRoot = await this.#canonicalRoot(base.repositoryRoot, signal);
    if (
      repositoryRoot !== base.repositoryRoot ||
      await this.#revision(repositoryRoot, signal) !== base.revision
    ) {
      throw new ToolError(
        "permission_denied",
        "The parent Git revision changed before candidate apply",
      );
    }
    const initialStatus = await this.#git(repositoryRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ], signal);
    if (initialStatus.stdout.length !== 0) {
      throw new ToolError(
        "permission_denied",
        "The parent workspace changed before candidate apply",
      );
    }
    const [owned] = await this.#loadOwnedArtifacts(
      [artifact],
      repositoryRoot,
      base.revision,
    );
    if (owned === undefined) {
      throw new ToolError("permission_denied", "The candidate artifact is unavailable");
    }
    const parsedPaths = parseNumstat((await this.#gitInput(
      repositoryRoot,
      ["apply", "--numstat", "-z", "-"],
      owned.patch,
      signal,
    )).stdout);
    if (!samePaths(parsedPaths, artifact.paths)) {
      throw new ToolError(
        "patch_files_mismatch",
        "The candidate patch no longer matches its captured paths",
      );
    }
    try {
      await this.#gitInput(
        repositoryRoot,
        ["apply", "--check", "--whitespace=nowarn", "-"],
        owned.patch,
        signal,
      );
    } catch (error) {
      if (error instanceof ToolError && error.code === "cancelled") throw error;
      throw new ToolError(
        "patch_failed",
        "The candidate patch no longer applies to the clean parent",
        { cause: error },
      );
    }
    await checkpoints.assertPrepared(checkpoint, repositoryRoot);
    await this.#gitInput(
      repositoryRoot,
      ["apply", "--whitespace=nowarn", "-"],
      owned.patch,
      signal,
    );
    const status = await this.#git(repositoryRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ], signal);
    const actualPaths = status.stdout.length === 0
      ? []
      : parseStatus(status.stdout).paths;
    if (!samePaths(actualPaths, artifact.paths)) {
      throw new ToolError(
        "patch_files_mismatch",
        "Candidate apply changed an unexpected parent path set",
      );
    }
    const after = await fingerprintResult(repositoryRoot, artifact.paths, signal);
    if (!isDeepStrictEqual(after, owned.after)) {
      throw new ToolError(
        "patch_files_mismatch",
        "Candidate apply did not reproduce its captured result",
      );
    }
    return Object.freeze({ changedFiles: Object.freeze([...actualPaths]) });
  }

  async completeCandidateApply(
    input: GitPatchCandidateCompleteInput,
  ): Promise<GitPatchCandidateCompleteOutcome> {
    const { checkpoints, signal } = input;
    if (signal.aborted) throw cancelled("Candidate completion was cancelled");
    let base: GitPatchBase;
    let artifact: GitPatchArtifactHandle;
    let checkpoint: Checkpoint;
    try {
      base = cloneFreeze(input.base);
      artifact = cloneFreeze(input.artifact);
      checkpoint = cloneFreeze(input.checkpoint);
    } catch (error) {
      throw new ToolError(
        "permission_denied",
        "The candidate completion input is invalid",
        { cause: error },
      );
    }
    if (!path.isAbsolute(base.repositoryRoot) ||
      !GIT_REVISION.test(base.revision) || !ARTIFACT_ID.test(artifact.id) ||
      !ARTIFACT_ID.test(checkpoint.id) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(checkpoint.sessionId) ||
      !ARTIFACT_ID.test(checkpoint.toolCallId) ||
      typeof checkpoint.before !== "object" || checkpoint.before === null ||
      Array.isArray(checkpoint.before) || checkpoint.after !== undefined) {
      throw new ToolError(
        "permission_denied",
        "The candidate completion input is invalid",
      );
    }
    const repositoryRoot = await this.#canonicalRoot(base.repositoryRoot, signal);
    if (repositoryRoot !== base.repositoryRoot ||
      await this.#revision(repositoryRoot, signal) !== base.revision) {
      throw new ToolError(
        "permission_denied",
        "The parent Git revision changed before candidate completion",
      );
    }
    const [owned] = await this.#loadOwnedArtifacts(
      [artifact],
      repositoryRoot,
      base.revision,
    );
    if (owned === undefined) {
      throw new ToolError("permission_denied", "The candidate artifact is unavailable");
    }
    const completed = await checkpoints.complete(checkpoint, repositoryRoot);
    if (completed.id !== checkpoint.id ||
      completed.sessionId !== checkpoint.sessionId ||
      completed.toolCallId !== checkpoint.toolCallId ||
      !isDeepStrictEqual(completed.before, checkpoint.before) ||
      completed.after === undefined) {
      throw new ToolError("checkpoint_corrupt", "Completed checkpoint changed identity");
    }
    const changedFiles = changedManifestPaths(completed.before, completed.after);
    if (!samePaths(changedFiles, artifact.paths) ||
      !manifestMatchesArtifact(completed.after, owned.after)) {
      throw new ToolError(
        "patch_files_mismatch",
        "Completed parent state does not match the reviewed candidate",
      );
    }
    return Object.freeze({
      checkpoint: cloneFreeze(completed),
      changedFiles: Object.freeze([...changedFiles]),
    });
  }

  async discard(handles: readonly GitPatchArtifactHandle[]): Promise<void> {
    await this.#store.remove(handles);
  }

  async integrate(
    input: GitPatchIntegrationInput,
  ): Promise<GitPatchIntegrationOutcome> {
    const { base, artifacts, signal } = input;
    if (signal.aborted) throw cancelled("Patch integration was cancelled");
    if (
      !path.isAbsolute(base.repositoryRoot) ||
      !GIT_REVISION.test(base.revision) ||
      artifacts.length === 0 ||
      artifacts.length > 8 ||
      !ARTIFACT_ID.test(input.operationId)
    ) {
      throw new ToolError("permission_denied", "The patch integration input is invalid");
    }
    const repositoryRoot = await this.#canonicalRoot(base.repositoryRoot, signal);
    if (repositoryRoot !== base.repositoryRoot) {
      throw new ToolError("permission_denied", "The patch integration base is invalid");
    }
    if (await this.#revision(repositoryRoot, signal) !== base.revision) {
      throw new ToolError(
        "permission_denied",
        "The parent Git revision changed before patch integration",
      );
    }
    const initialStatus = await this.#git(repositoryRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ], signal);
    if (initialStatus.stdout.length !== 0) {
      throw new ToolError(
        "permission_denied",
        "The parent workspace changed before patch integration",
      );
    }
    const uniqueIds = new Set(artifacts.map((artifact) => artifact.id));
    if (uniqueIds.size !== artifacts.length) {
      throw new ToolError("permission_denied", "Patch artifacts must be unique");
    }
    const owned = await this.#loadOwnedArtifacts(
      artifacts,
      repositoryRoot,
      base.revision,
    );

    const before = await input.checkpoints.captureBefore(
      input.sessionId,
      input.operationId,
      repositoryRoot,
    );
    await this.#store.remove(artifacts);
    const integrated: string[] = [];
    const changed = new Set<string>();
    let currentPaths: string[] = [];
    let currentArtifactId = owned[0]!.handle.id;
    let mutationMayHaveOccurred = false;
    try {
      for (const artifact of owned) {
        currentArtifactId = artifact.handle.id;
        if (signal.aborted) throw cancelled("Patch integration was cancelled");
        const parsedPaths = parseNumstat((await this.#gitInput(
          repositoryRoot,
          ["apply", "--numstat", "-z", "-"],
          artifact.patch,
          signal,
        )).stdout);
        if (!samePaths(parsedPaths, artifact.handle.paths)) {
          throw new ToolError(
            "patch_files_mismatch",
            "A child patch no longer matches its captured paths",
          );
        }
        await this.#gitInput(
          repositoryRoot,
          ["apply", "--check", "--whitespace=nowarn", "-"],
          artifact.patch,
          signal,
        );
        mutationMayHaveOccurred = true;
        await this.#gitInput(
          repositoryRoot,
          ["apply", "--whitespace=nowarn", "-"],
          artifact.patch,
          signal,
        );
        integrated.push(artifact.handle.id);
        for (const file of artifact.handle.paths) changed.add(file);
        const status = await this.#git(repositoryRoot, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=none",
        ], signal);
        const actualPaths = status.stdout.length === 0
          ? []
          : parseStatus(status.stdout).paths;
        if (actualPaths.some((file) => !changed.has(file))) {
          throw new ToolError(
            "patch_files_mismatch",
            "The parent workspace changed outside the team patch set",
          );
        }
        currentPaths = actualPaths;
      }
      if (currentPaths.length === 0) {
        throw new ToolError(
          "patch_files_mismatch",
          "Team patches produced no net workspace change",
        );
      }
      const completed = await input.checkpoints.captureAfter(before, repositoryRoot);
      return {
        ok: true,
        artifactIds: [...integrated],
        changedFiles: [...currentPaths],
        checkpointId: completed.id,
      };
    } catch (error) {
      const failureCode = error instanceof ToolError && error.code === "cancelled"
        ? "cancelled" as const
        : "patch_failed" as const;
      const message = failureCode === "cancelled"
        ? "Patch integration was cancelled"
        : "A child patch conflicted with earlier team changes";
      let completed;
      try {
        completed = await input.checkpoints.captureAfter(before, repositoryRoot);
      } catch (checkpointError) {
        throw new ToolError(
          "checkpoint_conflict",
          "Patch integration checkpoint recovery failed",
          { cause: checkpointError },
        );
      }
      if (!mutationMayHaveOccurred) {
        return {
          ok: false,
          code: failureCode,
          message,
          artifactId: currentArtifactId,
          integratedArtifactIds: [],
          rolledBack: false,
          restored: [],
          deleted: [],
        };
      }
      try {
        const rollback = await input.checkpoints.restore(
          completed,
          repositoryRoot,
        );
        const status = await this.#git(repositoryRoot, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignore-submodules=none",
        ], new AbortController().signal);
        if (status.stdout.length !== 0) {
          throw new ToolError(
            "checkpoint_conflict",
            "Patch rollback left an unexpected workspace change",
          );
        }
        return {
          ok: false,
          code: failureCode,
          message,
          artifactId: currentArtifactId,
          integratedArtifactIds: [...integrated],
          rolledBack: true,
          restored: [...rollback.restored],
          deleted: [...rollback.deleted],
        };
      } catch (rollbackError) {
        throw new ToolError(
          "checkpoint_conflict",
          "Patch integration rollback failed; inspect the workspace before continuing",
          { cause: rollbackError },
        );
      }
    }
  }
}
