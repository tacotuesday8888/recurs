import { describe, expect, it, vi } from "vitest";

import {
  createHostInvocation,
  parseCompanyGoalRun,
  type CompanyGoalRunV1,
} from "@recurs/contracts";
import {
  approveCompanyBlueprintV2,
  compileCompanyBlueprintV2,
  createRootAgentDescriptor,
  createSessionState,
  reduceSessionRecordsV2,
  type SessionRecord,
  type SessionState,
} from "@recurs/core";

import {
  createCommandRegistry,
  type CommandContext,
} from "../src/index.js";
import { testBackendPin } from "../../../tests/support/backend.js";

const at = "2026-07-22T05:30:00.000Z";

function companySession(): SessionState {
  const blueprint = approveCompanyBlueprintV2(compileCompanyBlueprintV2({
    id: "goal-command-blueprint",
    companyId: "goal-command-company",
    revision: 1,
    previousBlueprintId: null,
    createdAt: at,
    onboardingRunId: "goal-command-onboarding",
    onboardingDepth: "guided",
    generatedBy: "deterministic",
    designMode: "stable_core_specialists",
    project: {
      type: "existing_project",
      stage: "active",
      purpose: "Launch a company goal.",
      users: ["Maintainers"],
      successCriteria: ["The goal launches through the company supervisor."],
      constraints: [],
      risks: [],
      architecturePreferences: [],
      deploymentTargets: ["CLI"],
      repository: { inspected: false, markers: [], evidence: [] },
    },
    permissionMode: "approved_for_me",
    operatingModeId: "balanced_v6",
    availableToolBundles: [
      "project_context_v1", "source_control_v1", "architecture_v1",
      "implementation_v1", "quality_v1", "security_v1", "release_v1",
    ],
    initialGoal: "Launch safely.",
    roadmap: ["Launch the approved company goal."],
  }), at);
  const pin = testBackendPin();
  const sessionId = "goal-command-session";
  return reduceSessionRecordsV2([{
    version: 2,
    type: "session_created",
    sessionId,
    sequence: 0,
    at,
    cwd: "/workspace",
    backend: pin,
    agent: createRootAgentDescriptor(
      sessionId,
      pin,
      "balanced_v6",
      "approved_for_me",
      "act",
      {
        blueprintId: blueprint.id,
        blueprintVersion: 2,
        blueprintRevision: 1,
        roleId: blueprint.authorityAnchors.rootRoleId,
        roleVersion: 1,
      },
    ),
  }]);
}

function context(session: SessionState): CommandContext & {
  readonly records: SessionRecord[];
} {
  const commandContext: CommandContext & { readonly records: SessionRecord[] } = {
    session,
    invocation: createHostInvocation({
      invocation: "repl",
      userPresent: true,
      remote: false,
      scripted: false,
      embedding: "cli",
    }),
    records: [],
    now: () => at,
    confirm: vi.fn(async () => true),
    cancelActiveRun: vi.fn(async () => false),
    manageQueuedTurns: vi.fn(async () => ({
      type: "message" as const,
      level: "info" as const,
      text: "none",
    })),
    async applyRecord(record) {
      commandContext.records.push(record);
      if (record.type === "goal_updated") {
        commandContext.session = { ...commandContext.session, goal: record.goal };
      }
    },
  };
  return commandContext;
}

function companyRun(
  session: SessionState,
  status: CompanyGoalRunV1["status"],
  id = `goal-command-${status}`,
): CompanyGoalRunV1 {
  if (!("agent" in session) ||
    session.agent.company?.blueprintVersion !== 2) {
    throw new Error("Expected a V2 company session");
  }
  return parseCompanyGoalRun({
    id,
    version: 1,
    parentSessionId: session.id,
    goalId: `${id}-goal`,
    objective: "Launch safely.",
    company: session.agent.company,
    status,
    createdAt: at,
    updatedAt: at,
    plan: {
      revision: 1,
      createdAt: at,
      assignments: [{
        id: "goal-command-assignment",
        roleId: session.agent.company.roleId,
        parentAssignmentId: null,
        dependsOn: [],
        description: "Recover the existing company goal",
        prompt: "Return durable state.",
        acceptance: ["Do not duplicate execution."],
        expectedEvidence: ["Durable state."],
        status: "pending",
        result: null,
        failure: null,
      }],
    },
    budget: {
      maxAssignments: 8,
      assignmentsStarted: 0,
      maxConcurrentAssignments: 3,
      maxRequests: 80,
      requestsReserved: 0,
      requestsUsed: 0,
      maxReportedCostUsd: 3,
      reportedCostUsd: 0,
    },
    result: null,
    failure: null,
  });
}

