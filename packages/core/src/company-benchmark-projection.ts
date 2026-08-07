import { createHash } from "node:crypto";

import {
  parseCompanyBenchmarkTrial,
  type CompanyBenchmarkCampaignV1,
  type CompanyBenchmarkFailureV1,
  type CompanyBenchmarkRole,
  type CompanyBenchmarkRouteV1,
  type CompanyBenchmarkRoleObservationV1,
  type CompanyBenchmarkTrialSlotV1,
  type CompanyBenchmarkTrialV1,
  type CompanyBenchmarkUsageV1,
} from "@recurs/contracts";

import type { CompanyBenchmarkWorkspaceVerification } from "./company-benchmark-scenario.js";
import type {
  CompanyBenchmarkAttemptObservation,
  CompanyBenchmarkRecorderSnapshot,
  CompanyBenchmarkRequestObservation,
} from "./company-benchmark-recorder.js";
import type { TeamRunState } from "./team-run-state.js";

const ROLE_ORDER = [
  "parent",
  "implement",
  "review",
  "repair",
] as const satisfies readonly CompanyBenchmarkRole[];

function trialId(campaignId: string, slotId: string): string {
  return `benchmark_trial_${
    createHash("sha256")
      .update(JSON.stringify([campaignId, slotId]))
      .digest("hex")
      .slice(0, 32)
  }`;
}

function coverage(
  reports: number,
  requests: number,
): "none" | "partial" | "complete" {
  return reports === 0 ? "none" : reports === requests ? "complete" : "partial";
}

function sumOptionalUsage(
  requests: readonly CompanyBenchmarkRequestObservation[],
  key: "cachedInputTokens" | "cacheWriteInputTokens" | "reasoningTokens",
): number | null {
  const reports = requests.flatMap((request) =>
    request.usage === null ? [] : [request.usage]
  );
  if (reports.length === 0 || reports.some((usage) => usage[key] === undefined)) {
    return null;
  }
  return reports.reduce((sum, usage) => sum + usage[key]!, 0);
}

function summarizeUsage(
  requests: readonly CompanyBenchmarkRequestObservation[],
): CompanyBenchmarkUsageV1 {
  const usage = requests.flatMap((request) =>
    request.usage === null ? [] : [request.usage]
  );
  const cost = usage.filter((report) => report.costUsd !== undefined);
  return {
    requestsUsed: requests.length,
    usageReports: usage.length,
    costReports: cost.length,
    tokenCoverage: coverage(usage.length, requests.length),
    costCoverage: coverage(cost.length, requests.length),
    inputTokens: usage.length === 0
      ? null
      : usage.reduce((sum, report) => sum + report.inputTokens, 0),
    outputTokens: usage.length === 0
      ? null
      : usage.reduce((sum, report) => sum + report.outputTokens, 0),
    cachedInputTokens: sumOptionalUsage(requests, "cachedInputTokens"),
    cacheWriteInputTokens: sumOptionalUsage(
      requests,
      "cacheWriteInputTokens",
    ),
    reasoningTokens: sumOptionalUsage(requests, "reasoningTokens"),
    reportedCostUsd: cost.length === 0
      ? null
      : cost.reduce((sum, report) => sum + report.costUsd!, 0),
  };
}

function boundedLatency(
  attempt: CompanyBenchmarkAttemptObservation,
  trialStartedAtMs: number,
  trialCompletedAtMs: number,
): number {
  const start = Math.max(trialStartedAtMs, attempt.startedAtMs);
  const end = Math.min(
    trialCompletedAtMs,
    Math.max(attempt.startedAtMs, attempt.completedAtMs),
  );
  return Math.max(0, end - start);
}

function roleObservation(input: {
  readonly role: CompanyBenchmarkRole;
  readonly attempts: readonly CompanyBenchmarkAttemptObservation[];
  readonly requests: readonly CompanyBenchmarkRequestObservation[];
  readonly trialStartedAtMs: number;
  readonly trialCompletedAtMs: number;
}): CompanyBenchmarkRoleObservationV1 {
  const latencies = input.attempts.map((attempt) =>
    boundedLatency(
      attempt,
      input.trialStartedAtMs,
      input.trialCompletedAtMs,
    )
  );
  const first = Math.max(
    input.trialStartedAtMs,
    Math.min(...input.attempts.map((attempt) => attempt.startedAtMs)),
  );
  const last = Math.min(
    input.trialCompletedAtMs,
    Math.max(...input.attempts.map((attempt) => attempt.completedAtMs)),
  );
  return {
    role: input.role,
    attempts: input.attempts.length,
    completedAttempts: input.attempts.filter(
      (attempt) => attempt.status === "completed",
    ).length,
    failedAttempts: input.attempts.filter(
      (attempt) => attempt.status === "failed",
    ).length,
    cancelledAttempts: input.attempts.filter(
      (attempt) => attempt.status === "cancelled",
    ).length,
    wallClockMs: Math.max(0, last - first),
    attemptLatenciesMs: latencies,
    usage: summarizeUsage(input.requests),
    evidenceItems: input.attempts.reduce(
      (sum, attempt) => sum + attempt.evidence.length,
      0,
    ),
    changedFiles: [...new Set(
      input.attempts.flatMap((attempt) => attempt.changedFiles),
    )].sort(),
  };
}

