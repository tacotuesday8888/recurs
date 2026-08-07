import { describe, expect, it } from "vitest";

import {
  companyBenchmarkTrialSlotId,
  parseCompanyBenchmarkCampaign,
  type CompanyBenchmarkRouteV1,
} from "@recurs/contracts";

import {
  projectCompanyBenchmarkTrial,
  type CompanyBenchmarkRecorderSnapshot,
} from "../src/index.js";

const START = Date.parse("2026-07-24T00:01:00.000Z");

function route(
  role: CompanyBenchmarkRouteV1["role"],
): CompanyBenchmarkRouteV1 {
  return {
    role,
    providerId: "openai-codex-chatgpt",
    adapterId: "codex-app-server",
    connectionId: `connection-${role}`,
    modelId: role === "parent" ? "gpt-5.6-sol" : "gpt-5.6-terra",
    reasoningEffort: role === "parent" ? "high" : "medium",
  };
}

function campaign() {
  const baselineId = "baseline";
  const companyId = "company-balanced";
  return parseCompanyBenchmarkCampaign({
    id: "campaign-projection",
    version: 1,
    createdAt: "2026-07-24T00:00:00.000Z",
    scenario: {
      id: "alias_registry",
      version: 1,
      taskClass: "general_coding",
      difficulty: "medium",
      fixtureSha256: "a".repeat(64),
      verifierId: "alias_registry_hidden_v1",
      objectiveRevision: "alias_registry_objective_v1",
    },
    harnessRevision: "recurs-alpha",
    launchProtocolRevision: "company-benchmark-launch-v1",
    operatingModeId: "balanced_v6",
    operatingModeVersion: 6,
    permissionMode: "approved_for_me",
    repetitions: 1,
    ceilings: {
      maxTrialSlots: 2,
      maxRequests: 32,
      maxReportedCostUsd: 6,
    },
    blueprint: {
      id: "benchmark-blueprint",
      revision: 1,
      sha256: "b".repeat(64),
    },
    baseline: {
      id: baselineId,
      kind: "single_agent",
      configuredRoutes: [route("parent")],
    },
    companyArms: [{
      id: companyId,
      kind: "company",
      configuredRoutes: [
        route("parent"),
        route("implement"),
        route("review"),
        route("repair"),
      ],
    }],
    armOrder: [
      {
        slotId: companyBenchmarkTrialSlotId(baselineId, 1),
        armId: baselineId,
        repetition: 1,
      },
      {
        slotId: companyBenchmarkTrialSlotId(companyId, 1),
        armId: companyId,
        repetition: 1,
      },
    ],
  });
}

function snapshot(): CompanyBenchmarkRecorderSnapshot {
  const attempt = (
    role: "parent" | "implement" | "review" | "repair",
    sessionId: string,
    start: number,
    end: number,
    changedFiles: readonly string[] = [],
  ) => ({
    role,
    sessionId,
    startedAtMs: START + start,
    completedAtMs: START + end,
    status: "completed" as const,
    changedFiles,
    evidence: [`${role} evidence`],
  });
  const attempts = [
    attempt("parent", "parent", 0, 1_000),
    attempt("implement", "implement", 100, 400, ["src/alias-path.js"]),
    attempt("review", "review-1", 410, 500),
    attempt("review", "review-2", 505, 595),
    attempt("repair", "repair", 600, 740, ["src/alias-path.js"]),
    attempt("review", "review-3", 750, 840),
  ];
  return {
    attempts,
    requests: attempts.flatMap((observed, index) => {
      const count = observed.role === "parent" ? 2 : 1;
      return Array.from({ length: count }, (_, requestIndex) => ({
        role: observed.role,
        sessionId: observed.sessionId,
        startedAtMs: START + index * 10 + requestIndex,
        completedAtMs: START + index * 10 + requestIndex + 1,
        status: "completed" as const,
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          ...(observed.role === "parent"
            ? { cachedInputTokens: 4 }
            : {}),
        },
      }));
    }),
    interventions: {
      externalConfirmationRequests: 0,
      userInputRequests: 0,
      automaticApprovals: 3,
      automaticDenials: 0,
    },
  };
}

