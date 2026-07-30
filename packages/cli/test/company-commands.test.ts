import { describe, expect, it, vi } from "vitest";

import {
  createHostInvocation,
  parseCompanyGoalRun,
  parseCompanyKnowledge,
  parseTeamControlRecommendationV1,
  recommendedTeamControlPolicy,
  type CompanyAmendmentV1,
  type CompanyBlueprintV2,
  type CompanyGoalRunV1,
  type TeamControlRecommendationV1,
} from "@recurs/contracts";
import {
  approveCompanyBlueprintV2,
  COMPANY_GOAL_WORKTREE_PERMISSION,
  compileCompanyBlueprintV2,
  createRootAgentDescriptor,
  reduceSessionRecordsV2,
  TEAM_APPLY_PERMISSION,
  type SessionRecord,
} from "@recurs/core";
import { permissionIntentKey } from "@recurs/tools";

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
  readonly permissionMode?: "ask_always" | "approved_for_me" | "full_access";
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
    permissionMode: input.permissionMode ?? "approved_for_me",
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

function teamRecommendation(
  state: TeamControlRecommendationV1["state"] = "proposed",
): TeamControlRecommendationV1 {
  const proposed = {
    ...recommendedTeamControlPolicy("balanced_v6"),
    maxActiveAgents: 4,
    maxRequests: 30,
  };
  return parseTeamControlRecommendationV1({
    id: "recommendation-cli",
    version: 1,
    state,
    operatingModeId: "balanced_v6",
    operatingModeVersion: 6,
    blueprintId: "blueprint-cli-r1",
    blueprintRevision: 1,
    basePolicyRevision: null,
    createdAt: "2026-07-22T04:00:00.000Z",
    decidedAt: state === "proposed" ? null : at,
    reason: "Observed usage only across two compatible completed goals.",
    supportingRuns: [{
      runId: "run-evidence-1",
      completedAt: "2026-07-22T03:00:00.000Z",
      assignmentsStarted: 3,
      requestsUsed: 20,
      reportedCostUsd: 0.4,
    }, {
      runId: "run-evidence-2",
      completedAt: "2026-07-22T03:30:00.000Z",
      assignmentsStarted: 4,
      requestsUsed: 24,
      reportedCostUsd: null,
    }],
    proposedPolicy: proposed,
    appliedPolicyRevision: state === "approved" ? proposed.revision : null,
    decisionReason: state === "proposed" ? null : `${state} in test`,
  });
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
    blueprint.authority.permissionMode,
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
  it("resumes one exact interrupted run with explicit authority and renders reloaded state", async () => {
    const blueprint = approvedBlueprint();
    const base = dependencies(blueprint);
    let current: CompanyGoalRunV1 = {
      ...(await base.goals.list())[0]!.state,
      status: "interrupted",
    };
    const capabilityPolicy = {
      agentSkillNames: ["company-recovery-skill"],
      mcpServerIds: ["company-recovery-mcp"],
    };
    const resume = vi.fn(async () => {
      current = {
        ...current,
        status: "completed",
        result: {
          summary: "Recovered the durable company goal.",
          evidence: ["durable child evidence"],
        },
      };
      return {
        output: current.result.summary,
        metadata: { goalRunId: current.id, status: current.status },
      };
    });
    const capabilities = {
      bindings: vi.fn(() => null),
      bind: vi.fn(),
      unbind: vi.fn(),
      policyForAgent: vi.fn(() => capabilityPolicy),
    };
    const registry = createCommandRegistry({
      company: {
        ...base,
        goals: { async list() { return [{ sequence: 2, state: current }]; } },
        capabilities,
        recovery: { resume },
      },
      signal: () => new AbortController().signal,
    });
    const active = context(blueprint);

    const result = await registry.execute(
      "/company resume company-run-cli",
      active,
    );

    expect(active.confirm).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    const toolContext = resume.mock.calls[0]![1] as {
      readonly sessionId: string;
      readonly cwd: string;
      readonly executionMode: string;
      readonly approvedIntents?: Set<string>;
      readonly companyCapabilities?: typeof capabilityPolicy;
      readonly delegationBudget?: { readonly maxChildren: number };
    };
    expect(toolContext).toMatchObject({
      sessionId: active.session.id,
      cwd: active.session.cwd,
      executionMode: "act",
      companyCapabilities: capabilityPolicy,
      delegationBudget: { maxChildren: 8 },
    });
    expect(toolContext.approvedIntents).toEqual(new Set([
      permissionIntentKey(TEAM_APPLY_PERMISSION),
      permissionIntentKey(COMPANY_GOAL_WORKTREE_PERMISSION),
    ]));
    expect(result).toMatchObject({
      type: "message",
      text: expect.stringMatching(
        /Goal: company-run-cli \| completed[\s\S]*Result: Recovered the durable company goal/u,
      ),
    });
  });

  it("uses Full Access without confirmation for an idempotent completed resume", async () => {
    const blueprint = approveCompanyBlueprintV2(compileBlueprint({
      id: "blueprint-full-access",
      revision: 1,
      previousBlueprintId: null,
      permissionMode: "full_access",
    }), at);
    const base = dependencies(blueprint);
    const completed = {
      ...(await base.goals.list())[0]!.state,
      status: "completed" as const,
      result: {
        summary: "The durable goal was already complete.",
        evidence: ["durable completion evidence"],
      },
    };
    const resume = vi.fn(async () => ({
      output: completed.result.summary,
      metadata: { goalRunId: completed.id, status: completed.status },
    }));
    const registry = createCommandRegistry({
      company: {
        ...base,
        goals: { async list() { return [{ sequence: 1, state: completed }]; } },
        recovery: { resume },
      },
    });
    const active = context(blueprint);

    const result = await registry.execute(
      "/company resume company-run-cli",
      active,
    );

    expect(active.confirm).not.toHaveBeenCalled();
    expect(resume).toHaveBeenCalledOnce();
    expect("approvedIntents" in (resume.mock.calls[0]![1] as object)).toBe(false);
    expect(result).toMatchObject({
      text: expect.stringMatching(
        /Goal: company-run-cli \| completed[\s\S]*already complete/u,
      ),
    });
  });

  it.each([
    ["Plan", (active: CommandContext) => {
      active.session = { ...active.session, executionMode: "plan" };
    }],
    ["remote", (active: CommandContext) => {
      active.invocation = createHostInvocation({
        invocation: "repl",
        userPresent: true,
        remote: true,
        scripted: false,
        embedding: "cli",
      });
    }],
    ["automated", (active: CommandContext) => {
      active.invocation = createHostInvocation({
        invocation: "repl",
        userPresent: true,
        remote: false,
        scripted: true,
        embedding: "cli",
      });
    }],
    ["unattended", (active: CommandContext) => {
      active.invocation = createHostInvocation({
        invocation: "one_shot",
        userPresent: false,
        remote: false,
        scripted: false,
        embedding: "cli",
      });
    }],
  ] as const)(
    "rejects %s company recovery before confirmation or execution",
    async (_label, mutate) => {
      const blueprint = approvedBlueprint();
      const base = dependencies(blueprint);
      const interrupted = {
        ...(await base.goals.list())[0]!.state,
        status: "interrupted" as const,
      };
      const resume = vi.fn();
      const registry = createCommandRegistry({
        company: {
          ...base,
          goals: {
            async list() { return [{ sequence: 1, state: interrupted }]; },
          },
          recovery: { resume },
        },
      });
      const active = context(blueprint);
      mutate(active);

      await expect(registry.execute(
        "/company resume company-run-cli",
        active,
      )).resolves.toMatchObject({
        level: "error",
        text: expect.stringMatching(/local|manual|user-present|Act/iu),
      });
      expect(active.confirm).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown, foreign, waiting, and inexact resume IDs without recovery", async () => {
    const blueprint = approvedBlueprint();
    const base = dependencies(blueprint);
    const own = (await base.goals.list())[0]!;
    const foreign = {
      ...own,
      state: {
        ...own.state,
        id: "foreign-resume-run",
        parentSessionId: "foreign-parent",
      },
    };
    const waiting = {
      ...own,
      state: {
        ...own.state,
        id: "waiting-resume-run",
        status: "waiting_for_approval" as const,
      },
    };
    const resume = vi.fn();
    const registry = createCommandRegistry({
      company: {
        ...base,
        goals: { async list() { return [foreign, waiting, own]; } },
        recovery: { resume },
      },
    });
    const active = context(blueprint);

    for (const command of [
      "/company resume missing-run",
      "/company resume foreign-resume-run",
      "/company resume waiting-resume-run",
      "/company resume company-run-cli extra",
    ]) {
      await expect(registry.execute(command, active)).resolves.toMatchObject({
        level: "error",
      });
    }
    expect(active.confirm).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("renders a durable failed result as an error when recovery resolves normally", async () => {
    const blueprint = approvedBlueprint();
    const base = dependencies(blueprint);
    let current: CompanyGoalRunV1 = {
      ...(await base.goals.list())[0]!.state,
      status: "interrupted",
    };
    const registry = createCommandRegistry({
      company: {
        ...base,
        goals: { async list() { return [{ sequence: 3, state: current }]; } },
        recovery: {
          async resume() {
            current = {
              ...current,
              status: "failed",
              failure: "Durable review failed",
            };
            return {
              output: "Company goal reached a terminal failure",
              metadata: {
                goalRunId: current.id,
                status: "failed",
              },
            };
          },
        },
      },
    });
    const active = context(blueprint);

    await expect(registry.execute(
      "/company resume company-run-cli",
      active,
    )).resolves.toMatchObject({
      level: "error",
      text: expect.stringMatching(
        /Goal: company-run-cli \| failed[\s\S]*Failure: Durable review failed/u,
      ),
    });
  });

  it("renders bounded status, YAML, activity, knowledge, and amendments", async () => {
    const blueprint = approvedBlueprint();
    const registry = createCommandRegistry({ company: dependencies(blueprint) });
    const active = context(blueprint);

    await expect(registry.execute("/company", active)).resolves.toMatchObject({
      type: "message",
      text: expect.stringMatching(
        /Company: company-cli[\s\S]*Goal runs: 1 total, 1 unresolved/u,
      ),
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

  it("shows evidence and requires local confirmation for future team controls", async () => {
    const blueprint = approvedBlueprint();
    const recommendation = teamRecommendation();
    const recommendations = {
      list: vi.fn(async () => [recommendation]),
    };
    const recommendationDecisions = {
      approve: vi.fn(async () => teamRecommendation("approved")),
      reject: vi.fn(async () => teamRecommendation("rejected")),
    };
    const registry = createCommandRegistry({
      company: dependencies(blueprint, {
        recommendations,
        recommendationDecisions,
      }),
    });
    const active = context(blueprint);

    await expect(registry.execute("/company recommendations", active))
      .resolves.toMatchObject({
        text: expect.stringMatching(
          /recommendation-cli[\s\S]*2 runs[\s\S]*Observed usage only/iu,
        ),
      });
    await expect(registry.execute(
      "/company recommendation recommendation-cli",
      active,
    )).resolves.toMatchObject({
      text: expect.stringMatching(
        /run-evidence-1[\s\S]*cost unknown[\s\S]*future goals/iu,
      ),
    });
    await expect(registry.execute(
      "/company approve-recommendation recommendation-cli",
      active,
    )).resolves.toMatchObject({
      text: expect.stringContaining("policy revision 1"),
    });
    expect(recommendationDecisions.approve).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: "/workspace",
        recommendationId: "recommendation-cli",
      }),
    );

    const unattended = context(blueprint);
    unattended.invocation = createHostInvocation({
      invocation: "one_shot",
      userPresent: false,
      remote: false,
      scripted: true,
      embedding: "cli",
    });
    await expect(registry.execute(
      "/company reject-recommendation recommendation-cli",
      unattended,
    )).resolves.toMatchObject({
      level: "error",
      text: expect.stringContaining("local"),
    });
    expect(recommendationDecisions.reject).not.toHaveBeenCalled();
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