function aggregateUsage(
  roles: readonly CompanyBenchmarkRoleObservationV1[],
): CompanyBenchmarkUsageV1 {
  const requestsUsed = roles.reduce(
    (sum, role) => sum + role.usage.requestsUsed,
    0,
  );
  const usageReports = roles.reduce(
    (sum, role) => sum + role.usage.usageReports,
    0,
  );
  const costReports = roles.reduce(
    (sum, role) => sum + role.usage.costReports,
    0,
  );
  const sumRequired = (key: "inputTokens" | "outputTokens") =>
    usageReports === 0
      ? null
      : roles.reduce((sum, role) => sum + (role.usage[key] ?? 0), 0);
  const sumOptional = (
    key:
      | "cachedInputTokens"
      | "cacheWriteInputTokens"
      | "reasoningTokens",
  ) => usageReports === 0 ||
      roles.some((role) =>
        role.usage.usageReports > 0 && role.usage[key] === null
      )
    ? null
    : roles.reduce((sum, role) => sum + (role.usage[key] ?? 0), 0);
  return {
    requestsUsed,
    usageReports,
    costReports,
    tokenCoverage: coverage(usageReports, requestsUsed),
    costCoverage: coverage(costReports, requestsUsed),
    inputTokens: sumRequired("inputTokens"),
    outputTokens: sumRequired("outputTokens"),
    cachedInputTokens: sumOptional("cachedInputTokens"),
    cacheWriteInputTokens: sumOptional("cacheWriteInputTokens"),
    reasoningTokens: sumOptional("reasoningTokens"),
    reportedCostUsd: costReports === 0
      ? null
      : roles.reduce(
          (sum, role) => sum + (role.usage.reportedCostUsd ?? 0),
          0,
        ),
  };
}

type BenchmarkReviewRun = Pick<
  TeamRunState,
  "outcome" | "reviews"
> & {
  readonly descriptor: {
    readonly routes: readonly {
      readonly role: "implement" | "review" | "repair";
      readonly pin: {
        readonly providerId: string;
        readonly adapterId: string;
        readonly connectionId: string;
        readonly modelId: string;
        readonly reasoningEffortAtCreation?: CompanyBenchmarkRouteV1[
          "reasoningEffort"
        ];
      };
    }[];
  };
};

function reviewObservation(teamRuns: readonly BenchmarkReviewRun[]) {
  const reviews = teamRuns.flatMap((run) => run.reviews);
  const finalReviews = teamRuns.flatMap((run) => {
    const final = run.reviews.at(-1);
    return final === undefined ? [] : [final];
  });
  const finalVerdict = reviews.length === 0
    ? null
    : finalReviews.length === teamRuns.length &&
        finalReviews.every((review) => review.verdict === "approved")
      ? "approved" as const
      : finalReviews.some((review) => review.verdict === "changes_requested")
        ? "changes_requested" as const
        : "unverified" as const;
  return {
    attempts: reviews.length,
    approved: reviews.filter((review) => review.verdict === "approved").length,
    changesRequested: reviews.filter(
      (review) => review.verdict === "changes_requested",
    ).length,
    unverified: reviews.filter(
      (review) => review.verdict === "unverified",
    ).length,
    finalVerdict,
    findings: reviews.reduce(
      (sum, review) => sum + review.findings.length,
      0,
    ),
    affectedPaths: [...new Set(reviews.flatMap((review) =>
      review.findings.map((finding) => finding.path)
    ))].sort(),
    evidenceItems: reviews.reduce(
      (sum, review) => sum + review.evidence.length,
      0,
    ),
  };
}

function teamFailureCodes(
  teamRuns: readonly BenchmarkReviewRun[],
): readonly string[] {
  return [...new Set(teamRuns.flatMap((run) =>
    run.outcome?.failure === null || run.outcome?.failure === undefined
      ? []
      : [run.outcome.failure.code]
  ))].sort();
}

