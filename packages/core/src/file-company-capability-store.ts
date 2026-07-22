import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  parseCompanyCapabilityBindingSet,
  type CompanyCapabilityBindingSetV1,
} from "@recurs/contracts";

import {
  CompanyStateStoreError,
  PrivateImmutableJsonStore,
  withPrivateStateMutationLock,
} from "./private-state-store.js";

function companyDigest(companyId: string): string {
  return createHash("sha256").update(companyId).digest("hex").slice(0, 32);
}

function recordId(companyId: string, revision: number): string {
  return `capabilities-${companyDigest(companyId)}-r${revision}`;
}

function lockId(companyId: string): string {
  return `capabilities-${companyDigest(companyId)}`;
}

function validateNext(
  previous: CompanyCapabilityBindingSetV1,
  next: CompanyCapabilityBindingSetV1,
): void {
  if (next.revision !== previous.revision + 1) {
    throw new CompanyStateStoreError(
      "sequence_conflict",
      "Company capability binding revision is not the next revision",
    );
  }
  const sameBlueprint = next.blueprintRevision === previous.blueprintRevision &&
    next.blueprintId === previous.blueprintId;
  const nextBlueprint = next.blueprintRevision > previous.blueprintRevision &&
    next.blueprintId !== previous.blueprintId;
  if ((!sameBlueprint && !nextBlueprint) || next.updatedAt < previous.updatedAt) {
    throw new CompanyStateStoreError(
      "conflict",
      "Company capability binding history is stale or has invalid blueprint lineage",
    );
  }
}

export class FileCompanyCapabilityStore {
  readonly #store: PrivateImmutableJsonStore<CompanyCapabilityBindingSetV1>;

  constructor(readonly directory: string) {
    this.#store = new PrivateImmutableJsonStore(directory, {
      label: "Company capability binding set",
      maximumBytes: 512 * 1024,
      maximumRecords: 2_048,
      parse: parseCompanyCapabilityBindingSet,
      idOf: (set) => recordId(set.companyId, set.revision),
    });
  }

  create(
    input: CompanyCapabilityBindingSetV1,
    signal?: AbortSignal,
  ): Promise<void> {
    const value = parseCompanyCapabilityBindingSet(input);
    return withPrivateStateMutationLock(
      path.join(this.directory, ".authority"),
      lockId(value.companyId),
      async () => {
        const latest = await this.latest(value.companyId, signal);
        if (latest === null) {
          if (value.revision !== 1) {
            throw new CompanyStateStoreError(
              "sequence_conflict",
              "The first company capability binding revision must be 1",
            );
          }
        } else if (value.revision === latest.revision) {
          if (isDeepStrictEqual(value, latest)) return;
          throw new CompanyStateStoreError(
            "conflict",
            "Company capability binding revision already contains different content",
          );
        } else {
          validateNext(latest, value);
        }
        await this.#store.create(value, signal);
      },
      signal,
    );
  }

  load(
    companyId: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<CompanyCapabilityBindingSetV1> {
    return this.#store.load(recordId(companyId, revision), signal);
  }

  async list(
    companyId?: string,
    signal?: AbortSignal,
  ): Promise<readonly CompanyCapabilityBindingSetV1[]> {
    const values = await this.#store.list(signal);
    return Object.freeze(values.filter((value) =>
      companyId === undefined || value.companyId === companyId
    ).sort((left, right) => left.revision - right.revision));
  }

  async latest(
    companyId: string,
    signal?: AbortSignal,
  ): Promise<CompanyCapabilityBindingSetV1 | null> {
    return (await this.list(companyId, signal)).at(-1) ?? null;
  }
}
