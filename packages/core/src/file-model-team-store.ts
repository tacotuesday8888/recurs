import {
  parseModelTeamEvidence,
  parseModelTeamSelectionEvidence,
  type ModelTeamEvaluation,
  type ModelTeamSelection,
} from "@recurs/contracts";

import { PrivateImmutableJsonStore } from "./private-state-store.js";

export class FileModelTeamEvaluationStore {
  readonly #store: PrivateImmutableJsonStore<ModelTeamEvaluation>;

  constructor(readonly directory: string) {
    this.#store = new PrivateImmutableJsonStore(directory, {
      label: "Model-team evaluation",
      maximumBytes: 2 * 1024 * 1024,
      maximumRecords: 4_096,
      parse: parseModelTeamEvidence,
      idOf: (evaluation) => evaluation.id,
    });
  }

  create(
    evaluation: ModelTeamEvaluation,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#store.create(evaluation, signal);
  }

  list(signal?: AbortSignal): Promise<readonly ModelTeamEvaluation[]> {
    return this.#store.list(signal);
  }
}

export class FileModelTeamSelectionStore {
  readonly #store: PrivateImmutableJsonStore<ModelTeamSelection>;

  constructor(readonly directory: string) {
    this.#store = new PrivateImmutableJsonStore(directory, {
      label: "Model-team selection",
      maximumBytes: 512 * 1024,
      maximumRecords: 1_024,
      parse: parseModelTeamSelectionEvidence,
      idOf: (selection) => selection.id,
    });
  }

  create(selection: ModelTeamSelection, signal?: AbortSignal): Promise<void> {
    return this.#store.create(selection, signal);
  }

  async latest(signal?: AbortSignal): Promise<ModelTeamSelection | null> {
    return [...await this.#store.list(signal)].sort((left, right) =>
      left.selectedAt.localeCompare(right.selectedAt) ||
      left.id.localeCompare(right.id)
    ).at(-1) ?? null;
  }
}
