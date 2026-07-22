import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createHostInvocation,
  deriveTrustedRunContext,
  type CoordinatedRunInput,
  type RunCoordinator,
} from "@recurs/contracts";
import { ToolError, type ToolContext } from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  approveCompanyBlueprintV2,
  ChildAgentManager,
  CompanyGoalSupervisor,
  CompanyLearningService,
  compileCompanyBlueprintV2,
  createDelegationBudget,
  createRootAgentDescriptor,
  delegationWorkflowUsage,
  FileCompanyBlueprintV2Store,
  FileCompanyKnowledgeStore,
  JsonlCompanyGoalStore,
  JsonlSessionStore,
  type CompanyGoalAssignmentExecutor,
  type DelegateCompanyGoalInput,
  type RecursEvent,
} from "../src/index.js";
import { testAt, testBackendPin } from "../../../tests/support/backend.js";

const directories: string[] = [];
const trusted = deriveTrustedRunContext(createHostInvocation({
  invocation: "repl",
  userPresent: true,
  remote: false,
  scripted: false,
  embedding: "cli",
}));

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function organization(implementation = false) {
  const common = {
    departmentKey: "delivery",
    permissionMode: "approved_for_me" as const,
    toolBundles: ["project_context_v1" as const],
    activation: "always" as const,
  };
  return {
    departments: [{
      key: "delivery",
      displayName: "Delivery",
      purpose: "Plan and independently review bounded delivery.",
    }],
    roles: [{
      ...common,
      key: "orchestrator",
      displayName: "Orchestrator",
      kind: "orchestrator" as const,
      responsibility: "Own the goal and shared budget.",
      instructions: "Delegate only through the approved company graph.",
      reportsToKey: null,
      capabilities: ["plan" as const],
      executionProfileId: null,
      expectedEvidence: ["A goal synthesis."],
    }, {
      ...common,
      key: "lead",
      displayName: "Planning Lead",
      kind: "lead" as const,
      responsibility: "Create one bounded technical handoff.",
      instructions: "Inspect the project and return concrete evidence.",
      reportsToKey: "orchestrator",
      capabilities: ["plan" as const, "research" as const],
      executionProfileId: "explore_v1" as const,
      expectedEvidence: ["Relevant project paths."],
    }, {
      ...common,
      key: "worker",
      displayName: implementation ? "Implementation Worker" : "Research Worker",
      kind: "worker" as const,
      responsibility: implementation
        ? "Implement and repair one bounded change."
        : "Investigate the assigned implementation seam.",
      instructions: implementation
        ? "Work only in the isolated team workspace."
        : "Stay read-only and cite the inspected code.",
      reportsToKey: "lead",
      capabilities: implementation
        ? ["implement" as const, "repair" as const]
        : ["research" as const],
      executionProfileId: implementation
        ? "implement_v2" as const
        : "explore_v1" as const,
      toolBundles: implementation
        ? ["implementation_v1" as const, "project_context_v1" as const]
        : ["project_context_v1" as const],
      expectedEvidence: [implementation
        ? "A verified implementation patch."
        : "A cited implementation seam."],
    }, {
      ...common,
      key: "reviewer",
      displayName: "Independent Reviewer",
      kind: "reviewer" as const,
      responsibility: "Review every company handoff independently.",
      instructions: "Approve only when the evidence supports the result.",
      reportsToKey: "orchestrator",
      capabilities: ["review" as const],
      executionProfileId: "review_v2" as const,
      permissionMode: "ask_always" as const,
      toolBundles: ["quality_v1" as const],
      expectedEvidence: ["Evidence-backed approval or findings."],
    }],
    rootRoleKey: "orchestrator",
    independentReviewRoleKeys: ["reviewer"],
    defaultActiveRoleKeys: ["orchestrator", "lead", "worker", "reviewer"],
  };
}

