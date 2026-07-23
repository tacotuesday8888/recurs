import { createHash } from "node:crypto";

import {
  parseModelTeamSelection,
  type ModelTeamEvaluationV1,
  type ModelTeamRouteV1,
  type ModelTeamSelectionV1,
  type ModelTeamTaskClass,
} from "@recurs/contracts";

const requiredDimensions = new Set([
  "decomposition",
  "evidence",
  "synthesis",
]);
const roleOrder = new Map([
  ["parent", 0],
  ["implement", 1],
  ["review", 2],
  ["repair", 3],
]);

function canonicalLineup(
  lineup: readonly ModelTeamRouteV1[],
): readonly ModelTeamRouteV1[] {
  return [...lineup].sort(
    (left, right) => roleOrder.get(left.role)! - roleOrder.get(right.role)!,
  );
}

function lineupKey(lineup: readonly ModelTeamRouteV1[]): string {
  return JSON.stringify(canonicalLineup(lineup));
}

export function eligibleModelTeamEvaluation(
  evaluation: ModelTeamEvaluationV1,
): boolean {
  if (
    evaluation.report.status !== "passed" &&
    evaluation.report.status !== "partial"
  ) {
    return false;
  }
  return [...requiredDimensions].every((dimension) =>
    evaluation.report.rubric.some((item) =>
      item.dimension === dimension && item.status === "passed"
    )
  );
}

function qualityScore(evaluation: ModelTeamEvaluationV1): number {
  return evaluation.report.rubric.reduce((score, item) =>
    score + (item.status === "passed" ? 1 : 0), 0);
}

interface Candidate {
  readonly lineup: readonly ModelTeamRouteV1[];
  readonly evaluations: ModelTeamEvaluationV1[];
  score: number;
  latestAt: number;
}

export function selectEvaluatedModelTeam(input: {
  readonly evaluations: readonly ModelTeamEvaluationV1[];
  readonly taskClass?: ModelTeamTaskClass;
  readonly selectedAt: string;
}): ModelTeamSelectionV1 | null {
  const taskClass = input.taskClass ?? "general_coding";
  const selectedAt = new Date(input.selectedAt);
  if (!Number.isFinite(selectedAt.valueOf())) {
    throw new TypeError("Model-team selection timestamp is invalid");
  }
  const candidates = new Map<string, Candidate>();
  for (const evaluation of input.evaluations) {
    if (
      evaluation.taskClass !== taskClass ||
      !eligibleModelTeamEvaluation(evaluation)
    ) {
      continue;
    }
    const key = lineupKey(evaluation.lineup);
    const candidate = candidates.get(key) ?? {
      lineup: canonicalLineup(evaluation.lineup),
      evaluations: [],
      score: 0,
      latestAt: 0,
    };
    candidate.evaluations.push(evaluation);
    candidate.score += qualityScore(evaluation);
    candidate.latestAt = Math.max(
      candidate.latestAt,
      new Date(evaluation.evaluatedAt).valueOf(),
    );
    candidates.set(key, candidate);
  }
  const ranked = [...candidates.values()].sort((left, right) =>
    right.score - left.score ||
    right.evaluations.length - left.evaluations.length ||
    right.latestAt - left.latestAt ||
    lineupKey(left.lineup).localeCompare(lineupKey(right.lineup))
  );
  const winner = ranked[0];
  if (winner === undefined) return null;
  const evidenceIds = winner.evaluations
    .sort((left, right) =>
      left.evaluatedAt.localeCompare(right.evaluatedAt) ||
      left.id.localeCompare(right.id)
    )
    .map((evaluation) => evaluation.id);
  const digest = createHash("sha256").update(JSON.stringify({
    taskClass,
    lineup: winner.lineup,
    evidenceIds,
  })).digest("hex").slice(0, 32);
  return parseModelTeamSelection({
    id: `model-team-selection-${digest}`,
    version: 1,
    taskClass,
    selectedAt: selectedAt.toISOString(),
    lineup: winner.lineup,
    evidenceIds,
    rationale: [
      `${winner.evaluations.length} eligible configured company-goal evaluation`,
      winner.evaluations.length === 1 ? " supports " : "s support ",
      "this lineup; decomposition, evidence, and synthesis passed.",
    ].join(""),
  });
}
