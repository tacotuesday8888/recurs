import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import {
  parseCompanyAmendment,
  parseCompanyBlueprintBindingV2,
  parseCompanyBlueprintV2,
  type CompanyAmendmentV1,
  type CompanyBlueprintBindingV2,
  type CompanyBlueprintV2,
} from "@recurs/contracts";

import { approveCompanyBlueprintV2 } from "./company-blueprint-v2.js";
import { containsSecretLikeContent } from "./company-learning.js";
import type { FileCompanyAmendmentStore } from "./file-company-amendment-store.js";
import type { FileCompanyBlueprintV2Store } from "./file-company-blueprint-v2-store.js";
import { withPrivateStateMutationLock } from "./private-state-store.js";

export type CompanyAmendmentErrorCode =
  | "invalid_input"
  | "unsafe_content"
  | "authority_mismatch"
  | "stale_base"
  | "already_decided"
  | "corrupt_state";

export class CompanyAmendmentError extends Error {
  constructor(
    public readonly code: CompanyAmendmentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CompanyAmendmentError";
  }
}

export interface CompanyAmendmentServiceDependencies {
  readonly blueprints: Pick<
    FileCompanyBlueprintV2Store,
    "create" | "load" | "list"
  >;
  readonly amendments: Pick<
    FileCompanyAmendmentStore,
    "directory" | "create" | "decide" | "load" | "list"
  >;
}

export interface CompanyAmendmentProposalInput {
  readonly amendmentId: string;
  readonly company: CompanyBlueprintBindingV2;
  readonly proposedBlueprint: CompanyBlueprintV2;
  readonly reason: string;
  readonly at: string;
  readonly signal?: AbortSignal;
}

export interface CompanyAmendmentDecisionInput {
  readonly amendmentId: string;
  readonly company: CompanyBlueprintBindingV2;
  readonly at: string;
  readonly decisionReason: string;
  readonly signal?: AbortSignal;
}

function approvedLineage(
  blueprints: readonly CompanyBlueprintV2[],
  companyId: string,
): readonly CompanyBlueprintV2[] {
  const approved = blueprints.filter((blueprint) =>
    blueprint.companyId === companyId && blueprint.state === "approved"
  ).sort((left, right) => left.revision - right.revision);
  if (approved.length === 0) {
    throw new CompanyAmendmentError(
      "corrupt_state",
      "The company has no approved blueprint authority",
    );
  }
  if (approved[0]!.revision !== 1 || approved[0]!.previousBlueprintId !== null) {
    throw new CompanyAmendmentError(
      "corrupt_state",
      "The company approved-blueprint lineage has no valid root",
    );
  }
  for (let index = 1; index < approved.length; index += 1) {
    if (approved[index - 1]!.revision === approved[index]!.revision) {
      throw new CompanyAmendmentError(
        "corrupt_state",
        "The company has conflicting approved blueprint revisions",
      );
    }
    if (approved[index]!.revision !== approved[index - 1]!.revision + 1 ||
      approved[index]!.previousBlueprintId !== approved[index - 1]!.id) {
      throw new CompanyAmendmentError(
        "corrupt_state",
        "The company approved-blueprint lineage is invalid",
      );
    }
  }
  return approved;
}

function latestApproved(
  blueprints: readonly CompanyBlueprintV2[],
  companyId: string,
): CompanyBlueprintV2 {
  return approvedLineage(blueprints, companyId).at(-1)!;
}

function bindingMatches(
  binding: CompanyBlueprintBindingV2,
  blueprint: CompanyBlueprintV2,
): boolean {
  return blueprint.id === binding.blueprintId &&
    blueprint.revision === binding.blueprintRevision &&
    blueprint.authorityAnchors.rootRoleId === binding.roleId;
}

function amendmentMatchesBinding(
  amendment: CompanyAmendmentV1,
  binding: CompanyBlueprintBindingV2,
): boolean {
  return amendment.baseBlueprintId === binding.blueprintId &&
    amendment.baseBlueprintRevision === binding.blueprintRevision;
}

function approvedProposalMatches(
  approved: CompanyBlueprintV2,
  proposal: CompanyBlueprintV2,
): boolean {
  return approved.state === "approved" && approved.approvedAt !== null &&
    isDeepStrictEqual(
      approved,
      approveCompanyBlueprintV2(proposal, approved.approvedAt),
    );
}

function amendmentLockDirectory(directory: string): string {
  return path.join(directory, ".authority");
}

function amendmentLockId(companyId: string): string {
  const encoded = Buffer.from(companyId, "utf8").toString("hex").slice(0, 96);
  return `company_${encoded}`;
}

export class CompanyAmendmentService {
  constructor(readonly dependencies: CompanyAmendmentServiceDependencies) {}

