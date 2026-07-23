import {
  parseModelTeamEvaluation,
  parseModelTeamSelection,
  type ModelTeamEvaluationV1,
  type ModelTeamSelectionV1,
} from "@recurs/contracts";

import { PrivateImmutableJsonStore } from "./private-state-store.js";

export class FileModelTeamEvaluationStore {
  readonly #store: PrivateImmutableJsonStore<ModelTeamEvaluationV1>;

  constructor(readonly directory: string) {
    this.#store = new PrivateImmutableJsonStore(directory, {
      label: "Model-team evaluation",
      maximumBytes: 2 * 1024 * 1024,
      maximumRecords: 4_096,
      parse: parseModelTeamEvaluation,
      idOf: (evaluation) => evaluation.id,
    });
  }

  create(
    evaluation: ModelTeamEvaluationV1,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#store.create(evaluation, signal);
  }

  list(signal?: AbortSignal): Promise<readonly ModelTeamEvaluationV1[]> {
    return this.#store.list(signal);
  }
}

export class FileModelTeamSelectionStore {
  readonly #store: PrivateImmutableJsonStore<ModelTeamSelectionV1>;

  constructor(readonly directory: string) {
    this.#store = new PrivateImmutableJsonStore(directory, {
      label: "Model-team selection",
      maximumBytes: 512 * 1024,
      maximumRecords: 1_024,
      parse: parseModelTeamSelection,
      idOf: (selection) => selection.id,
    });
  }

  create(selection: ModelTeamSelectionV1, signal?: AbortSignal): Promise<void> {
    return this.#store.create(selection, signal);
  }

  async latest(signal?: AbortSignal): Promise<ModelTeamSelectionV1 | null> {
    return [...await this.#store.list(signal)].sort((left, right) =>
      left.selectedAt.localeCompare(right.selectedAt) ||
      left.id.localeCompare(right.id)
    ).at(-1) ?? null;
  }
}