function sameRoute(
  left: CompanyBenchmarkRouteV1,
  right: CompanyBenchmarkRouteV1,
): boolean {
  return left.role === right.role &&
    left.providerId === right.providerId &&
    left.adapterId === right.adapterId &&
    left.connectionId === right.connectionId &&
    left.modelId === right.modelId &&
    left.reasoningEffort === right.reasoningEffort;
}

function activatedRoute(
  role: CompanyBenchmarkRole,
  configured: readonly CompanyBenchmarkRouteV1[],
  teamRuns: readonly BenchmarkReviewRun[],
): CompanyBenchmarkRouteV1 {
  const expected = configured.find((candidate) => candidate.role === role);
  if (expected === undefined) {
    throw new TypeError(
      "Company benchmark activated role lacks a configured route",
    );
  }
  if (role === "parent") return expected;
  const observed = teamRuns.flatMap((run) =>
    run.descriptor.routes
      .filter((route) => route.role === role)
      .map((route) => ({
        role,
        providerId: route.pin.providerId,
        adapterId: route.pin.adapterId,
        connectionId: route.pin.connectionId,
        modelId: route.pin.modelId,
        reasoningEffort: route.pin.reasoningEffortAtCreation ?? null,
      }))
  );
  const first = observed[0];
  if (first === undefined ||
    observed.some((candidate) => !sameRoute(candidate, first)) ||
    !sameRoute(first, expected)) {
    throw new TypeError(
      "Company benchmark activated route differs from frozen campaign authority",
    );
  }
  return first;
}

function overlapObservation(
  attempts: readonly CompanyBenchmarkAttemptObservation[],
) {
  const implementations = attempts.filter(
    (attempt) => attempt.role === "implement",
  );
  const claims = new Map<string, number>();
  for (const attempt of implementations) {
    for (const changedPath of attempt.changedFiles) {
      claims.set(changedPath, (claims.get(changedPath) ?? 0) + 1);
    }
  }
  const implementOverlappingPaths = [...claims]
    .filter(([, count]) => count > 1)
    .map(([changedPath]) => changedPath)
    .sort();
  const implementationPaths = new Set(claims.keys());
  const repairTouchedImplementationPaths = [...new Set(
    attempts
      .filter((attempt) => attempt.role === "repair")
      .flatMap((attempt) => attempt.changedFiles)
      .filter((changedPath) => implementationPaths.has(changedPath)),
  )].sort();
  return {
    metric: "changed_file_overlap_v1" as const,
    implementOverlappingPaths,
    implementDuplicateClaims: implementOverlappingPaths.reduce(
      (sum, changedPath) => sum + claims.get(changedPath)! - 1,
      0,
    ),
    repairTouchedImplementationPaths,
  };
}

function workspaceIntegrity(
  verification: CompanyBenchmarkWorkspaceVerification,
): "passed" | "failed" | "not_run" {
  if (verification.status === "not_run") return "not_run";
  const integrity = new Set([
    "workspace_inventory",
    "git_state",
    "allowed_changes",
  ]);
  return verification.checks
      .filter((check) => integrity.has(check.id))
      .every((check) => check.status === "passed")
    ? "passed"
    : "failed";
}

const RUNTIME_EXECUTION_FAILURE_CODES = new Set([
  "execution_cancelled",
  "company_goal_interrupted",
  "agent_cancelled",
  "agent_context_overflow",
  "agent_invalid_provider_response",
  "agent_provider_failed",
  "runtime_cancelled",
  "runtime_provider_not_configured",
]);

function executionTerminalStage(
  roles: readonly CompanyBenchmarkRoleObservationV1[],
): "parent" | "implement" | "review" | "repair" | undefined {
  const terminal = [...roles].reverse().find((role) =>
    role.role !== "parent" &&
    (role.failedAttempts > 0 || role.cancelledAttempts > 0)
  );
  if (terminal !== undefined && terminal.role !== "parent") return terminal.role;
  const parent = roles.find((role) => role.role === "parent");
  return roles.length === 1 && parent !== undefined &&
      (parent.failedAttempts > 0 || parent.cancelledAttempts > 0)
    ? "parent"
    : undefined;
}

function classifyFailure(
  failure: CompanyBenchmarkFailureV1,
  roles: readonly CompanyBenchmarkRoleObservationV1[],
): CompanyBenchmarkFailureV1 {
  if (failure.stage === "verification") {
    return {
      ...failure,
      scope: "verification",
      terminalStage: "verification",
    };
  }
  if (failure.stage === "setup") {
    return { ...failure, scope: "harness", terminalStage: "setup" };
  }
  if (failure.stage === "cleanup") {
    return { ...failure, scope: "harness", terminalStage: "cleanup" };
  }
  if (failure.stage === "projection") {
    return { ...failure, scope: "harness" };
  }
  const runtimeExecution = failure.code.startsWith("coordinated_") ||
    failure.code.startsWith("runtime_") ||
    RUNTIME_EXECUTION_FAILURE_CODES.has(failure.code);
  const terminalStage = failure.terminalStage ?? executionTerminalStage(roles);
  return {
    ...failure,
    scope: failure.scope ??
      (runtimeExecution ? "runtime_execution" : "roster_execution"),
    ...(terminalStage === undefined ? {} : { terminalStage }),
  };
}

