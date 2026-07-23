import { createHash } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  parseCompanyGoalRun,
  type CompanyBlueprintV2,
  type CompanyGoalRunV1,
} from "@recurs/contracts";
import {
  approveCompanyBlueprintV2,
  compileCompanyBlueprintV2,
  createRootAgentDescriptor,
  FileCompanyBlueprintV2Store,
  JsonlCompanyGoalStore,
  JsonlSessionStore,
} from "@recurs/core";
import { afterEach, describe, expect, it } from "vitest";

import { testBackendPin } from "../../../tests/support/backend.js";
import { evaluateStoredCompanyGoal } from "../src/company-evaluation-store.js";

const AT = "2026-07-22T02:00:00.000Z";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function temporaryRoot(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-company-store-eval-")),
  );
  roots.push(root);
  return root;
}

function blueprint(): CompanyBlueprintV2 {
  return approveCompanyBlueprintV2(compileCompanyBlueprintV2({
    id: "blueprint-store-evaluation",
    companyId: "company-store-evaluation",
    revision: 1,
    previousBlueprintId: null,
    createdAt: AT,
    onboardingRunId: "onboarding-store-evaluation",
    onboardingDepth: "guided",
    generatedBy: "deterministic",
    designMode: "stable_core_specialists",
    project: {
      type: "existing_project",
      stage: "active",
      purpose: "Score one durable company goal without changing its project state.",
      users: ["Maintainers"],
      successCriteria: ["Every completed goal has independent review evidence."],
      constraints: ["Evaluation is strictly read-only."],
      risks: [],
      architecturePreferences: ["Reuse strict private stores."],
      deploymentTargets: ["CLI"],
      repository: { inspected: true, markers: ["package.json"], evidence: [] },
    },
    permissionMode: "approved_for_me",
    operatingModeId: "balanced_v6",
    initialGoal: "Complete and independently review one bounded goal.",
    roadmap: ["Score the durable result."],
  }), "2026-07-22T02:00:01.000Z");
}

function completedRun(company: CompanyBlueprintV2): CompanyGoalRunV1 {
  const worker = company.roles.find((role) => role.kind === "worker")!;
  const reviewer = company.roles.find((role) => role.kind === "reviewer")!;
  const result = (summary: string, evidence: string) => ({
    summary,
    evidence: [evidence],
    usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.01 },
    usageSource: "provider" as const,
  });
  return parseCompanyGoalRun({
    id: "run-store-evaluation",
    version: 1,
    parentSessionId: "session-store-evaluation",
    goalId: "goal-store-evaluation",
    objective: "Deliver one bounded, independently reviewed result.",
    company: {
      blueprintId: company.id,
      blueprintVersion: 2,
      blueprintRevision: company.revision,
      roleId: company.authorityAnchors.rootRoleId,
      roleVersion: 1,
    },
    status: "completed",
    createdAt: "2026-07-22T02:00:02.000Z",
    updatedAt: "2026-07-22T02:00:04.000Z",
    plan: {
      revision: 1,
      createdAt: "2026-07-22T02:00:02.000Z",
      assignments: [{
        id: "implementation-assignment",
        roleId: worker.id,
        parentAssignmentId: null,
        dependsOn: [],
        description: "Implement the bounded result.",
        prompt: "Implement and verify the result.",
        acceptance: ["Return verification evidence."],
        expectedEvidence: worker.expectedEvidence,
        status: "completed",
        result: result("Implementation completed.", "verification:passed"),
        failure: null,
      }, {
        id: "review-assignment",
        roleId: reviewer.id,
        parentAssignmentId: null,
        dependsOn: ["implementation-assignment"],
        description: "Review the complete result independently.",
        prompt: "Review the implementation and its evidence.",
        acceptance: ["Approve or return findings."],
        expectedEvidence: reviewer.expectedEvidence,
        status: "completed",
        result: result("Independent review approved.", "review:approved"),
        failure: null,
      }],
    },
    budget: {
      maxAssignments: 8,
      assignmentsStarted: 2,
      maxConcurrentAssignments: 3,
      maxRequests: 80,
      requestsReserved: 8,
      requestsUsed: 2,
      maxReportedCostUsd: 3,
      reportedCostUsd: 0.02,
    },
    result: {
      summary: "Implementation and independent review completed.",
      evidence: ["verification:passed", "review:approved"],
    },
    failure: null,
  });
}

async function fixture(runOverride?: (run: CompanyGoalRunV1) => CompanyGoalRunV1) {
  const projectRoot = await temporaryRoot();
  const dataDirectory = await temporaryRoot();
  const projectId = createHash("sha256").update(projectRoot).digest("hex").slice(0, 24);
  const projectData = path.join(dataDirectory, "projects", projectId);
  const company = blueprint();
  const run = runOverride?.(completedRun(company)) ?? completedRun(company);
  await new FileCompanyBlueprintV2Store(
    path.join(projectData, "company-blueprints-v2"),
  ).create(company);
  await new JsonlCompanyGoalStore(path.join(projectData, "company-goals"))
    .create(run);
  const pin = {
    ...testBackendPin("stored-model"),
    providerId: "stored-provider",
  };
  await new JsonlSessionStore(path.join(projectData, "sessions"))
    .createPinnedSession({
      id: run.parentSessionId,
      cwd: projectRoot,
      backend: pin,
      agent: createRootAgentDescriptor(
        run.parentSessionId,
        pin,
        "balanced_v6",
        "approved_for_me",
        "act",
        run.company,
      ),
      at: run.createdAt,
    });
  return { projectRoot, dataDirectory, projectData, company, run };
}

