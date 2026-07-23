import { describe, expect, it, vi } from "vitest";

import { createHostInvocation } from "@recurs/contracts";
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