export function projectCompanyBenchmarkTrial(input: {
  readonly campaign: CompanyBenchmarkCampaignV1;
  readonly slot: CompanyBenchmarkTrialSlotV1;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly recorder: CompanyBenchmarkRecorderSnapshot;
  readonly verification: CompanyBenchmarkWorkspaceVerification;
  readonly teamRuns: readonly BenchmarkReviewRun[];
  readonly executionStatus:
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  readonly finalEvidence: readonly string[];
  readonly failures?: readonly CompanyBenchmarkFailureV1[];
}): CompanyBenchmarkTrialV1 {
  const arm = input.slot.armId === input.campaign.baseline.id
    ? input.campaign.baseline
    : input.campaign.companyArms.find(
        (candidate) => candidate.id === input.slot.armId,
      );
  if (arm === undefined ||
    input.completedAtMs < input.startedAtMs ||
    input.recorder.requests.some((request) =>
      !input.recorder.attempts.some((attempt) =>
        attempt.role === request.role &&
        attempt.sessionId === request.sessionId
      )
    )) {
    throw new TypeError("Company benchmark execution evidence is inconsistent");
  }
  const roles = ROLE_ORDER.flatMap((role) => {
    const attempts = input.recorder.attempts.filter(
      (attempt) => attempt.role === role,
    );
    if (attempts.length === 0) return [];
    return [roleObservation({
      role,
      attempts,
      requests: input.recorder.requests.filter(
        (request) => request.role === role,
      ),
      trialStartedAtMs: input.startedAtMs,
      trialCompletedAtMs: input.completedAtMs,
    })];
  });
  const activatedRoutes = roles.map((role) =>
    activatedRoute(role.role, arm.configuredRoutes, input.teamRuns)
  );
  const review = reviewObservation(input.teamRuns);
  const observedReviewAttempts = roles.find(
    (role) => role.role === "review",
  )?.attempts ?? 0;
  if (review.attempts > observedReviewAttempts) {
    throw new TypeError(
      `Company benchmark review evidence mismatch: ${review.attempts} durable review rounds for ${observedReviewAttempts} Review attempts`,
    );
  }
  const changedFiles = [...new Set(
    roles.flatMap((role) => role.changedFiles),
  )].sort();
  const failures = [...(input.failures ?? [])];
  for (const code of teamFailureCodes(input.teamRuns)) {
    if (!failures.some((failure) =>
      failure.stage === "execution" && failure.code === code
    )) {
      failures.push({ stage: "execution", code });
    }
  }
  if (input.verification.status === "failed" &&
    !failures.some((failure) => failure.stage === "verification")) {
    failures.push({ stage: "verification", code: "scenario_verification_failed" });
  }

  return parseCompanyBenchmarkTrial({
    id: trialId(input.campaign.id, input.slot.slotId),
    version: 1,
    campaignId: input.campaign.id,
    slotId: input.slot.slotId,
    armId: arm.id,
    armKind: arm.kind,
    repetition: input.slot.repetition,
    scenario: input.campaign.scenario,
    harnessRevision: input.campaign.harnessRevision,
    launchProtocolRevision: input.campaign.launchProtocolRevision,
    blueprint: arm.kind === "single_agent" ? null : input.campaign.blueprint,
    configuredRoutes: arm.configuredRoutes,
    activatedRoutes,
    executionStatus: input.executionStatus,
    startedAt: new Date(input.startedAtMs).toISOString(),
    completedAt: new Date(input.completedAtMs).toISOString(),
    wallClockMs: input.completedAtMs - input.startedAtMs,
    roles,
    usage: aggregateUsage(roles),
    verification: {
      status: input.verification.status,
      workspaceIntegrity: workspaceIntegrity(input.verification),
      checks: input.verification.checks,
    },
    review,
    repairRounds: roles.find((role) => role.role === "repair")?.attempts ?? 0,
    interventions: input.recorder.interventions,
    evidence: {
      roleItems: roles.reduce(
        (sum, role) => sum + role.evidenceItems,
        0,
      ),
      finalItems: input.finalEvidence.length,
    },
    changedFiles,
    overlap: overlapObservation(input.recorder.attempts),
    failures: failures.map((failure) => classifyFailure(failure, roles)),
  });
}