describe("projectCompanyBenchmarkTrial", () => {
  it("projects review, repair, usage, latency, and overlap from real runtime-shaped evidence", () => {
    const authority = campaign();
    const slot = authority.armOrder[1]!;
    const trial = projectCompanyBenchmarkTrial({
      campaign: authority,
      slot,
      startedAtMs: START,
      completedAtMs: START + 1_000,
      recorder: snapshot(),
      verification: {
        status: "passed",
        checks: [
          { id: "workspace_inventory", status: "passed" },
          { id: "git_state", status: "passed" },
          { id: "allowed_changes", status: "passed" },
          { id: "visible_tests", status: "passed" },
          { id: "hidden_alias_normalization", status: "passed" },
          { id: "hidden_registry_boundaries", status: "passed" },
          { id: "hidden_traversal_rejection", status: "passed" },
        ],
      },
      teamRuns: [{
        outcome: null,
        descriptor: {
          routes: authority.companyArms[0]!.configuredRoutes
            .filter((candidate) => candidate.role !== "parent")
            .map((candidate) => ({
              role: candidate.role as "implement" | "review" | "repair",
              pin: {
                providerId: candidate.providerId,
                adapterId: candidate.adapterId,
                connectionId: candidate.connectionId,
                modelId: candidate.modelId,
                ...(candidate.reasoningEffort === null
                  ? {}
                  : {
                      reasoningEffortAtCreation:
                        candidate.reasoningEffort,
                    }),
              },
            })),
        },
        reviews: [{
          round: 0,
          verdict: "changes_requested",
          findings: [{
            path: "src/alias-path.js",
            problem: "Traversal is not rejected.",
            acceptance: "Reject traversal above the alias root.",
            evidence: ["The hidden traversal case fails."],
          }],
          evidence: ["Inspected the staged candidate."],
          claimEpoch: 1,
        }, {
          round: 1,
          verdict: "approved",
          findings: [],
          evidence: ["The repaired candidate passes traversal checks."],
          claimEpoch: 1,
        }],
      }],
      executionStatus: "completed",
      finalEvidence: ["Parent synthesized the approved result."],
    });

    expect(trial.activatedRoutes.map((item) => item.role)).toEqual([
      "parent", "implement", "review", "repair",
    ]);
    expect(trial.review).toEqual({
      attempts: 2,
      approved: 1,
      changesRequested: 1,
      unverified: 0,
      finalVerdict: "approved",
      findings: 1,
      affectedPaths: ["src/alias-path.js"],
      evidenceItems: 2,
    });
    expect(trial.repairRounds).toBe(1);
    expect(trial.usage).toMatchObject({
      requestsUsed: 7,
      usageReports: 7,
      costReports: 0,
      tokenCoverage: "complete",
      costCoverage: "none",
      inputTokens: 70,
      outputTokens: 14,
      cachedInputTokens: null,
      reportedCostUsd: null,
    });
    expect(trial.roles.find((role) => role.role === "review")).toMatchObject({
      attempts: 3,
      wallClockMs: 430,
      attemptLatenciesMs: [90, 90, 90],
    });
    expect(trial.overlap).toEqual({
      metric: "changed_file_overlap_v1",
      implementOverlappingPaths: [],
      implementDuplicateClaims: 0,
      repairTouchedImplementationPaths: ["src/alias-path.js"],
    });
    expect(trial.verification).toMatchObject({
      status: "passed",
      workspaceIntegrity: "passed",
    });
  });

  it("preserves stable team failure diagnostics without raw failure prose", () => {
    const authority = campaign();
    const trial = projectCompanyBenchmarkTrial({
      campaign: authority,
      slot: authority.armOrder[1]!,
      startedAtMs: START,
      completedAtMs: START + 1_000,
      recorder: {
        ...snapshot(),
        attempts: snapshot().attempts.filter((attempt) =>
          attempt.role === "parent" || attempt.role === "implement"
        ),
        requests: snapshot().requests.filter((request) =>
          request.role === "parent" || request.role === "implement"
        ),
      },
      verification: {
        status: "failed",
        checks: [{ id: "workspace_inventory", status: "failed" }],
      },
      teamRuns: [{
        descriptor: {
          routes: authority.companyArms[0]!.configuredRoutes
            .filter((candidate) => candidate.role !== "parent")
            .map((candidate) => ({
              role: candidate.role as "implement" | "review" | "repair",
              pin: {
                providerId: candidate.providerId,
                adapterId: candidate.adapterId,
                connectionId: candidate.connectionId,
                modelId: candidate.modelId,
                ...(candidate.reasoningEffort === null
                  ? {}
                  : { reasoningEffortAtCreation: candidate.reasoningEffort }),
              },
            })),
        },
        reviews: [],
        outcome: {
          changedFiles: [],
          evidence: [],
          failure: {
            code: "patch_artifact_missing",
            message: "Implement worker 1 returned without a patch artifact at /private/tmp/secret",
          },
        },
      }],
      executionStatus: "failed",
      finalEvidence: [],
      failures: [{ stage: "execution", code: "company_goal_failed" }],
    });

    expect(trial.failures).toEqual([
      {
        stage: "execution",
        code: "company_goal_failed",
        scope: "roster_execution",
      },
      {
        stage: "execution",
        code: "patch_artifact_missing",
        scope: "roster_execution",
      },
      {
        stage: "verification",
        code: "scenario_verification_failed",
        scope: "verification",
        terminalStage: "verification",
      },
    ]);
    expect(JSON.stringify(trial)).not.toContain("/private/tmp/secret");
  });

  it("classifies a typed parent runtime outage separately from roster quality", () => {
    const authority = campaign();
    const parent = snapshot().attempts[0]!;
    const trial = projectCompanyBenchmarkTrial({
      campaign: authority,
      slot: authority.armOrder[1]!,
      startedAtMs: START,
      completedAtMs: START + 1_000,
      recorder: {
        attempts: [{ ...parent, status: "failed", evidence: [] }],
        requests: snapshot().requests
          .filter((request) => request.role === "parent")
          .map((request) => ({ ...request, status: "failed", usage: null })),
        interventions: {
          externalConfirmationRequests: 0,
          userInputRequests: 0,
          automaticApprovals: 0,
          automaticDenials: 0,
        },
      },
      verification: { status: "not_run", checks: [] },
      teamRuns: [],
      executionStatus: "failed",
      finalEvidence: [],
      failures: [{ stage: "execution", code: "coordinated_rate_limited" }],
    });

    expect(trial.failures).toEqual([{
      stage: "execution",
      code: "coordinated_rate_limited",
      scope: "runtime_execution",
      terminalStage: "parent",
    }]);
    expect(trial.activatedRoutes.map((item) => item.role)).toEqual(["parent"]);
    expect(trial.verification).toEqual({
      status: "not_run",
      workspaceIntegrity: "not_run",
      checks: [],
    });
  });

  it("preserves explicit synthesis evidence and omits an ambiguous parent stage", () => {
    const authority = campaign();
    const project = (terminalStage?: "synthesis") =>
      projectCompanyBenchmarkTrial({
        campaign: authority,
        slot: authority.armOrder[1]!,
        startedAtMs: START,
        completedAtMs: START + 1_000,
        recorder: snapshot(),
        verification: {
          status: "passed",
          checks: [
            { id: "workspace_inventory", status: "passed" },
            { id: "git_state", status: "passed" },
            { id: "allowed_changes", status: "passed" },
          ],
        },
        teamRuns: [{
          descriptor: {
            routes: authority.companyArms[0]!.configuredRoutes
              .filter((candidate) => candidate.role !== "parent")
              .map((candidate) => ({
                role: candidate.role as "implement" | "review" | "repair",
                pin: {
                  providerId: candidate.providerId,
                  adapterId: candidate.adapterId,
                  connectionId: candidate.connectionId,
                  modelId: candidate.modelId,
                  ...(candidate.reasoningEffort === null
                    ? {}
                    : { reasoningEffortAtCreation: candidate.reasoningEffort }),
                },
              })),
          },
          reviews: [],
          outcome: null,
        }],
        executionStatus: "failed",
        finalEvidence: [],
        failures: [{
          stage: "execution",
          code: "agent_provider_failed",
          ...(terminalStage === undefined ? {} : { terminalStage }),
        }],
      });

    expect(project().failures).toEqual([{
      stage: "execution",
      code: "agent_provider_failed",
      scope: "runtime_execution",
    }]);
    expect(project("synthesis").failures).toEqual([{
      stage: "execution",
      code: "agent_provider_failed",
      scope: "runtime_execution",
      terminalStage: "synthesis",
    }]);
    const runtimeBusy = projectCompanyBenchmarkTrial({
      campaign: authority,
      slot: authority.armOrder[0]!,
      startedAtMs: START,
      completedAtMs: START + 1_000,
      recorder: {
        attempts: [{ ...snapshot().attempts[0]!, status: "failed" }],
        requests: snapshot().requests.filter((request) =>
          request.role === "parent"
        ),
        interventions: snapshot().interventions,
      },
      verification: {
        status: "passed",
        checks: [
          { id: "workspace_inventory", status: "passed" },
          { id: "git_state", status: "passed" },
          { id: "allowed_changes", status: "passed" },
        ],
      },
      teamRuns: [],
      executionStatus: "failed",
      finalEvidence: [],
      failures: [{ stage: "execution", code: "runtime_busy" }],
    });
    expect(runtimeBusy.failures[0]).toMatchObject({
      scope: "runtime_execution",
      terminalStage: "parent",
    });
  });

  it("rejects request evidence that cannot be attributed to an activated attempt", () => {
    const authority = campaign();
    const original = snapshot();
    const recorder: CompanyBenchmarkRecorderSnapshot = {
      ...original,
      requests: original.requests.map((request, index) => index === 0
        ? { ...request, sessionId: "invented-session" }
        : request),
    };

    expect(() => projectCompanyBenchmarkTrial({
      campaign: authority,
      slot: authority.armOrder[1]!,
      startedAtMs: START,
      completedAtMs: START + 1_000,
      recorder,
      verification: {
        status: "failed",
        checks: [{ id: "workspace_inventory", status: "failed" }],
      },
      teamRuns: [],
      executionStatus: "failed",
      finalEvidence: [],
    })).toThrow("inconsistent");
  });
});
