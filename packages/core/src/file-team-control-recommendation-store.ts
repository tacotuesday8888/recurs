import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  parseTeamControlRecommendationV1,
  type TeamControlRecommendationV1,
} from "@recurs/contracts";

import {
  CompanyStateStoreError,
  PrivateImmutableJsonStore,
} from "./private-state-store.js";

interface StoredRecommendation {
  readonly workspaceDigest: string;
  readonly recommendation: TeamControlRecommendationV1;
}

const DIGEST = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder();

function workspaceDigest(workspace: string): string {
  if (workspace.length === 0 || encoder.encode(workspace).byteLength > 4_096) {
    throw new CompanyStateStoreError(
      "invalid_id",
      "Team-control recommendation workspace is invalid",
    );
  }
  return createHash("sha256").update(workspace).digest("hex");
}

function recordId(digest: string, id: string): string {
  return `team-recommendation-${digest}-${id}`;
}

function parseStored(value: unknown): StoredRecommendation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Stored team-control recommendation must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !==
      "recommendation,workspaceDigest" ||
    typeof record.workspaceDigest !== "string" ||
    !DIGEST.test(record.workspaceDigest)) {
    throw new TypeError("Stored team-control recommendation identity is invalid");
  }
  return Object.freeze({
    workspaceDigest: record.workspaceDigest,
    recommendation: parseTeamControlRecommendationV1(record.recommendation),
  });
}

function proposalProjection(
  recommendation: TeamControlRecommendationV1,
): TeamControlRecommendationV1 {
  return parseTeamControlRecommendationV1({
    ...recommendation,
    state: "proposed",
    decidedAt: null,
    appliedPolicyRevision: null,
    decisionReason: null,
  });
}

function validateDecision(
  proposal: StoredRecommendation,
  decision: StoredRecommendation,
  code: "conflict" | "corrupt",
): void {
  if (proposal.workspaceDigest !== decision.workspaceDigest ||
    proposal.recommendation.state !== "proposed" ||
    decision.recommendation.state === "proposed" ||
    !isDeepStrictEqual(
      proposal.recommendation,
      proposalProjection(decision.recommendation),
    )) {
    throw new CompanyStateStoreError(
      code,
      code === "corrupt"
        ? "Team-control recommendation decision history is invalid"
        : "Team-control recommendation decision does not match its proposal",
    );
  }
}

export class FileTeamControlRecommendationStore {
  readonly #proposals: PrivateImmutableJsonStore<StoredRecommendation>;
  readonly #decisions: PrivateImmutableJsonStore<StoredRecommendation>;

  constructor(readonly directory: string) {
    const options = {
      maximumBytes: 64 * 1024,
      maximumRecords: 4_096,
      parse: parseStored,
      idOf: (record: StoredRecommendation) =>
        recordId(record.workspaceDigest, record.recommendation.id),
    };
    this.#proposals = new PrivateImmutableJsonStore(directory, {
      ...options,
      label: "Team-control recommendation proposal",
    });
    this.#decisions = new PrivateImmutableJsonStore(
      path.join(directory, ".decisions"),
      {
        ...options,
        label: "Team-control recommendation decision",
      },
    );
  }

  create(
    workspace: string,
    input: TeamControlRecommendationV1,
    signal?: AbortSignal,
  ): Promise<void> {
    const recommendation = parseTeamControlRecommendationV1(input);
    if (recommendation.state !== "proposed") {
      throw new CompanyStateStoreError(
        "conflict",
        "A team-control recommendation must be created as a proposal",
      );
    }
    return this.#proposals.create({
      workspaceDigest: workspaceDigest(workspace),
      recommendation,
    }, signal);
  }

  async decide(
    workspace: string,
    input: TeamControlRecommendationV1,
    signal?: AbortSignal,
  ): Promise<void> {
    const digest = workspaceDigest(workspace);
    const recommendation = parseTeamControlRecommendationV1(input);
    const id = recordId(digest, recommendation.id);
    const proposal = await this.#proposals.load(id, signal);
    const decision = { workspaceDigest: digest, recommendation };
    validateDecision(proposal, decision, "conflict");
    await this.#decisions.create(decision, signal);
  }

  async load(
    workspace: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<TeamControlRecommendationV1> {
    const digest = workspaceDigest(workspace);
    const record = recordId(digest, id);
    const proposal = await this.#proposals.load(record, signal);
    try {
      const decision = await this.#decisions.load(record, signal);
      validateDecision(proposal, decision, "corrupt");
      return decision.recommendation;
    } catch (error) {
      if (error instanceof CompanyStateStoreError &&
        error.code === "not_found") {
        return proposal.recommendation;
      }
      throw error;
    }
  }

  async list(
    workspace: string,
    signal?: AbortSignal,
  ): Promise<readonly TeamControlRecommendationV1[]> {
    const digest = workspaceDigest(workspace);
    const [proposals, decisions] = await Promise.all([
      this.#proposals.list(signal),
      this.#decisions.list(signal),
    ]);
    const scopedProposals = proposals.filter((item) =>
      item.workspaceDigest === digest
    );
    const decisionsById = new Map(decisions.filter((item) =>
      item.workspaceDigest === digest
    ).map((item) => [item.recommendation.id, item] as const));
    for (const decision of decisionsById.values()) {
      const proposal = scopedProposals.find((item) =>
        item.recommendation.id === decision.recommendation.id
      );
      if (proposal === undefined) {
        throw new CompanyStateStoreError(
          "corrupt",
          "Team-control recommendation decision has no proposal",
        );
      }
      validateDecision(proposal, decision, "corrupt");
    }
    return Object.freeze(scopedProposals.map((proposal) =>
      decisionsById.get(proposal.recommendation.id)?.recommendation ??
        proposal.recommendation
    ));
  }
}
