import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  parseTeamControlPolicyV1,
  type TeamControlPolicyV1,
} from "@recurs/contracts";

import {
  CompanyStateStoreError,
  PrivateImmutableJsonStore,
  withPrivateStateMutationLock,
} from "./private-state-store.js";

interface StoredTeamControlPolicy {
  readonly workspaceDigest: string;
  readonly policy: TeamControlPolicyV1;
}

const DIGEST = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder();

function workspaceDigest(workspaceIdentity: string): string {
  if (workspaceIdentity.length === 0 ||
    encoder.encode(workspaceIdentity).byteLength > 4_096) {
    throw new CompanyStateStoreError(
      "invalid_id",
      "Team-control workspace identity is invalid",
    );
  }
  return createHash("sha256").update(workspaceIdentity).digest("hex");
}

function recordId(digest: string, revision: number): string {
  return `team-control-${digest}-r${revision}`;
}

function parseStored(value: unknown): StoredTeamControlPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Stored team-control policy must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "policy,workspaceDigest" ||
    typeof record.workspaceDigest !== "string" ||
    !DIGEST.test(record.workspaceDigest)) {
    throw new TypeError("Stored team-control policy identity is invalid");
  }
  return Object.freeze({
    workspaceDigest: record.workspaceDigest,
    policy: parseTeamControlPolicyV1(record.policy),
  });
}

export class FileTeamControlPolicyStore {
  readonly #store: PrivateImmutableJsonStore<StoredTeamControlPolicy>;

  constructor(readonly directory: string) {
    this.#store = new PrivateImmutableJsonStore(directory, {
      label: "Team-control policy",
      maximumBytes: 16 * 1024,
      maximumRecords: 4_096,
      parse: parseStored,
      idOf: (record) =>
        recordId(record.workspaceDigest, record.policy.revision),
    });
  }

  async publish(
    workspaceIdentity: string,
    input: TeamControlPolicyV1,
    expectedRevision: number | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const digest = workspaceDigest(workspaceIdentity);
    const policy = parseTeamControlPolicyV1(input);
    await withPrivateStateMutationLock(
      path.join(this.directory, ".authority"),
      `team-control-${digest}`,
      async () => {
        const latest = await this.#latest(digest, signal);
        if (latest === null) {
          if (expectedRevision !== null || policy.revision !== 1) {
            throw new CompanyStateStoreError(
              "sequence_conflict",
              "The first team-control policy revision must be 1",
            );
          }
        } else if (policy.revision === latest.revision) {
          if (isDeepStrictEqual(policy, latest)) return;
          throw new CompanyStateStoreError(
            "conflict",
            "Team-control policy revision already contains different content",
          );
        } else if (expectedRevision !== latest.revision ||
          policy.revision !== latest.revision + 1) {
          throw new CompanyStateStoreError(
            "sequence_conflict",
            "Team-control policy revision is stale or out of sequence",
          );
        }
        await this.#store.create({ workspaceDigest: digest, policy }, signal);
      },
      signal,
    );
  }

  async load(
    workspaceIdentity: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<TeamControlPolicyV1> {
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new CompanyStateStoreError(
        "invalid_id",
        "Team-control policy revision is invalid",
      );
    }
    const digest = workspaceDigest(workspaceIdentity);
    return (await this.#store.load(recordId(digest, revision), signal)).policy;
  }

  async #latest(
    digest: string,
    signal?: AbortSignal,
  ): Promise<TeamControlPolicyV1 | null> {
    const records = await this.#store.list(signal);
    return records
      .filter((record) => record.workspaceDigest === digest)
      .map((record) => record.policy)
      .sort((left, right) => left.revision - right.revision)
      .at(-1) ?? null;
  }

  latest(
    workspaceIdentity: string,
    signal?: AbortSignal,
  ): Promise<TeamControlPolicyV1 | null> {
    return this.#latest(workspaceDigest(workspaceIdentity), signal);
  }
}