async function fixture(options: {
  readonly workResult?: "success" | "failure" | "cancelled" | "cost" | "unknown";
  readonly nestedHandoffIds?: readonly string[];
  readonly implementation?: boolean;
  readonly teamStatus?: "approved" | "failed" | "cancelled" | "interrupted";
  readonly teamStatuses?: readonly (
    "approved" | "failed" | "cancelled" | "interrupted"
  )[];
  readonly learning?: boolean;
  readonly learningFailure?: "select" | "record";
} = {}) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-company-goal-")),
  );
  directories.push(root);
  const sessions = new JsonlSessionStore(path.join(root, "sessions"));
  const blueprints = new FileCompanyBlueprintV2Store(path.join(root, "blueprints"));
  const runs = new JsonlCompanyGoalStore(path.join(root, "goals"));
  const knowledge = new FileCompanyKnowledgeStore(path.join(root, "knowledge"));
  const learning = new CompanyLearningService({ store: knowledge });
  const blueprint = approveCompanyBlueprintV2(compileCompanyBlueprintV2({
    id: "blueprint-1",
    companyId: "company-1",
    revision: 1,
    previousBlueprintId: null,
    createdAt: testAt,
    onboardingRunId: "onboarding-1",
    onboardingDepth: "guided",
    generatedBy: "deterministic",
    designMode: "guardrailed_dynamic",
    project: {
      type: "existing_project",
      stage: "active",
      purpose: "Prove a bounded multi-role company handoff.",
      users: ["Maintainers"],
      successCriteria: ["Every result has independent evidence."],
      constraints: ["No permission escalation."],
      risks: [],
      architecturePreferences: ["Reuse the pinned child runtime."],
      deploymentTargets: ["CLI"],
      repository: {
        inspected: true,
        markers: [".git", "package.json"],
        evidence: [{ path: "package.json", finding: "TypeScript workspace." }],
      },
    },
    permissionMode: "approved_for_me",
    operatingModeId: "balanced_v6",
    organization: organization(options.implementation === true),
    availableToolBundles: [
      "project_context_v1", "quality_v1", "implementation_v1",
    ],
    initialGoal: "Complete a reviewed company handoff.",
    roadmap: ["Run the first company goal."],
  }), "2026-07-22T00:00:01.000Z");
  await blueprints.create(blueprint);
  if (options.learning === true) {
    for (const [index, statement] of [
      "The company runtime is a TypeScript workspace.",
      "Planning work should order dependencies before delegation.",
      "Investigate assigned seams before implementation.",
    ].entries()) {
      await learning.recordCompanyKnowledge({
        companyId: blueprint.companyId,
        kind: index === 0 ? "project_fact" : "successful_pattern",
        statement,
        source: {
          type: "repository",
          id: `company-evidence-${index}`,
          evidence: `Repository evidence ${index}.`,
        },
        confidence: "high",
        createdAt: `2026-07-09T00:0${index}:00.000Z`,
        supersedes: null,
      });
    }
  }
  const roles = Object.fromEntries(blueprint.roles.map((role) => [
    role.displayName,
    role,
  ]));
  const pin = testBackendPin();
  const parent = await sessions.createPinnedSession({
    id: "parent-session",
    cwd: root,
    backend: pin,
    at: testAt,
    agent: createRootAgentDescriptor(
      "parent-session",
      pin,
      blueprint.authority.operatingModeId,
      blueprint.authority.permissionMode,
      "act",
      {
        blueprintId: blueprint.id,
        blueprintVersion: 2,
        blueprintRevision: blueprint.revision,
        roleId: blueprint.authorityAnchors.rootRoleId,
        roleVersion: 1,
      },
    ),
  });
  const supervisorReference: { current?: CompanyGoalSupervisor } = {};
  const prompts: string[] = [];
  const coordinator: RunCoordinator = {
    async start(input: CoordinatedRunInput) {
      prompts.push(input.prompt);
      const child = await sessions.loadState(input.sessionId);
      const roleId = child.version === 2 ? child.agent.company?.roleId : "unknown";
      if (options.nestedHandoffIds !== undefined &&
        roleId === roles["Planning Lead"]!.id) {
        const results = await Promise.allSettled(options.nestedHandoffIds.map(
          (assignmentId) => supervisorReference.current!.requestHandoff({
            runId: "company-run-id-1",
            assignmentId,
          }, {
            sessionId: child.id,
            cwd: child.cwd,
            executionMode: child.executionMode,
            signal: input.signal,
            readRevisions: new Map(),
            runContext: trusted,
            delegationBudget: createDelegationBudget(child.agent),
          })
        ));
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
      const result = {
        finalText: `completed ${String(roleId)}`,
        usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.01 },
        usageSource: "provider" as const,
        steps: 1,
        changedFiles: [] as string[],
        changedFilesSource: "none" as const,
        evidence: [`evidence from ${String(roleId)}`],
        evidenceSource: "host_tools" as const,
      };
      await sessions.withSessionMutation(
        input.sessionId,
        input.expectedSessionRecordSequence,
        async (lease) => {
          await lease.append({
            type: "turn_started",
            turnId: `turn-${input.sessionId}`,
            prompt: input.prompt,
            at: testAt,
          });
          await lease.append({
            type: "model_completed",
            turnId: `turn-${input.sessionId}`,
            message: {
              id: `message-${input.sessionId}`,
              role: "assistant",
              content: result.finalText,
              toolCalls: [],
            },
            usage: result.usage,
            stopReason: "complete",
            at: testAt,
          });
          await lease.append({
            type: "turn_completed",
            turnId: `turn-${input.sessionId}`,
            result,
            at: testAt,
          });
        },
      );
      return {
        events: { async *[Symbol.asyncIterator]() {} },
        outcome: Promise.resolve({ ok: true as const, result }),
      };
    },
  };
  const events: RecursEvent[] = [];
  let childIndex = 0;
  const children = new ChildAgentManager({
    sessions,
    getCoordinator: () => coordinator,
    async emit(event) { events.push(event); },
    createId: () => `child-${++childIndex}`,
    now: () => testAt,
  });
  let workIndex = 0;
  const work: CompanyGoalAssignmentExecutor = {
    reserveIdentity() {
      const index = ++workIndex;
      return {
        childSessionId: `work-session-${index}`,
        childAgentId: `work-agent-${index}`,
        taskId: `work-task-${index}`,
      };
    },
    async delegate(input, context) {
      const budget = context.delegationBudget!;
      const allowance = Math.max(1, Math.floor(budget.maxRequests / budget.maxChildren));
      budget.childrenStarted += 1;
      budget.requestsReserved += allowance;
      budget.requestsUsed += 1;
      if (options.workResult === "failure") {
        throw new ToolError("execution_failed", "Independent review failed");
      }
      if (options.workResult === "cancelled") {
        throw new ToolError("cancelled", "Independent review was cancelled");
      }
      const usage = options.workResult === "unknown"
        ? null
        : {
            inputTokens: 2,
            outputTokens: 1,
            costUsd: options.workResult === "cost" ? 4 : 0.02,
          };
      budget.reportedCostUsd += usage?.costUsd ?? 0;
      return {
        output: "independent review approved",
        metadata: {
          childSessionId: `work-session-${workIndex}`,
          childAgentId: `work-agent-${workIndex}`,
          taskId: `work-task-${workIndex}`,
          attempts: 1,
          retries: 0,
          operatingModeId: "balanced_v6",
          profileId: input.profile,
          usage,
          usageSource: usage === null ? "unavailable" : "provider",
          requestsUsed: 1,
          evidenceSource: "independent_verification",
          changedFiles: [],
          evidence: ["reviewed every prior handoff"],
          costLimitUsd: budget.maxReportedCostUsd,
          costLimitExceeded: budget.reportedCostUsd > budget.maxReportedCostUsd,
          workflow: delegationWorkflowUsage(budget),
        },
      };
    },
  };
  let currentTeamStatus = options.teamStatus ?? "approved";
  type TeamCorrelation = Parameters<NonNullable<
    ConstructorParameters<typeof CompanyGoalSupervisor>[0]["team"]
  >["reserveCompanyRun"]>[2];
  const teamCorrelations = new Map<string, TeamCorrelation>();
  const teamStatuses = new Map<string, typeof currentTeamStatus>();
  let teamIndex = 0;
  const teamCalls: string[] = [];
  const teamResult = (teamRunId: string) => {
    const teamCorrelation = teamCorrelations.get(teamRunId);
    if (teamCorrelation === undefined) throw new Error("Team was not reserved");
    const teamStatus = teamStatuses.get(teamRunId) ?? currentTeamStatus;
    const terminalFailure = teamStatus === "failed" ||
      teamStatus === "cancelled";
    return {
      output: `Team ${teamRunId}: ${teamStatus}`,
      metadata: {
        teamId: teamRunId,
        status: teamStatus,
        operatingModeId: "balanced_v6" as const,
        repairRounds: 0,
        accounting: {
          childrenReserved: 2,
          childrenFinished: 2,
          requestsReserved: 16,
          requestsUsed: 2,
          usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.02 },
          usageReportedChildren: 2,
          usageMissingChildren: 0,
          reportedCostUsd: 0.02,
          costReportedChildren: 2,
          costMissingChildren: 0,
          costCoverage: "complete" as const,
        },
        changedFiles: teamStatus === "approved" ? ["src/change.ts"] : [],
        evidence: ["durable team evidence"],
        companyGoal: {
          goalRunId: teamCorrelation.runId,
          assignments: [
            ...teamCorrelation.implementations,
            ...teamCorrelation.reviews,
          ].map((binding) => ({
            assignmentId: binding.assignmentId,
            summary: `completed ${binding.assignmentId}`,
            evidence: [`evidence for ${binding.assignmentId}`],
            usage: { inputTokens: 2, outputTokens: 1, costUsd: 0.01 },
            usageSource: "provider" as const,
          })),
        },
        ...(terminalFailure
          ? {
              failure: {
                code: teamStatus,
                message: `team ${teamStatus}`,
              },
            }
          : {}),
      },
    };
  };
  const team = {
    async reserveCompanyRun(
      _input: unknown,
      _context: unknown,
      correlation: TeamCorrelation,
      limits: { readonly maxRequests: number; readonly maxReportedCostUsd: number },
    ) {
      teamCalls.push("reserve");
      const teamRunId = `team-run-${++teamIndex}`;
      teamCorrelations.set(teamRunId, correlation);
      teamStatuses.set(
        teamRunId,
        options.teamStatuses?.[teamIndex - 1] ?? currentTeamStatus,
      );
      return {
        teamRunId,
        allocation: {
          maxChildren: 6,
          maxRequests: Math.min(48, limits.maxRequests),
          requestAllowance: 8,
          maxReportedCostUsd: Math.min(3, limits.maxReportedCostUsd),
        },
        companyGoal: correlation,
      };
    },
    async startCompanyForeground(
      _input: unknown,
      _context: unknown,
      reservation: { readonly teamRunId: string },
    ) {
      teamCalls.push("start");
      return teamResult(reservation.teamRunId);
    },
    async inspectCompanyRun(_parentId: string, teamRunId: string) {
      teamCalls.push("inspect");
      return teamResult(teamRunId);
    },
  };
  let runIndex = 0;
  const learningDependency = options.learning !== true
    ? undefined
    : {
        selectCompanyKnowledge: options.learningFailure === "select"
          ? async () => { throw new Error("sensitive selection failure"); }
          : learning.selectCompanyKnowledge.bind(learning),
        recordCompletedGoal: options.learningFailure === "record"
          ? async () => { throw new Error("sensitive record failure"); }
          : learning.recordCompletedGoal.bind(learning),
      };
  const supervisor = new CompanyGoalSupervisor({
    sessions,
    blueprints,
    runs,
    children,
    work,
    team,
    ...(learningDependency === undefined ? {} : { learning: learningDependency }),
    async emit(event) { events.push(event); },
    createId: () => `company-run-id-${++runIndex}`,
    now: () => testAt,
  });
  supervisorReference.current = supervisor;
  const context: ToolContext = {
    sessionId: parent.id,
    cwd: parent.cwd,
    executionMode: parent.executionMode,
    signal: new AbortController().signal,
    readRevisions: new Map(),
    runContext: trusted,
    delegationBudget: createDelegationBudget(parent.agent),
  };
  return {
    root,
    sessions,
    blueprints,
    runs,
    knowledge,
    learning,
    blueprint,
    roles,
    parent,
    events,
    children,
    supervisor,
    context,
    prompts,
    teamCalls,
    setTeamStatus(status: typeof currentTeamStatus) {
      currentTeamStatus = status;
      for (const teamRunId of teamStatuses.keys()) {
        teamStatuses.set(teamRunId, status);
      }
    },
  };
}

