import { createHash } from "node:crypto";

import {
  parseModelTeamSelectionV2,
  type ModelTeamEvaluation,
  type ModelTeamEvaluationV2,
  type ModelTeamRouteV1,
  type ModelTeamSelectionV2,
  type ModelTeamTaskClass,
} from "@recurs/contracts";

export const MODEL_TEAM_MINIMUM_OBSERVED_EVALUATIONS = 3;

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
  evaluation: ModelTeamEvaluation,
): evaluation is ModelTeamEvaluationV2 {
  if (
    evaluation.version !== 2 ||
    !["parent", "implement", "review"].every((role) =>
      evaluation.activatedRoles.includes(role as ModelTeamEvaluationV2["activatedRoles"][number])
    )
  ) {
    return false;
  }
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

interface Candidate {
  readonly lineup: readonly ModelTeamRouteV1[];
  readonly evaluations: ModelTeamEvaluationV2[];
  latestAt: number;
}

export function selectEvaluatedModelTeam(input: {
  readonly evaluations: readonly ModelTeamEvaluation[];
  readonly taskClass?: ModelTeamTaskClass;
  readonly selectedAt: string;
}): ModelTeamSelectionV2 | null {
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
      latestAt: 0,
    };
    candidate.evaluations.push(evaluation);
    candidate.latestAt = Math.max(
      candidate.latestAt,
      new Date(evaluation.evaluatedAt).valueOf(),
    );
    candidates.set(key, candidate);
  }
  const ranked = [...candidates.values()].sort((left, right) =>
    right.evaluations.length - left.evaluations.length ||
    right.latestAt - left.latestAt ||
    lineupKey(left.lineup).localeCompare(lineupKey(right.lineup))
  );
  const winner = ranked[0];
  if (
    winner === undefined ||
    winner.evaluations.length < MODEL_TEAM_MINIMUM_OBSERVED_EVALUATIONS
  ) return null;
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
  return parseModelTeamSelectionV2({
    id: `model-team-selection-${digest}`,
    version: 2,
    taskClass,
    selectedAt: selectedAt.toISOString(),
    lineup: winner.lineup,
    evaluatedRoles: ["parent", "implement", "review"],
    evidenceIds,
    rationale: [
      `${winner.evaluations.length} eligible recorded configured company-goal evaluation`,
      winner.evaluations.length === 1 ? " supports " : "s support ",
      "this configured lineup; Parent, Implement, and Review were observed. Repair remains a fallback unless separately observed.",
    ].join(""),
  });
}
