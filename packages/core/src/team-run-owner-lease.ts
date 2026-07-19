import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  acquireSessionLock,
  type AcquiredSessionLock,
} from "./session-mutation-lease.js";
import { SessionStoreError } from "./session-store-error.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export interface TeamRunOwnerLeaseManagerOptions {
  readonly rootDirectory: string;
}

export interface TeamRunOwnerLease {
  readonly runId: string;
  readonly parentSessionId: string;
  readonly ownerId: string;
  readonly fencingToken: number;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

export type TeamRunOwnerLeaseResult =
  | { readonly status: "acquired"; readonly lease: TeamRunOwnerLease }
  | { readonly status: "busy" };

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : null;
}

function invalidId(kind: "run" | "parent session", id: string): never {
  throw new SessionStoreError(
    "invalid_session_id",
    `Invalid team ${kind} id: ${id}`,
  );
}

function validateId(kind: "run" | "parent session", id: string): void {
  if (!SAFE_ID.test(id)) invalidId(kind, id);
}

async function requirePrivateDirectory(directory: string): Promise<void> {
  let details;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    details = await lstat(directory);
  }
  if (details.isSymbolicLink() || !details.isDirectory() ||
    (details.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new SessionStoreError(
      "corrupt_log",
      `Team run owner storage must be a private directory: ${directory}`,
    );
  }
}

function busy(error: unknown): boolean {
  return error instanceof SessionStoreError && error.code === "session_busy";
}

async function releaseBoth(
  run: AcquiredSessionLock,
  parent: AcquiredSessionLock,
): Promise<void> {
  const results = await Promise.allSettled([run.release(), parent.release()]);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure !== undefined) throw failure.reason;
}

export class TeamRunOwnerLeaseManager {
  readonly directory: string;
  readonly #parentDirectory: string;
  readonly #runDirectory: string;

  constructor(options: TeamRunOwnerLeaseManagerOptions) {
    this.directory = path.join(
      path.resolve(options.rootDirectory),
      ".team-run-owner-leases",
    );
    this.#parentDirectory = path.join(this.directory, "parents");
    this.#runDirectory = path.join(this.directory, "runs");
  }

  async #prepare(): Promise<void> {
    await requirePrivateDirectory(this.directory);
    for (const directory of [this.#parentDirectory, this.#runDirectory]) {
      await requirePrivateDirectory(directory);
      await requirePrivateDirectory(path.join(directory, ".locks"));
      await requirePrivateDirectory(path.join(directory, ".fences"));
    }
  }

  async tryAcquire(
    runId: string,
    parentSessionId: string,
  ): Promise<TeamRunOwnerLeaseResult> {
    validateId("run", runId);
    validateId("parent session", parentSessionId);
    await this.#prepare();

    let parent: AcquiredSessionLock;
    try {
      parent = await acquireSessionLock(this.#parentDirectory, parentSessionId);
    } catch (error) {
      if (busy(error)) return { status: "busy" };
      throw error;
    }

    let run: AcquiredSessionLock;
    try {
      run = await acquireSessionLock(this.#runDirectory, runId);
    } catch (error) {
      await parent.release();
      if (busy(error)) return { status: "busy" };
      throw error;
    }

    let releasePromise: Promise<void> | undefined;
    const released = (): SessionStoreError => new SessionStoreError(
      "session_busy",
      `Team run ${runId} ownership was released`,
    );
    return {
      status: "acquired",
      lease: {
        runId,
        parentSessionId,
        ownerId: run.ownerId,
        fencingToken: run.fencingToken,
        async assertOwned() {
          if (releasePromise !== undefined) throw released();
          await parent.assertOwned();
          await run.assertOwned();
        },
        release() {
          releasePromise ??= releaseBoth(run, parent);
          return releasePromise;
        },
      },
    };
  }
}