function goal(setup: Awaited<ReturnType<typeof fixture>>): DelegateCompanyGoalInput {
  const lead = setup.roles["Planning Lead"]!;
  const worker = setup.roles["Research Worker"] ??
    setup.roles["Implementation Worker"]!;
  const reviewer = setup.roles["Independent Reviewer"]!;
  return {
    objective: "Map the company goal runtime and review the evidence.",
    assignments: [{
      id: "lead-assignment",
      roleId: lead.id,
      parentAssignmentId: null,
      dependsOn: [],
      description: "Plan the bounded investigation",
      prompt: "Identify the relevant runtime seam.",
      acceptance: ["Return a concrete handoff."],
    }, {
      id: "worker-assignment",
      roleId: worker.id,
      parentAssignmentId: "lead-assignment",
      dependsOn: [],
      description: "Investigate the runtime seam",
      prompt: "Inspect the approved seam and cite evidence.",
      acceptance: ["Cite the inspected implementation."],
    }, {
      id: "review-assignment",
      roleId: reviewer.id,
      parentAssignmentId: null,
      dependsOn: ["lead-assignment", "worker-assignment"],
      description: "Review the company result",
      prompt: "Review every handoff independently.",
      acceptance: ["Approve or report a concrete finding."],
    }],
  };
}

