import {
  parseCompanyAmendment,
  type CompanyAmendmentV1,
} from "@recurs/contracts";

import { PrivateImmutableJsonStore } from "./private-state-store.js";

export class FileCompanyAmendmentStore {
  readonly #store: PrivateImmutableJsonStore<CompanyAmendmentV1>;

  constructor(readonly directory: string) {
    this.#store = new PrivateImmutableJsonStore(directory, {
      label: "Company amendment",
      maximumBytes: 512 * 1024,
      maximumRecords: 2_048,
      parse: parseCompanyAmendment,
      idOf: (amendment) => amendment.id,
    });
  }

  create(amendment: CompanyAmendmentV1, signal?: AbortSignal): Promise<void> {
    return this.#store.create(amendment, signal);
  }

  load(id: string, signal?: AbortSignal): Promise<CompanyAmendmentV1> {
    return this.#store.load(id, signal);
  }

  async list(
    companyId?: string,
    signal?: AbortSignal,
  ): Promise<readonly CompanyAmendmentV1[]> {
    const amendments = await this.#store.list(signal);
    return Object.freeze(amendments.filter((amendment) =>
      companyId === undefined || amendment.companyId === companyId
    ));
  }
}