  async #authority(
    input: CompanyBlueprintBindingV2,
    signal?: AbortSignal,
  ): Promise<CompanyBlueprintV2> {
    let binding: CompanyBlueprintBindingV2;
    try {
      binding = parseCompanyBlueprintBindingV2(input);
    } catch (error) {
      throw new CompanyAmendmentError(
        "invalid_input",
        "Company amendment authority is invalid",
        { cause: error },
      );
    }
    const blueprint = await this.dependencies.blueprints.load(
      binding.blueprintId,
      signal,
    );
    if (blueprint.state !== "approved" || !bindingMatches(binding, blueprint)) {
      throw new CompanyAmendmentError(
        "authority_mismatch",
        "Company amendment authority does not match the approved root",
      );
    }
    return blueprint;
  }

  async latest(input: {
    readonly company: CompanyBlueprintBindingV2;
    readonly signal?: AbortSignal;
  }): Promise<CompanyBlueprintV2> {
    const base = await this.#authority(input.company, input.signal);
    return await withPrivateStateMutationLock(
      amendmentLockDirectory(this.dependencies.amendments.directory),
      amendmentLockId(base.companyId),
      async () => {
        const freshBase = await this.#authority(input.company, input.signal);
        const lineage = approvedLineage(
          await this.dependencies.blueprints.list(input.signal),
          freshBase.companyId,
        );
        const baseIndex = lineage.findIndex((item) => item.id === freshBase.id);
        if (baseIndex < 0) {
          throw new CompanyAmendmentError(
            "corrupt_state",
            "The active company revision is missing from its approved lineage",
          );
        }
        const amendments = await this.dependencies.amendments.list(
          freshBase.companyId,
          input.signal,
        );
        let effective = freshBase;
        let effectiveIndex = baseIndex;
        for (const [offset, candidate] of lineage.slice(baseIndex + 1).entries()) {
          const decisions = amendments.filter((amendment) =>
            amendment.state === "approved" &&
            amendment.baseBlueprintId === effective.id &&
            amendment.baseBlueprintRevision === effective.revision &&
            amendment.resultingBlueprintId === candidate.id
          );
          if (decisions.length === 0) break;
          if (decisions.length !== 1) {
            throw new CompanyAmendmentError(
              "corrupt_state",
              "The company blueprint revision has conflicting amendment authority",
            );
          }
          effective = candidate;
          effectiveIndex = baseIndex + offset + 1;
        }
        if (effective.revision < lineage.at(-1)!.revision &&
          lineage.slice(effectiveIndex + 1).some((candidate) =>
            amendments.some((amendment) =>
              amendment.state === "approved" &&
              amendment.resultingBlueprintId === candidate.id
            )
          )) {
          throw new CompanyAmendmentError(
            "corrupt_state",
            "The company amendment authority has a revision gap",
          );
        }
        return effective;
      },
      input.signal,
    );
  }

  async propose(
    input: CompanyAmendmentProposalInput,
  ): Promise<CompanyAmendmentV1> {
    if (containsSecretLikeContent(input.reason) ||
      containsSecretLikeContent(input.proposedBlueprint)) {
      throw new CompanyAmendmentError(
        "unsafe_content",
        "Company amendment contains secret-like content",
      );
    }
    const base = await this.#authority(input.company, input.signal);
    return await withPrivateStateMutationLock(
      amendmentLockDirectory(this.dependencies.amendments.directory),
      amendmentLockId(base.companyId),
      async () => {
        const freshBase = await this.#authority(input.company, input.signal);
        const latest = latestApproved(
          await this.dependencies.blueprints.list(input.signal),
          freshBase.companyId,
        );
        if (latest.id !== freshBase.id || latest.revision !== freshBase.revision) {
          throw new CompanyAmendmentError(
            "stale_base",
            "The company amendment base revision is stale",
          );
        }
        let amendment: CompanyAmendmentV1;
        try {
          amendment = parseCompanyAmendment({
            id: input.amendmentId,
            version: 1,
            companyId: freshBase.companyId,
            baseBlueprintId: freshBase.id,
            baseBlueprintRevision: freshBase.revision,
            state: "proposed",
            createdAt: input.at,
            decidedAt: null,
            reason: input.reason,
            proposedBlueprint: parseCompanyBlueprintV2(input.proposedBlueprint),
            resultingBlueprintId: null,
            decisionReason: null,
          });
        } catch (error) {
          throw new CompanyAmendmentError(
            "invalid_input",
            "Company amendment proposal is invalid",
            { cause: error },
          );
        }
        await this.dependencies.amendments.create(amendment, input.signal);
        return await this.dependencies.amendments.load(amendment.id, input.signal);
      },
      input.signal,
    );
  }

  async approve(input: CompanyAmendmentDecisionInput): Promise<{
    readonly amendment: CompanyAmendmentV1;
    readonly blueprint: CompanyBlueprintV2;
  }> {
    const base = await this.#authority(input.company, input.signal);
    return await withPrivateStateMutationLock(
      amendmentLockDirectory(this.dependencies.amendments.directory),
      amendmentLockId(base.companyId),
      async () => {
        const freshBase = await this.#authority(input.company, input.signal);
        const amendment = await this.dependencies.amendments.load(
          input.amendmentId,
          input.signal,
        );
        if (!amendmentMatchesBinding(amendment, input.company) ||
          amendment.companyId !== freshBase.companyId) {
          throw new CompanyAmendmentError(
            "authority_mismatch",
            "Company amendment does not match the active blueprint authority",
          );
        }
        if (amendment.state === "rejected") {
          throw new CompanyAmendmentError(
            "already_decided",
            "The company amendment was already rejected",
          );
        }
        if (amendment.state === "approved") {
          const blueprint = await this.dependencies.blueprints.load(
            amendment.resultingBlueprintId!,
            input.signal,
          );
          if (!approvedProposalMatches(blueprint, amendment.proposedBlueprint)) {
            throw new CompanyAmendmentError(
              "corrupt_state",
              "The approved amendment blueprint does not match its proposal",
            );
          }
          return Object.freeze({ amendment, blueprint });
        }
        const allBlueprints = await this.dependencies.blueprints.list(input.signal);
        const latest = latestApproved(allBlueprints, freshBase.companyId);
        let blueprint: CompanyBlueprintV2;
        if (latest.id === freshBase.id && latest.revision === freshBase.revision) {
          try {
            blueprint = approveCompanyBlueprintV2(
              amendment.proposedBlueprint,
              input.at,
            );
          } catch (error) {
            throw new CompanyAmendmentError(
              "invalid_input",
              "Company amendment approval timestamp is invalid",
              { cause: error },
            );
          }
          await this.dependencies.blueprints.create(blueprint, input.signal);
        } else if (latest.id === amendment.proposedBlueprint.id &&
          latest.revision === amendment.proposedBlueprint.revision &&
          approvedProposalMatches(latest, amendment.proposedBlueprint)) {
          const claimed = (await this.dependencies.amendments.list(
            freshBase.companyId,
            input.signal,
          )).some((candidate) =>
            candidate.id !== amendment.id && candidate.state === "approved" &&
            candidate.resultingBlueprintId === latest.id
          );
          if (claimed) {
            throw new CompanyAmendmentError(
              "stale_base",
              "The company amendment base revision is stale",
            );
          }
          blueprint = latest;
        } else {
          throw new CompanyAmendmentError(
            "stale_base",
            "The company amendment base revision is stale",
          );
        }
        let decision: CompanyAmendmentV1;
        try {
          decision = parseCompanyAmendment({
            ...amendment,
            state: "approved",
            decidedAt: input.at,
            resultingBlueprintId: blueprint.id,
            decisionReason: input.decisionReason,
          });
        } catch (error) {
          throw new CompanyAmendmentError(
            "invalid_input",
            "Company amendment decision is invalid",
            { cause: error },
          );
        }
        await this.dependencies.amendments.decide(decision, input.signal);
        return Object.freeze({
          amendment: await this.dependencies.amendments.load(
            decision.id,
            input.signal,
          ),
          blueprint,
        });
      },
      input.signal,
    );
  }

  async reject(input: CompanyAmendmentDecisionInput): Promise<{
    readonly amendment: CompanyAmendmentV1;
  }> {
    const base = await this.#authority(input.company, input.signal);
    return await withPrivateStateMutationLock(
      amendmentLockDirectory(this.dependencies.amendments.directory),
      amendmentLockId(base.companyId),
      async () => {
        const freshBase = await this.#authority(input.company, input.signal);
        const amendment = await this.dependencies.amendments.load(
          input.amendmentId,
          input.signal,
        );
        if (!amendmentMatchesBinding(amendment, input.company) ||
          amendment.companyId !== freshBase.companyId) {
          throw new CompanyAmendmentError(
            "authority_mismatch",
            "Company amendment does not match the active blueprint authority",
          );
        }
        if (amendment.state === "approved") {
          throw new CompanyAmendmentError(
            "already_decided",
            "The company amendment was already approved",
          );
        }
        if (amendment.state === "rejected") {
          return Object.freeze({ amendment });
        }
        let decision: CompanyAmendmentV1;
        try {
          decision = parseCompanyAmendment({
            ...amendment,
            state: "rejected",
            decidedAt: input.at,
            resultingBlueprintId: null,
            decisionReason: input.decisionReason,
          });
        } catch (error) {
          throw new CompanyAmendmentError(
            "invalid_input",
            "Company amendment decision is invalid",
            { cause: error },
          );
        }
        await this.dependencies.amendments.decide(decision, input.signal);
        return Object.freeze({
          amendment: await this.dependencies.amendments.load(
            decision.id,
            input.signal,
          ),
        });
      },
      input.signal,
    );
  }
}