function multiStageGoal(
  setup: Awaited<ReturnType<typeof fixture>>,
): DelegateCompanyGoalInput {
  const lead = setup.roles["Planning Lead"]!;
  const worker = setup.roles["Implementation Worker"]!;
  const reviewer = setup.roles["Independent Reviewer"]!;
  return {
    objective: "Deliver two dependency-ordered reviewed implementation stages.",
    assignments: [{
      id: "lead-assignment",
      roleId: lead.id,
      parentAssignmentId: null,
      dependsOn: [],
      description: "Plan both bounded stages",
      prompt: "Identify the two implementation frontiers.",
      acceptance: ["Return a staged plan."],
    }, {
      id: "architecture-assignment",
      roleId: lead.id,
      parentAssignmentId: null,
      dependsOn: ["lead-assignment"],
      description: "Check the architecture boundary",
      prompt: "Confirm the approved architecture seam before review.",
      acceptance: ["Return architecture evidence."],
    }, {
      id: "implementation-one",
      roleId: worker.id,
      parentAssignmentId: "lead-assignment",
      dependsOn: [],
      description: "Implement the first frontier",
      prompt: "Implement and verify the foundation.",
      acceptance: ["Return the first verified patch."],
    }, {
      id: "review-one",
      roleId: reviewer.id,
      parentAssignmentId: null,
      dependsOn: ["architecture-assignment", "implementation-one"],
      description: "Review the first frontier",
      prompt: "Independently review the foundation.",
      acceptance: ["Approve or return findings."],
    }, {
      id: "implementation-two",
      roleId: worker.id,
      parentAssignmentId: "lead-assignment",
      dependsOn: ["review-one"],
      description: "Implement the dependent frontier",
      prompt: "Build on the approved foundation and verify it.",
      acceptance: ["Return the dependent verified patch."],
    }, {
      id: "review-two",
      roleId: reviewer.id,
      parentAssignmentId: null,
      dependsOn: [
        "lead-assignment",
        "architecture-assignment",
        "implementation-one",
        "implementation-two",
      ],
      description: "Review the complete result",
      prompt: "Independently review every non-review assignment.",
      acceptance: ["Approve or return final findings."],
    }],
  };
}

