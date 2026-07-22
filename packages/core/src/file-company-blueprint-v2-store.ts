import {
  parseCompanyBlueprintV2,
  type CompanyBlueprintV2,
} from "@recurs/contracts";

import { PrivateImmutableJsonStore } from "./private-state-store.js";

export class FileCompanyBlueprintV2Store {
  readonly #store: PrivateImmutableJsonStore<CompanyBlueprintV2>;

  constructor(readonly directory: string) {
    this.#store = new PrivateImmutableJsonStore(directory, {
      label: "Company V2 blueprint",
      maximumBytes: 512 * 1024,
      maximumRecords: 2_048,
      parse: parseCompanyBlueprintV2,
      idOf: (blueprint) => blueprint.id,
    });
  }

  create(blueprint: CompanyBlueprintV2, signal?: AbortSignal): Promise<void> {
    return this.#store.create(blueprint, signal);
  }

  load(id: string, signal?: AbortSignal): Promise<CompanyBlueprintV2> {
    return this.#store.load(id, signal);
  }

  list(signal?: AbortSignal): Promise<readonly CompanyBlueprintV2[]> {
    return this.#store.list(signal);
  }
}