async function snapshot(directory: string): Promise<ReadonlyMap<string, string>> {
  const files = (await readdir(directory, { recursive: true }))
    .filter((entry) => typeof entry === "string")
    .sort();
  const result = new Map<string, string>();
  for (const file of files) {
    try {
      result.set(file, await readFile(path.join(directory, file), "utf8"));
    } catch {
      // Directories are intentionally omitted from the byte snapshot.
    }
  }
  return result;
}

describe("stored company goal evaluation", () => {
  it("scores the exact durable run through its pinned backend without mutation", async () => {
    const setup = await fixture();
    const before = await snapshot(setup.projectData);
    const progress: unknown[] = [];

    const report = await evaluateStoredCompanyGoal({
      dataDirectory: setup.dataDirectory,
      projectRoot: setup.projectRoot,
      runId: setup.run.id,
      now: () => "2026-07-22T02:00:05.000Z",
      async onProgress(event) { progress.push(event); },
    });

    expect(report).toMatchObject({
      scenarioId: "company_goal_execution_v1",
      mode: "configured",
      status: "passed",
      backend: { providerId: "stored-provider", modelId: "stored-model" },
      usage: { requestsUsed: 2, reportedCostUsd: 0.02 },
    });
    expect(await snapshot(setup.projectData)).toEqual(before);
    expect(progress).toEqual([
      {
        phase: "preparing",
        message: "Preparing company_goal_execution_v1.",
      },
      { phase: "scoring", message: "Scoring company_goal_execution_v1." },
    ]);
  });

  it("reports incomplete and unknown-cost runs truthfully", async () => {
    const setup = await fixture((run) => parseCompanyGoalRun({
      ...run,
      status: "failed",
      result: null,
      failure: "The bounded goal failed.",
      plan: {
        ...run.plan,
        assignments: run.plan.assignments.map((assignment) => ({
          ...assignment,
          result: assignment.id === "implementation-assignment"
            ? { ...assignment.result!, usage: null, usageSource: "unknown" }
            : assignment.result,
        })),
      },
    }));

    const report = await evaluateStoredCompanyGoal({
      dataDirectory: setup.dataDirectory,
      projectRoot: setup.projectRoot,
      runId: setup.run.id,
    });

    expect(report).toMatchObject({
      status: "failed",
      usage: { reportedCostUsd: null, source: "unknown" },
      failures: [{ code: "execution_failed" }],
    });
  });

  it("fails safely for a missing run and mismatched blueprint revision", async () => {
    const setup = await fixture();
    await expect(evaluateStoredCompanyGoal({
      dataDirectory: setup.dataDirectory,
      projectRoot: setup.projectRoot,
      runId: "missing-run",
    })).rejects.toThrow("The selected durable company goal could not be read.");

    const mismatch = await fixture((run) => ({
      ...run,
      company: { ...run.company, blueprintRevision: run.company.blueprintRevision + 1 },
    }));
    const report = await evaluateStoredCompanyGoal({
      dataDirectory: mismatch.dataDirectory,
      projectRoot: mismatch.projectRoot,
      runId: mismatch.run.id,
    });
    expect(report).toMatchObject({
      status: "failed",
      failures: [{ code: "evaluation_failed" }],
    });
  });

  it("does not repair or rewrite corrupt durable state while evaluating", async () => {
    const setup = await fixture();
    const goalFile = path.join(
      setup.projectData,
      "company-goals",
      `${setup.run.id}.jsonl`,
    );
    await appendFile(goalFile, "{\"partial\":", "utf8");
    const before = await snapshot(setup.projectData);

    await expect(evaluateStoredCompanyGoal({
      dataDirectory: setup.dataDirectory,
      projectRoot: setup.projectRoot,
      runId: setup.run.id,
    })).rejects.toThrow("The selected durable company goal could not be read.");
    expect(await snapshot(setup.projectData)).toEqual(before);
  });

  it("rejects legacy parent sessions and propagates cancellation", async () => {
    const setup = await fixture();
    const sessions = path.join(setup.projectData, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      path.join(sessions, `${setup.run.parentSessionId}.jsonl`),
      `${JSON.stringify({
        version: 1,
        type: "session_created",
        sessionId: setup.run.parentSessionId,
        at: setup.run.createdAt,
        cwd: setup.projectRoot,
        model: "legacy-model",
      })}\n`,
      "utf8",
    );

    await expect(evaluateStoredCompanyGoal({
      dataDirectory: setup.dataDirectory,
      projectRoot: setup.projectRoot,
      runId: setup.run.id,
    })).rejects.toThrow(
      "The durable company goal parent session is not a pinned V2 session.",
    );

    const controller = new AbortController();
    controller.abort();
    await expect(evaluateStoredCompanyGoal({
      dataDirectory: setup.dataDirectory,
      projectRoot: setup.projectRoot,
      runId: setup.run.id,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});