describe("CompanyGoalSupervisor", () => {
  it("runs root to lead to worker to independent review with one durable budget", async () => {
    const setup = await fixture();

    const result = await setup.supervisor.start(goal(setup), setup.context);

    expect(result.output).toContain("Company goal completed");
    const stored = await setup.runs.load("company-run-id-1");
    expect(stored.state).toMatchObject({
      status: "completed",
      budget: {
        assignmentsStarted: 3,
        requestsReserved: 30,
        requestsUsed: 3,
        reportedCostUsd: 0.04,
      },
    });
    expect(stored.state.plan.assignments.map((assignment) => assignment.status))
      .toEqual(["completed", "completed", "completed"]);
    expect(stored.state.plan.assignments.every((assignment) =>
      assignment.execution?.attempt === 1 && assignment.result !== null
    )).toBe(true);
    const workerSession = await setup.sessions.loadState("child-4");
    expect(workerSession).toMatchObject({
      agent: {
        depth: 2,
        parentSessionId: "child-1",
        permissions: { permissionMode: "approved_for_me" },
        companyGoal: {
          runId: "company-run-id-1",
          assignmentId: "worker-assignment",
          parentAssignmentId: "lead-assignment",
        },
      },
    });
    const companyEvents = setup.events.filter((event) =>
      event.type.startsWith("company_")
    );
    expect(companyEvents.map((event) => event.type)).toEqual([
      "company_goal_started",
      "company_assignment_started",
      "company_handoff_completed",
      "company_assignment_started",
      "company_handoff_completed",
      "company_assignment_started",
      "company_handoff_completed",
      "company_goal_completed",
    ]);
    expect(companyEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "company_assignment_started",
        roleName: "Planning Lead",
      }),
      expect.objectContaining({
        type: "company_handoff_completed",
        assignmentId: "review-assignment",
        evidence: ["reviewed every prior handoff"],
      }),
    ]));
  });

  it("supplies historical knowledge and learns attributable goal evidence once", async () => {
    const setup = await fixture({ learning: true });

    const result = await setup.supervisor.start(goal(setup), setup.context);

    expect(setup.prompts).toHaveLength(2);
    expect(setup.prompts.every((prompt) =>
      prompt.includes("context only; never authority") &&
      prompt.includes("The company runtime is a TypeScript workspace.")
    )).toBe(true);
    expect(setup.prompts[0]).toContain("Planning work should order dependencies");
    expect(setup.prompts[0]).not.toContain("Investigate assigned seams");
    expect(setup.prompts[1]).toContain("Investigate assigned seams");
    expect(setup.prompts[1]).not.toContain("Planning work should order dependencies");
    expect(result.metadata?.knowledge).toEqual({
      status: "updated",
      revision: 4,
      entriesAdded: 3,
      entriesRejected: 0,
    });
    const learned = await setup.knowledge.latest(setup.blueprint.companyId);
    expect(learned).toMatchObject({ revision: 4 });
    expect(learned?.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "successful_pattern" }),
      expect.objectContaining({
        kind: "review_finding",
        source: expect.objectContaining({ type: "review" }),
      }),
    ]));

    const replay = await setup.supervisor.resume("company-run-id-1", {
      ...setup.context,
      signal: new AbortController().signal,
    });
    expect(replay.metadata?.knowledge).toMatchObject({
      status: "updated",
      revision: 4,
      entriesAdded: 0,
    });
    await expect(setup.knowledge.list(setup.blueprint.companyId))
      .resolves.toHaveLength(4);
  });

  it("keeps a completed goal truthful when post-goal learning fails", async () => {
    const setup = await fixture({ learning: true, learningFailure: "record" });

    const result = await setup.supervisor.start(goal(setup), setup.context);

    expect(result.metadata?.knowledge).toEqual({
      status: "unavailable",
      revision: 3,
    });
    await expect(setup.runs.load("company-run-id-1")).resolves.toMatchObject({
      state: { status: "completed" },
    });
    expect(setup.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "warning",
        code: "company_learning_failed",
        message: "Company goal completed, but project learning could not be updated",
      }),
      expect.objectContaining({ type: "company_goal_completed" }),
    ]));
    expect(JSON.stringify(setup.events)).not.toContain("sensitive record failure");
  });

  it("fails before creating a goal when historical knowledge cannot be read", async () => {
    const setup = await fixture({ learning: true, learningFailure: "select" });

    await expect(setup.supervisor.start(goal(setup), setup.context)).rejects
      .toMatchObject({
        code: "execution_failed",
        message: "Company knowledge context is unavailable",
      });
    await expect(setup.runs.load("company-run-id-1")).rejects
      .toMatchObject({ code: "not_found" });
  });

  it("reserves and reconciles one implementation and review through the team engine", async () => {
    const setup = await fixture({ implementation: true });

    const result = await setup.supervisor.start(goal(setup), setup.context);

    expect(result.output).toContain("Company goal completed");
    expect(setup.teamCalls).toEqual(["reserve", "start"]);
    const stored = await setup.runs.load("company-run-id-1");
    expect(stored.state).toMatchObject({
      status: "completed",
      budget: {
        assignmentsStarted: 3,
        requestsReserved: 58,
        requestsUsed: 3,
        reportedCostUsd: 0.03,
      },
    });
    expect(stored.state.plan.assignments.map((assignment) => assignment.status))
      .toEqual(["completed", "completed", "completed"]);
    expect(stored.state.plan.assignments.slice(1).every((assignment) =>
      assignment.execution !== undefined && "teamRunId" in assignment.execution &&
      assignment.execution.teamRunId === "team-run-1"
    )).toBe(true);
  });

  it("runs dependency-ordered implementation and review frontiers through separate durable teams", async () => {
    const setup = await fixture({ implementation: true });

    const result = await setup.supervisor.start(
      multiStageGoal(setup),
      setup.context,
    );

    expect(result.output).toContain("Company goal completed");
    expect(setup.teamCalls).toEqual(["reserve", "start", "reserve", "start"]);
    const stored = await setup.runs.load("company-run-id-1");
    expect(stored.state).toMatchObject({
      status: "completed",
      budget: {
        assignmentsStarted: 6,
        requestsReserved: 80,
        requestsUsed: 6,
        reportedCostUsd: 0.06,
      },
    });
    expect(stored.state.plan.assignments.map((assignment) => assignment.status))
      .toEqual([
        "completed", "completed", "completed", "completed", "completed",
        "completed",
      ]);
    expect(stored.state.plan.assignments[2]?.execution).toMatchObject({
      teamRunId: "team-run-1",
      teamRole: "implement",
    });
    expect(stored.state.plan.assignments[3]?.execution).toMatchObject({
      teamRunId: "team-run-1",
      teamRole: "review",
    });
    expect(stored.state.plan.assignments[4]?.execution).toMatchObject({
      teamRunId: "team-run-2",
      teamRole: "implement",
    });
    expect(stored.state.plan.assignments[5]?.execution).toMatchObject({
      teamRunId: "team-run-2",
      teamRole: "review",
    });
  });

  it("rejects a mutating stage whose only covering review is gated on future work", async () => {
    const setup = await fixture({ implementation: true });
    const input = multiStageGoal(setup);
    const invalid = {
      ...input,
      assignments: input.assignments.map((assignment) =>
        assignment.id === "review-one"
          ? { ...assignment, dependsOn: ["architecture-assignment"] }
          : assignment.id === "implementation-two"
            ? { ...assignment, dependsOn: ["implementation-one"] }
            : assignment
      ),
    };

    await expect(setup.supervisor.start(invalid, setup.context)).rejects
      .toMatchObject({
        code: "permission_denied",
        message: expect.stringContaining("reviewed execution frontier"),
      });
    await expect(setup.runs.load("company-run-id-1")).rejects
      .toMatchObject({ code: "not_found" });
    expect(setup.teamCalls).toEqual([]);
  });

  it("recovers an interrupted later frontier without replaying the approved first stage", async () => {
    const setup = await fixture({
      implementation: true,
      teamStatuses: ["approved", "interrupted"],
    });

    await expect(setup.supervisor.start(
      multiStageGoal(setup),
      setup.context,
    )).rejects.toMatchObject({ code: "checkpoint_conflict" });
    const interrupted = await setup.runs.load("company-run-id-1");
    expect(interrupted.state).toMatchObject({
      status: "interrupted",
      budget: { requestsReserved: 80, requestsUsed: 4, reportedCostUsd: 0.04 },
    });
    expect(interrupted.state.plan.assignments.map((assignment) => assignment.status))
      .toEqual([
        "completed", "completed", "completed", "completed", "running", "running",
      ]);

    setup.setTeamStatus("approved");
    await expect(setup.supervisor.resume("company-run-id-1", {
      ...setup.context,
      signal: new AbortController().signal,
      delegationBudget: createDelegationBudget(setup.parent.agent),
    })).resolves.toMatchObject({ metadata: { status: "completed" } });
    expect(setup.teamCalls).toEqual([
      "reserve", "start", "reserve", "start", "inspect",
    ]);
    const completed = await setup.runs.load("company-run-id-1");
    expect(completed.state).toMatchObject({
      status: "completed",
      budget: { requestsReserved: 80, requestsUsed: 6, reportedCostUsd: 0.06 },
    });
  });

  it("propagates cancellation from a later frontier without rewriting prior evidence", async () => {
    const setup = await fixture({
      implementation: true,
      teamStatuses: ["approved", "cancelled"],
    });

    await expect(setup.supervisor.start(
      multiStageGoal(setup),
      setup.context,
    )).rejects.toMatchObject({ code: "cancelled" });
    const cancelled = await setup.runs.load("company-run-id-1");
    expect(cancelled.state.status).toBe("cancelled");
    expect(cancelled.state.plan.assignments.map((assignment) => assignment.status))
      .toEqual([
        "completed", "completed", "completed", "completed", "cancelled",
        "cancelled",
      ]);
    expect(cancelled.state.plan.assignments[2]?.result?.evidence)
      .toEqual(["evidence for implementation-one"]);
  });

  it.each(["failed", "cancelled"] as const)(
    "propagates a %s team terminal state to the company goal",
    async (teamStatus) => {
      const setup = await fixture({ implementation: true, teamStatus });

      await expect(setup.supervisor.start(goal(setup), setup.context)).rejects
        .toMatchObject({
          code: teamStatus === "cancelled" ? "cancelled" : "execution_failed",
        });

      const stored = await setup.runs.load("company-run-id-1");
      expect(stored.state.status).toBe(teamStatus);
      expect(stored.state.plan.assignments.map((assignment) => assignment.status))
        .toEqual(["completed", teamStatus, teamStatus]);
      expect(stored.state.budget).toMatchObject({
        assignmentsStarted: 3,
        requestsReserved: 58,
        requestsUsed: 3,
        reportedCostUsd: 0.03,
      });
    },
  );

  it("resumes an interrupted company team without double-accounting", async () => {
    const setup = await fixture({
      implementation: true,
      teamStatus: "interrupted",
    });
    await expect(setup.supervisor.start(goal(setup), setup.context)).rejects
      .toMatchObject({ code: "checkpoint_conflict" });
    const interrupted = await setup.runs.load("company-run-id-1");
    expect(interrupted.state).toMatchObject({
      status: "interrupted",
      budget: { requestsReserved: 58, requestsUsed: 1, reportedCostUsd: 0.01 },
    });
    expect(interrupted.state.plan.assignments.map((assignment) => assignment.status))
      .toEqual(["completed", "running", "running"]);

    setup.setTeamStatus("approved");
    const resumed = await setup.supervisor.resume("company-run-id-1", {
      ...setup.context,
      signal: new AbortController().signal,
      delegationBudget: createDelegationBudget(setup.parent.agent),
    });

    expect(resumed.output).toContain("Company goal completed");
    expect(setup.teamCalls).toEqual(["reserve", "start", "inspect"]);
    const completed = await setup.runs.load("company-run-id-1");
    expect(completed.state).toMatchObject({
      status: "completed",
      budget: { requestsReserved: 58, requestsUsed: 3, reportedCostUsd: 0.03 },
    });
  });

  it("allows a live lead to request only its pre-approved child handoff", async () => {
    const setup = await fixture({ nestedHandoffIds: ["worker-assignment"] });

    await setup.supervisor.start(goal(setup), setup.context);

    const companyEvents = setup.events.filter((event) =>
      event.type.startsWith("company_")
    );
    expect(companyEvents.map((event) => event.type)).toEqual([
      "company_goal_started",
      "company_assignment_started",
      "company_assignment_started",
      "company_handoff_completed",
      "company_handoff_completed",
      "company_assignment_started",
      "company_handoff_completed",
      "company_goal_completed",
    ]);
    const run = await setup.runs.load("company-run-id-1");
    expect(run.state.plan.assignments[1]).toMatchObject({
      status: "completed",
      execution: { childSessionId: "child-4" },
    });
  });

  it("enforces the company-wide concurrency ceiling across nested handoffs", async () => {
    const workerIds = [
      "worker-assignment-1",
      "worker-assignment-2",
      "worker-assignment-3",
    ];
    const setup = await fixture({ nestedHandoffIds: workerIds });
    const base = goal(setup);
    const worker = base.assignments[1]!;
    const review = base.assignments[2]!;
    const input: DelegateCompanyGoalInput = {
      ...base,
      assignments: [
        base.assignments[0]!,
        ...workerIds.map((id) => ({ ...worker, id })),
        { ...review, dependsOn: ["lead-assignment", ...workerIds] },
      ],
    };

    await expect(setup.supervisor.start(input, setup.context))
      .rejects.toThrow(/concurrency/iu);
    const run = await setup.runs.load("company-run-id-1");
    expect(run.state.status).toBe("failed");
    expect(run.state.budget.assignmentsStarted).toBe(3);
    expect(run.state.plan.assignments.filter((assignment) =>
      assignment.status === "completed"
    )).toHaveLength(2);
  });

  it("rejects unauthorized edges and a review that can run before the work", async () => {
    const setup = await fixture();
    const input = goal(setup);
    await expect(setup.supervisor.start({
      ...input,
      assignments: input.assignments.map((assignment) =>
        assignment.id === "worker-assignment"
          ? { ...assignment, parentAssignmentId: null }
          : assignment
      ),
    }, setup.context)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(setup.supervisor.start({
      ...input,
      assignments: input.assignments.map((assignment) =>
        assignment.id === "review-assignment"
          ? { ...assignment, dependsOn: ["lead-assignment"] }
          : assignment
      ),
    }, setup.context)).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("prevents a company parent from escaping through the generic child tool", async () => {
    const setup = await fixture();
    const tool = setup.children.createTool();

    await expect(tool.execute({
      profile: "explore_v1",
      description: "Bypass the company graph",
      prompt: "Create an unapproved child.",
    }, setup.context)).rejects.toMatchObject({ code: "permission_denied" });
    expect(setup.context.delegationBudget).toMatchObject({
      childrenStarted: 0,
      requestsReserved: 0,
      requestsUsed: 0,
    });
  });

  it("fails closed on review failure and reported-cost overflow", async () => {
    const failed = await fixture({ workResult: "failure" });
    await expect(failed.supervisor.start(goal(failed), failed.context))
      .rejects.toMatchObject({ code: "execution_failed" });
    await expect(failed.runs.load("company-run-id-1")).resolves.toMatchObject({
      state: { status: "failed" },
    });

    const costly = await fixture({ workResult: "cost" });
    await expect(costly.supervisor.start(goal(costly), costly.context))
      .rejects.toThrow(/cost/iu);
    const stored = await costly.runs.load("company-run-id-1");
    expect(stored.state).toMatchObject({
      status: "failed",
      budget: { reportedCostUsd: 4.02, maxReportedCostUsd: 3 },
    });
  });

  it("preserves unknown usage instead of inventing accounting", async () => {
    const setup = await fixture({ workResult: "unknown" });
    await setup.supervisor.start(goal(setup), setup.context);
    const run = await setup.runs.load("company-run-id-1");
    expect(run.state.plan.assignments.at(-1)?.result).toMatchObject({
      usage: null,
      usageSource: "unknown",
    });
  });

  it("propagates cancellation into the assignment and goal records", async () => {
    const setup = await fixture({ workResult: "cancelled" });
    await expect(setup.supervisor.start(goal(setup), setup.context))
      .rejects.toMatchObject({ code: "cancelled" });
    const run = await setup.runs.load("company-run-id-1");
    expect(run.state).toMatchObject({
      status: "cancelled",
      failure: "Independent review was cancelled",
    });
    expect(run.state.plan.assignments.at(-1)).toMatchObject({
      status: "cancelled",
      failure: "Independent review was cancelled",
    });
    expect(setup.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "company_handoff_cancelled",
        status: "cancelled",
      }),
      expect.objectContaining({
        type: "company_goal_cancelled",
        status: "cancelled",
      }),
    ]));
  });

  it("recovers a completed durable child before continuing pending review", async () => {
    const setup = await fixture();
    const input = goal(setup);
    const lead = input.assignments[0]!;
    const reviewer = input.assignments[2]!;
    const leadRole = setup.roles["Planning Lead"]!;
    const reviewRole = setup.roles["Independent Reviewer"]!;
    const companyGoal = {
      runId: "recovery-run",
      assignmentId: lead.id,
      parentAssignmentId: null,
    };
    const childInput = {
      profile: "explore_v1" as const,
      description: lead.description,
      prompt: lead.prompt,
    };
    const childOptions = {
      company: {
        blueprintId: setup.blueprint.id,
        blueprintVersion: 2 as const,
        blueprintRevision: setup.blueprint.revision,
        roleId: leadRole.id,
        roleVersion: 1 as const,
      },
      companyPermissionMode: leadRole.permissionMode,
      companyGoal,
    };
    const identity = setup.children.reserveIdentity(
      childInput,
      setup.context,
      childOptions,
    );
    const child = await setup.children.delegate(childInput, setup.context, {
      ...childOptions,
      identity,
    });
    await setup.runs.create({
      id: "recovery-run",
      version: 1,
      parentSessionId: setup.parent.id,
      goalId: "recovery-goal",
      objective: input.objective,
      company: setup.parent.agent.company as Extract<
        NonNullable<typeof setup.parent.agent.company>,
        { blueprintVersion: 2 }
      >,
      status: "running",
      createdAt: testAt,
      updatedAt: testAt,
      plan: {
        revision: 1,
        createdAt: testAt,
        assignments: [{
          ...lead,
          expectedEvidence: leadRole.expectedEvidence,
          status: "running",
          execution: {
            attempt: 1,
            childAgentId: child.metadata.childAgentId,
            childSessionId: child.metadata.childSessionId,
            taskId: child.metadata.taskId,
            startedAt: testAt,
            completedAt: null,
          },
          result: null,
          failure: null,
        }, {
          ...reviewer,
          dependsOn: [lead.id],
          expectedEvidence: reviewRole.expectedEvidence,
          status: "pending",
          result: null,
          failure: null,
        }],
      },
      budget: {
        maxAssignments: 8,
        assignmentsStarted: 1,
        maxConcurrentAssignments: 3,
        maxRequests: 80,
        requestsReserved: 10,
        requestsUsed: 0,
        maxReportedCostUsd: 3,
        reportedCostUsd: 0,
      },
      result: null,
      failure: null,
    });

    const result = await setup.supervisor.resume("recovery-run", setup.context);

    expect(result.output).toContain("Company goal completed");
    const recovered = await setup.runs.load("recovery-run");
    expect(recovered.state).toMatchObject({
      status: "completed",
      budget: {
        assignmentsStarted: 2,
        requestsReserved: 20,
        requestsUsed: 2,
        reportedCostUsd: 0.03,
      },
    });
  });
});
