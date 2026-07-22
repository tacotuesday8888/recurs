import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  parseCompanyAmendment,
  type CompanyAmendmentV1,
} from "@recurs/contracts";

import {
  CompanyStateStoreError,
  PrivateImmutableJsonStore,
} from "./private-state-store.js";

function proposedProjection(
  amendment: CompanyAmendmentV1,
): CompanyAmendmentV1 {
  return parseCompanyAmendment({
    ...amendment,
    state: "proposed",
    decidedAt: null,
    resultingBlueprintId: null,
    decisionReason: null,
  });
}

function validateDecision(
  proposal: CompanyAmendmentV1,
  decision: CompanyAmendmentV1,
  code: "conflict" | "corrupt",
): void {
  if (proposal.state !== "proposed" || decision.state === "proposed" ||
    !isDeepStrictEqual(proposal, proposedProjection(decision)) ||
    (decision.state === "approved" &&
      decision.resultingBlueprintId !== proposal.proposedBlueprint.id) ||
    new Date(decision.decidedAt!).valueOf() <
      new Date(proposal.createdAt).valueOf()) {
    throw new CompanyStateStoreError(
      code,
      code === "corrupt"
        ? "Company amendment decision history is invalid"
        : "Company amendment decision does not match its proposal",
    );
  }
}

export class FileCompanyAmendmentStore {
  readonly #proposals: PrivateImmutableJsonStore<CompanyAmendmentV1>;
  readonly #decisions: PrivateImmutableJsonStore<CompanyAmendmentV1>;

  constructor(readonly directory: string) {
    this.#proposals = new PrivateImmutableJsonStore(directory, {
      label: "Company amendment proposal",
      maximumBytes: 512 * 1024,
      maximumRecords: 2_048,
      parse: parseCompanyAmendment,
      idOf: (amendment) => amendment.id,
    });
    this.#decisions = new PrivateImmutableJsonStore(
      path.join(directory, ".decisions"),
      {
        label: "Company amendment decision",
        maximumBytes: 512 * 1024,
        maximumRecords: 2_048,
        parse: parseCompanyAmendment,
        idOf: (amendment) => amendment.id,
      },
    );
  }

  create(amendment: CompanyAmendmentV1, signal?: AbortSignal): Promise<void> {
    const proposal = parseCompanyAmendment(amendment);
    if (proposal.state !== "proposed") {
      throw new CompanyStateStoreError(
        "conflict",
        "A company amendment must be created as a proposal",
      );
    }
    return this.#proposals.create(proposal, signal);
  }

  async decide(
    amendment: CompanyAmendmentV1,
    signal?: AbortSignal,
  ): Promise<void> {
    const decision = parseCompanyAmendment(amendment);
    const proposal = await this.#proposals.load(decision.id, signal);
    validateDecision(proposal, decision, "conflict");
    await this.#decisions.create(decision, signal);
  }

  async load(id: string, signal?: AbortSignal): Promise<CompanyAmendmentV1> {
    const proposal = await this.#proposals.load(id, signal);
    try {
      const decision = await this.#decisions.load(id, signal);
      validateDecision(proposal, decision, "corrupt");
      return decision;
    } catch (error) {
      if (error instanceof CompanyStateStoreError && error.code === "not_found") {
        return proposal;
      }
      throw error;
    }
  }

  async list(
    companyId?: string,
    signal?: AbortSignal,
  ): Promise<readonly CompanyAmendmentV1[]> {
    const [proposals, decisions] = await Promise.all([
      this.#proposals.list(signal),
      this.#decisions.list(signal),
    ]);
    const proposalById = new Map(proposals.map((item) => [item.id, item] as const));
    const decisionById = new Map(decisions.map((item) => [item.id, item] as const));
    for (const decision of decisions) {
      const proposal = proposalById.get(decision.id);
      if (proposal === undefined) {
        throw new CompanyStateStoreError(
          "corrupt",
          "Company amendment decision has no proposal",
        );
      }
      validateDecision(proposal, decision, "corrupt");
    }
    const amendments = proposals.map((proposal) =>
      decisionById.get(proposal.id) ?? proposal
    );
    return Object.freeze(amendments.filter((amendment) =>
      companyId === undefined || amendment.companyId === companyId
    ));
  }
}