describe("goal command company launch", () => {
  it("persists a V2 goal before submitting the bounded company launch prompt", async () => {
    const active = context(companySession());
    const result = await createCommandRegistry().execute(
      "/goal Ship the company CLI",
      active,
    );

    expect(active.session.goal).toMatchObject({
      objective: "Ship the company CLI",
      status: "active",
    });
    expect(active.records).toHaveLength(1);
    expect(result).toMatchObject({
      type: "submit_prompt",
      prompt: expect.stringContaining("delegate_company_goal"),
    });
    expect(result.type === "submit_prompt" ? result.prompt : "")
      .toContain(JSON.stringify("Ship the company CLI"));
    expect(result.type === "submit_prompt" ? result.prompt : "")
      .toContain("Run at most one accepted delegate_company_goal");
    expect(result.type === "submit_prompt" ? result.prompt : "")
      .toContain("correct the DAG and retry");
    expect(result.type === "submit_prompt" ? result.prompt : "")
      .toContain("the first tool call must be delegate_company_goal");
    expect(result.type === "submit_prompt" ? result.prompt : "")
      .toContain("Do not retry delegate_company_goal");
  });

  it.each([
    ["created", ["/company resume goal-command-created"]],
    ["running", [
      "/company run goal-command-running",
      "/company resume goal-command-running",
    ]],
    ["waiting_for_approval", [
      "/company run goal-command-waiting_for_approval",
    ]],
    ["interrupted", ["/company resume goal-command-interrupted"]],
  ] as const)(
    "refuses a model launch for an existing %s exact company run",
    async (status, commands) => {
      const session = companySession();
      const active = context({
        ...session,
        goal: {
          objective: "Launch safely.",
          status: "active",
          progress: "",
          blockers: [],
          evidence: [],
          createdAt: at,
          updatedAt: at,
        },
      });
      const existing = companyRun(active.session, status);
      const registry = createCommandRegistry({
        company: {
          goals: {
            async list() { return [{ sequence: 0, state: existing }]; },
          },
        } as never,
      });

      const result = await registry.execute("/goal Launch safely.", active);

      expect(result).toMatchObject({
        type: "message",
        level: "error",
      });
      for (const command of commands) {
        expect(result.type === "message" ? result.text : "")
          .toContain(command);
      }
      expect(active.records).toHaveLength(0);
    },
  );

  it("launches an already-approved initial goal without asking to replace it", async () => {
    const initial = context({
      ...companySession(),
      goal: {
        objective: "Launch safely.",
        status: "active",
        progress: "",
        blockers: [],
        evidence: [],
        createdAt: at,
        updatedAt: at,
      },
    });
    const result = await createCommandRegistry().execute(
      "/goal Launch safely.",
      initial,
    );

    expect(initial.confirm).not.toHaveBeenCalled();
    expect(initial.records).toHaveLength(0);
    expect(result).toMatchObject({
      type: "submit_prompt",
      prompt: expect.stringContaining(JSON.stringify("Launch safely.")),
    });
  });

  it("launches the active approved company goal without retyping it", async () => {
    const initial = context({
      ...companySession(),
      goal: {
        objective: "Launch safely.",
        status: "active",
        progress: "",
        blockers: [],
        evidence: [],
        createdAt: at,
        updatedAt: at,
      },
    });

    const result = await createCommandRegistry().execute(
      "/goal launch",
      initial,
    );

    expect(initial.confirm).not.toHaveBeenCalled();
    expect(initial.records).toHaveLength(0);
    expect(result).toMatchObject({
      type: "submit_prompt",
      prompt: expect.stringContaining(JSON.stringify("Launch safely.")),
    });
  });

  it("does not treat launch as an ordinary goal without an approved company", async () => {
    const ordinary = context(createSessionState({
      id: "ordinary-launch-session",
      cwd: "/workspace",
      model: "scripted",
    }));

    await expect(createCommandRegistry().execute(
      "/goal launch",
      ordinary,
    )).resolves.toMatchObject({
      type: "message",
      level: "error",
      text: "No active approved company goal is ready to launch",
    });
    expect(ordinary.records).toHaveLength(0);
  });

  it("retains ordinary goal behavior outside an approved V2 company", async () => {
    const ordinary = context(createSessionState({
      id: "ordinary-goal-session",
      cwd: "/workspace",
      model: "scripted",
    }));

    await expect(createCommandRegistry().execute(
      "/goal Ship the ordinary CLI",
      ordinary,
    )).resolves.toMatchObject({
      type: "message",
      text: "Goal set: Ship the ordinary CLI",
    });
  });

  it("retains the historical V1 company goal behavior", async () => {
    const pin = testBackendPin();
    const sessionId = "v1-company-goal-session";
    const v1 = context(reduceSessionRecordsV2([{
      version: 2,
      type: "session_created",
      sessionId,
      sequence: 0,
      at,
      cwd: "/workspace",
      backend: pin,
      agent: createRootAgentDescriptor(
        sessionId,
        pin,
        "balanced_v5",
        "approved_for_me",
        "act",
        {
          blueprintId: "v1-company-blueprint",
          blueprintVersion: 1,
          roleId: "orchestrator_v1",
          roleVersion: 1,
        },
      ),
    }]));

    await expect(createCommandRegistry().execute(
      "/goal Ship through the V1 company",
      v1,
    )).resolves.toMatchObject({
      type: "message",
      text: "Goal set: Ship through the V1 company",
    });
  });
});
