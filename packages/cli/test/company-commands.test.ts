import { describe, expect, it, vi } from "vitest";

import {
  createHostInvocation,
  parseCompanyGoalRun,
  parseCompanyKnowledge,
  type CompanyAmendmentV1,
  type CompanyBlueprintV2,
} from "@recurs/contracts";
import {
  approveCompanyBlueprintV2,
  compileCompanyBlueprintV2,
  createRootAgentDescriptor,
  reduceSessionRecordsV2,
  type SessionRecord,
} from "@recurs/core";

import {
  createCommandRegistry,
  type CommandContext,
  type CompanyCommandDependencies,
} from "../src/index.js";
import { testBackendPin } from "../../../tests/support/backend.js";

const at = "2026-07-22T05:00:00.000Z";

function compileBlueprint(input: {
  readonly id: string;
  readonly revision: number;
  readonly previousBlueprintId: string | null;
}): CompanyBlueprintV2 {
  return compileCompanyBlueprintV2({
    id: input.id,
    companyId: "company-cli",
    revision: input.revision,
    previousBlueprintId: input.previousBlueprintId,
    createdAt: at,
    onboardingRunId: "onboarding-cli",
    onboardingDepth: "guided",
    generatedBy: "deterministic",
    designMode: "stable_core_specialists",
    project: {
      type: "existing_project",
      stage: "active",
      purpose: "Operate a bounded company from the CLI.",
      users: ["Maintainers"],
      successCriteria: ["Every mutation receives independent review."],
      constraints: ["Preserve authority boundaries."],
      risks: [],
      architecturePreferences: ["Reuse the durable runtime."],
      deploymentTargets: ["CLI"],
      repository: { inspected: false, markers: [], evidence: [] },
    },
    permissionMode: "approved_for_me",
    operatingModeId: "balanced_v6",
    availableToolBundles: [
      "project_context_v1", "source_control_v1", "architecture_v1",
      "implementation_v1", "quality_v1", "security_v1", "release_v1",
    ],
    initialGoal: "Ship one reviewed goal.",
    roadmap: ["Inspect company state."],
  });
}

function approvedBlueprint(): CompanyBlueprintV2 {
  return approveCompanyBlueprintV2(
    compileBlueprint({ id: "blueprint-cli-r1", revision: 1, previousBlueprintId: null }),
    at,
  );
}

function context(blueprint: CompanyBlueprintV2): CommandContext & {
  readonly records: SessionRecord[];
} {
  const pin = testBackendPin();
  const sessionId = "company-cli-session";
  const agent = createRootAgentDescriptor(
    sessionId,
    pin,
    "balanced_v6",
    "approved_for_me",
    "act",
    {
      blueprintId: blueprint.id,
      blueprintVersion: 2,
      blueprintRevision: blueprint.revision,
      roleId: blueprint.authorityAnchors.rootRoleId,
      roleVersion: 1,
    },
  );
  const commandContext: CommandContext & { readonly records: SessionRecord[] } = {
    session: reduceSessionRecordsV2([{
      version: 2,
      type: "session_created",
      sessionId,
      sequence: 0,
      at,
      cwd: "/workspace",
      backend: pin,
      agent,
    }]),
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
    },
  };
  return commandContext;
}

