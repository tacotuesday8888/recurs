import { createHash } from "node:crypto";

import type {
  CompanyBlueprintV2,
  CompanyEvaluationReportV1,
  CompanyOnboardingRunV1,
} from "@recurs/contracts";
import {
  createCompanyEvaluationReport,
  sanitizeCompanyEvaluationText,
} from "@recurs/core";

import type { createStandaloneCompanyOnboarding } from "./assembly.js";

type CompanyOnboardingService = Awaited<ReturnType<
  typeof createStandaloneCompanyOnboarding
>>;

export const COMPANY_FORMATION_EVALUATION_SCENARIO = Object.freeze({
  id: "company_formation_v1",
  version: 1 as const,
  depth: "guided" as const,
  designMode: "stable_core_specialists" as const,
  maximumAdvances: 16,
  maximumRequests: 32,
  maximumReportedCostUsd: 3,
});

const scenarioAnswer = [
  "Build Recurs as a dependable open-source coding-agent company for software maintainers.",
  "The CLI should understand an existing TypeScript repository, delegate bounded work, require independent review, and return attributable evidence.",
  "Success means concise maintainable changes, no authority escalation, explicit budgets, truthful failures, and reproducible verification.",
].join(" ");

function backendFingerprint(value: string): string {
  return `backend_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function rubric(
  passed: boolean,
  evidence: string,
): { readonly status: "passed" | "failed"; readonly evidence: readonly string[] } {
  return { status: passed ? "passed" : "failed", evidence: [evidence] };
}

function scoredRubric(
  run: CompanyOnboardingRunV1,
  blueprint: CompanyBlueprintV2,
  costKnown: boolean,
): Parameters<typeof createCompanyEvaluationReport>[0]["rubric"] {
  const questions = run.interview.answers.map((answer) => answer.question);
  const interview = questions.length >= 1 && questions.length <= 6 &&
    new Set(questions).size === questions.length;
  const tailored = blueprint.project.purpose.length >= 30 &&
    blueprint.project.successCriteria.length > 0 &&
    blueprint.project.constraints.length > 0 && blueprint.initialGoal.length >= 20;
  const kinds = new Set(blueprint.roles.map((role) => role.kind));
  const decomposed = blueprint.roles.length >= 4 && kinds.has("orchestrator") &&
    kinds.has("reviewer") && blueprint.authorityAnchors.independentReviewRoleIds.length > 0;
  const completedResearch = run.research.filter((item) => item.status === "completed");
  const evidenceReady = completedResearch.length > 0 &&
    completedResearch.every((item) => item.evidence.length > 0) &&
    blueprint.project.repository.evidence.length > 0;
  const efficient = run.usage.modelRequests <=
      COMPANY_FORMATION_EVALUATION_SCENARIO.maximumRequests &&
    run.usage.reportedCostUsd <=
      COMPANY_FORMATION_EVALUATION_SCENARIO.maximumReportedCostUsd;
  return {
    interview_quality: rubric(
      interview,
      `${questions.length} unique adaptive question(s) answered.`,
    ),
    blueprint_tailoring: rubric(
      tailored,
      `Purpose, constraints, success criteria, and initial goal were ${tailored ? "specific" : "insufficiently specific"}.`,
    ),
    decomposition: rubric(
      decomposed,
      `${blueprint.departments.length} department(s), ${blueprint.roles.length} role(s), and ${blueprint.authorityAnchors.independentReviewRoleIds.length} independent review authority role(s).`,
    ),
    evidence: rubric(
      evidenceReady,
      `${completedResearch.length} completed research assignment(s) and ${blueprint.project.repository.evidence.length} repository evidence item(s).`,
    ),
    synthesis: {
      status: "not_applicable",
      evidence: ["The formation scenario ends at blueprint approval; goal synthesis is evaluated by runtime integration suites."],
    },
    efficiency: {
      status: costKnown ? efficient ? "passed" : "failed" : "unknown",
      evidence: [
        `${run.usage.modelRequests} model request(s); reported cost ${costKnown ? `$${run.usage.reportedCostUsd.toFixed(4)}` : "unknown"}.`,
      ],
    },
  };
}

export async function evaluateCompanyFormation(input: {
  readonly service: CompanyOnboardingService;
  readonly mode: "offline" | "configured";
  readonly backend: { readonly providerId: string; readonly modelId: string };
  readonly signal?: AbortSignal;
  readonly now?: () => string;
}): Promise<CompanyEvaluationReportV1> {
  const now = input.now ?? (() => new Date().toISOString());
  const startedAt = now();
  let lastRun: CompanyOnboardingRunV1 | null = null;
  try {
    const started = await input.service.coordinator.start({
      projectRoot: input.service.projectRoot,
      depth: COMPANY_FORMATION_EVALUATION_SCENARIO.depth,
      designMode: COMPANY_FORMATION_EVALUATION_SCENARIO.designMode,
      permissionMode: "approved_for_me",
      operatingModeId: "balanced_v6",
      backendFingerprint: input.service.backendFingerprint,
      repositoryConsent: true,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    let run = started;
    lastRun = run.state;
    let blueprint: CompanyBlueprintV2 | null = null;
    for (let step = 0;
      step < COMPANY_FORMATION_EVALUATION_SCENARIO.maximumAdvances;
      step += 1) {
      input.signal?.throwIfAborted();
      const advanced = await input.service.coordinator.advance(
        run.state.id,
        input.signal,
      );
      run = advanced.run;
      lastRun = run.state;
      if (advanced.kind === "question") {
        run = await input.service.coordinator.answer(
          run.state.id,
          run.sequence,
          scenarioAnswer,
          input.signal,
        );
        lastRun = run.state;
        continue;
      }
      if (advanced.kind === "researched") continue;
      const approved = await input.service.coordinator.approve(
        run.state.id,
        run.sequence,
        input.signal,
      );
      lastRun = approved.state;
      blueprint = await input.service.coordinator.approvedBlueprint(
        approved.state.approvedBlueprintId!,
        input.signal,
      );
      break;
    }
    if (blueprint === null || lastRun.status !== "approved") {
      throw new Error("Company evaluation did not reach an approved blueprint");
    }
    const costKnown = input.mode === "offline";
    return createCompanyEvaluationReport({
      scenarioId: COMPANY_FORMATION_EVALUATION_SCENARIO.id,
      mode: input.mode,
      startedAt,
      completedAt: now(),
      backend: {
        providerId: input.backend.providerId,
        modelId: input.backend.modelId,
        fingerprint: backendFingerprint(input.service.backendFingerprint),
      },
      usage: {
        requestsUsed: lastRun.usage.modelRequests,
        reportedCostUsd: costKnown ? lastRun.usage.reportedCostUsd : null,
      },
      rubric: scoredRubric(lastRun, blueprint, costKnown),
    });
  } catch (error) {
    const cancelled = input.signal?.aborted === true ||
      error instanceof DOMException && error.name === "AbortError";
    const message = sanitizeCompanyEvaluationText(
      error instanceof Error ? error.message : "Company evaluation failed",
    );
    const notCompleted = {
      status: "unknown" as const,
      evidence: ["The scenario did not complete this rubric dimension."],
    };
    const unknown: Parameters<typeof createCompanyEvaluationReport>[0]["rubric"] = {
      interview_quality: notCompleted,
      blueprint_tailoring: notCompleted,
      decomposition: notCompleted,
      evidence: notCompleted,
      synthesis: notCompleted,
      efficiency: notCompleted,
    };
    return createCompanyEvaluationReport({
      scenarioId: COMPANY_FORMATION_EVALUATION_SCENARIO.id,
      mode: input.mode,
      startedAt,
      completedAt: now(),
      backend: {
        providerId: input.backend.providerId,
        modelId: input.backend.modelId,
        fingerprint: backendFingerprint(input.service.backendFingerprint),
      },
      usage: {
        requestsUsed: lastRun?.usage.modelRequests ?? 0,
        reportedCostUsd: input.mode === "offline"
          ? lastRun?.usage.reportedCostUsd ?? 0
          : null,
      },
      rubric: unknown,
      failures: [{ code: cancelled ? "cancelled" : "evaluation_failed", message }],
    });
  }
}

export function renderCompanyEvaluationReport(
  report: CompanyEvaluationReportV1,
): string {
  return [
    `Company evaluation: ${report.scenarioId} v${report.scenarioVersion}`,
    `Status: ${report.status}`,
    `Backend: ${report.backend.providerId} / ${report.backend.modelId}`,
    `Latency: ${report.latencyMs} ms`,
    `Usage: ${report.usage.requestsUsed} request(s), ${report.usage.reportedCostUsd === null ? "reported cost unknown" : `$${report.usage.reportedCostUsd.toFixed(4)}`}`,
    ...report.rubric.map((item) =>
      `${item.status.padEnd(14)} ${item.dimension}: ${item.evidence.join(" ")}`
    ),
    ...report.failures.map((failure) =>
      `failure ${failure.code}: ${failure.message}`
    ),
  ].join("\n");
}
