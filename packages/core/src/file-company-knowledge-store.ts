import { createHash } from "node:crypto";

import {
  parseCompanyKnowledge,
  type CompanyKnowledgeV1,
} from "@recurs/contracts";

import { PrivateImmutableJsonStore } from "./private-state-store.js";

function recordId(companyId: string, revision: number): string {
  const digest = createHash("sha256").update(companyId).digest("hex").slice(0, 32);
  return `knowledge-${digest}-r${revision}`;
}

export class FileCompanyKnowledgeStore {
  readonly #store: PrivateImmutableJsonStore<CompanyKnowledgeV1>;

  constructor(readonly directory: string) {
    this.#store = new PrivateImmutableJsonStore(directory, {
      label: "Company knowledge",
      maximumBytes: 4 * 1024 * 1024,
      maximumRecords: 2_048,
      parse: parseCompanyKnowledge,
      idOf: (knowledge) => recordId(knowledge.companyId, knowledge.revision),
    });
  }

  create(knowledge: CompanyKnowledgeV1, signal?: AbortSignal): Promise<void> {
    return this.#store.create(knowledge, signal);
  }

  load(
    companyId: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<CompanyKnowledgeV1> {
    return this.#store.load(recordId(companyId, revision), signal);
  }

  async list(
    companyId?: string,
    signal?: AbortSignal,
  ): Promise<readonly CompanyKnowledgeV1[]> {
    const values = await this.#store.list(signal);
    return Object.freeze(values
      .filter((value) => companyId === undefined || value.companyId === companyId)
      .sort((left, right) => left.revision - right.revision));
  }

  async latest(
    companyId: string,
    signal?: AbortSignal,
  ): Promise<CompanyKnowledgeV1 | null> {
    return (await this.list(companyId, signal)).at(-1) ?? null;
  }
}