function dependencies(
  blueprint: CompanyBlueprintV2,
  overrides: Partial<CompanyCommandDependencies> = {},
): CompanyCommandDependencies {
  const planningRole = blueprint.roles.find((role) =>
    role.executionProfileId === "explore_v1"
  )!;
  const run = parseCompanyGoalRun({
    id: "company-run-cli",
    version: 1,
    parentSessionId: "company-cli-session",
    goalId: "goal-cli",
    objective: "Inspect the company CLI.",
    company: {
      blueprintId: blueprint.id,
      blueprintVersion: 2,
      blueprintRevision: blueprint.revision,
      roleId: blueprint.authorityAnchors.rootRoleId,
      roleVersion: 1,
    },
    status: "running",
    createdAt: at,
    updatedAt: at,
    plan: {
      revision: 1,
      createdAt: at,
      assignments: [{
        id: "planning-assignment",
        roleId: planningRole.id,
        parentAssignmentId: null,
        dependsOn: [],
        description: "Inspect command state.",
        prompt: "Return attributable evidence.",
        acceptance: ["Report the current state."],
        expectedEvidence: planningRole.expectedEvidence,
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
  const knowledge = parseCompanyKnowledge({
    companyId: blueprint.companyId,
    version: 1,
    revision: 1,
    updatedAt: at,
    entries: [{
      id: "knowledge-cli",
      kind: "project_fact",
      statement: "The CLI is the first client.",
      source: {
        type: "user",
        id: "message-cli",
        evidence: "The user selected CLI-first delivery.",
      },
      confidence: "high",
      createdAt: at,
      supersedes: null,
    }],
  });
  const proposed = compileBlueprint({
    id: "blueprint-cli-r2",
    revision: 2,
    previousBlueprintId: blueprint.id,
  });
  const amendment: CompanyAmendmentV1 = {
    id: "amendment-cli",
    version: 1,
    companyId: blueprint.companyId,
    baseBlueprintId: blueprint.id,
    baseBlueprintRevision: blueprint.revision,
    state: "proposed",
    createdAt: at,
    decidedAt: null,
    reason: "Add a release specialist for future goals.",
    proposedBlueprint: proposed,
    resultingBlueprintId: null,
    decisionReason: null,
  };
  return {
    blueprints: { async load() { return blueprint; } },
    goals: { async list() { return [{ sequence: 0, state: run }]; } },
    knowledge: { async latest() { return knowledge; } },
    amendments: { async list() { return [amendment]; } },
    ...overrides,
  };
}

describe("company slash command", () => {
  it("renders bounded status, YAML, activity, knowledge, and amendments", async () => {
    const blueprint = approvedBlueprint();
    const registry = createCommandRegistry({ company: dependencies(blueprint) });
    const active = context(blueprint);

    await expect(registry.execute("/company", active)).resolves.toMatchObject({
      type: "message",
      text: expect.stringContaining("Company: company-cli"),
    });
    await expect(registry.execute("/company blueprint", active)).resolves
      .toMatchObject({ text: expect.stringContaining("version: 2") });
    await expect(registry.execute("/company readiness", active)).resolves
      .toMatchObject({
        text: expect.stringMatching(
          /Company capability readiness[\s\S]*Agent Skills: not inspected/u,
        ),
      });
    await expect(registry.execute("/company activity", active)).resolves
      .toMatchObject({ text: expect.stringContaining("planning-assignment") });
    await expect(registry.execute("/company operations", active)).resolves
      .toMatchObject({
        text: expect.stringMatching(
          /Company operations[\s\S]*Current: running \| company-run-cli/u,
        ),
      });
    await expect(registry.execute("/company run company-run-cli", active)).resolves
      .toMatchObject({
        text: expect.stringMatching(
          /Goal: company-run-cli \| running[\s\S]*Assignments:/u,
        ),
      });
    await expect(registry.execute("/company run missing-run", active)).resolves
      .toMatchObject({
        level: "error",
        text: "Company goal run not found: missing-run",
      });
    await expect(registry.execute(
      "/company run company-run-cli extra",
      active,
    )).resolves.toMatchObject({ level: "error", text: expect.stringContaining("Usage") });
    await expect(registry.execute("/company knowledge", active)).resolves
      .toMatchObject({ text: expect.stringContaining("CLI is the first client") });
    await expect(registry.execute("/company amendments", active)).resolves
      .toMatchObject({ text: expect.stringContaining("amendment-cli") });
    await expect(registry.execute("/company amendment amendment-cli", active))
      .resolves.toMatchObject({
        text: expect.stringMatching(
          /Amendment: amendment-cli[\s\S]*Proposed: blueprint-cli-r2 \(revision 2\)[\s\S]*Changes:/u,
        ),
      });
    await expect(registry.execute("/company amendment missing", active))
      .resolves.toMatchObject({ level: "error", text: expect.stringContaining("not found") });
  });

  it("never exposes a goal run outside the active immutable company authority", async () => {
    const blueprint = approvedBlueprint();
    const baseDependencies = dependencies(blueprint);
    const own = (await baseDependencies.goals.list())[0]!;
    const foreign = {
      ...own,
      state: parseCompanyGoalRun({
        ...own.state,
        id: "foreign-company-run",
        parentSessionId: "different-parent-session",
        goalId: "foreign-goal",
      }),
    };
    const registry = createCommandRegistry({
      company: dependencies(blueprint, {
        goals: { async list() { return [foreign, own]; } },
      }),
    });
    const active = context(blueprint);

    const operations = await registry.execute("/company operations", active);
    expect(operations).toMatchObject({
      type: "message",
      text: expect.stringContaining("company-run-cli"),
    });
    expect(operations.type === "message" ? operations.text : "")
      .not.toContain("foreign-company-run");
    await expect(registry.execute(
      "/company run foreign-company-run",
      active,
    )).resolves.toMatchObject({
      level: "error",
      text: "Company goal run not found: foreign-company-run",
    });
  });

  it("fails closed for missing or stale company authority", async () => {
    const blueprint = approvedBlueprint();
    const registry = createCommandRegistry({ company: dependencies(blueprint) });
    const missing = context(blueprint);
    missing.session = { ...missing.session, agent: { ...missing.session.agent, company: undefined } };
    await expect(registry.execute("/company", missing)).resolves.toMatchObject({
      level: "error",
      text: expect.stringMatching(/No approved V2 company/iu),
    });

    const stale = context(blueprint);
    const staleRegistry = createCommandRegistry({
      company: dependencies({ ...blueprint, revision: 2 }),
    });
    await expect(staleRegistry.execute("/company", stale)).resolves.toMatchObject({
      level: "error",
      text: expect.stringMatching(/stale/iu),
    });
  });

  it("requires exact IDs, local consent, and delegates amendment decisions", async () => {
    const blueprint = approvedBlueprint();
    const approved = {
      ...dependencies(blueprint),
      decisions: {
        latest: vi.fn(async () => blueprint),
        approve: vi.fn(async () => ({
          amendment: {
            ...(await dependencies(blueprint).amendments.list())[0]!,
            state: "approved" as const,
            decidedAt: at,
            resultingBlueprintId: "blueprint-cli-r2",
            decisionReason: "Approved",
          },
          blueprint: approveCompanyBlueprintV2(
            compileBlueprint({
              id: "blueprint-cli-r2",
              revision: 2,
              previousBlueprintId: blueprint.id,
            }),
            at,
          ),
        })),
        reject: vi.fn(async () => ({
          amendment: {
            ...(await dependencies(blueprint).amendments.list())[0]!,
            state: "rejected" as const,
            decidedAt: at,
            resultingBlueprintId: null,
            decisionReason: "Rejected",
          },
        })),
      },
    } satisfies CompanyCommandDependencies;
    const registry = createCommandRegistry({ company: approved });
    const active = context(blueprint);

    await expect(registry.execute(
      "/company approve-amendment amendment-cli extra",
      active,
    )).resolves.toMatchObject({ level: "error", text: expect.stringContaining("Usage") });
    await expect(registry.execute(
      "/company approve-amendment amendment-cli",
      active,
    )).resolves.toMatchObject({ text: expect.stringContaining("revision 2") });
    expect(approved.decisions.approve).toHaveBeenCalledOnce();

    const unattended = context(blueprint);
    unattended.invocation = createHostInvocation({
      invocation: "one_shot",
      userPresent: false,
      remote: false,
      scripted: true,
      embedding: "cli",
    });
    await expect(registry.execute(
      "/company reject-amendment amendment-cli",
      unattended,
    )).resolves.toMatchObject({ level: "error", text: expect.stringContaining("local") });
    expect(approved.decisions.reject).not.toHaveBeenCalled();
  });

  it("requires local confirmation for exact capability bind and unbind commands", async () => {
    const blueprint = approvedBlueprint();
    const set = {
      companyId: blueprint.companyId,
      version: 1 as const,
      revision: 1,
      blueprintId: blueprint.id,
      blueprintRevision: blueprint.revision,
      updatedAt: at,
      bindings: [],
    };
    const capabilities = {
      bindings: vi.fn(() => null),
      bind: vi.fn(async () => set),
      unbind: vi.fn(async () => ({ ...set, revision: 2 })),
    };
    const registry = createCommandRegistry({
      company: dependencies(blueprint, { capabilities }),
    });
    const active = context(blueprint);

    await expect(registry.execute(
      "/company bind quality_v1 skill release-check",
      active,
    )).resolves.toMatchObject({
      text: "Company capability bindings updated to revision 1",
    });
    expect(capabilities.bind).toHaveBeenCalledWith(expect.objectContaining({
      blueprint,
      bundleId: "quality_v1",
      type: "agent_skill",
      sourceId: "release-check",
    }));
    await expect(registry.execute(
      "/company unbind capability-release-check",
      active,
    )).resolves.toMatchObject({
      text: "Company capability bindings updated to revision 2",
    });

    const unattended = context(blueprint);
    unattended.invocation = createHostInvocation({
      invocation: "one_shot",
      userPresent: false,
      remote: false,
      scripted: true,
      embedding: "cli",
    });
    await expect(registry.execute(
      "/company bind quality_v1 mcp issue-tracker",
      unattended,
    )).resolves.toMatchObject({ level: "error", text: expect.stringContaining("local") });
    expect(capabilities.bind).toHaveBeenCalledTimes(1);
  });
});
