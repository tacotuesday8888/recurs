import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createHostInvocation,
  deriveTrustedRunContext,
  recommendedTeamControlPolicy,
  type OperatingModeId,
  type CoordinatedRunInput,
  type RunCoordinator,
} from "@recurs/contracts";
import {
  permissionIntentKey,
  ToolError,
  type ToolContext,
} from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentBackendRouter,
  approveCompanyBlueprintV2,
  ChildAgentManager,
  CompanyGoalSupervisor,
  CompanyLearningService,
  compileCompanyBlueprintV2,
  createDelegationBudget,
  createRootAgentDescriptor,
  FileCompanyBlueprintV2Store,
  FileCompanyKnowledgeStore,
  FileTeamControlPolicyStore,
  JsonlCompanyGoalStore,
  JsonlSessionStore,
  TEAM_APPLY_PERMISSION,
  TeamRunOwnerLeaseManager,
  type DelegateCompanyGoalInput,
  type PinnedSessionState,
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
const WORKTREE_ORCHESTRATION_PERMISSION = Object.freeze({
  category: "shell" as const,
  resource: "fixed Git worktree orchestration",
  risk: "normal" as const,
});

function companyResumeApprovals(): Set<string> {
  return new Set([
    permissionIntentKey(TEAM_APPLY_PERMISSION),
    permissionIntentKey(WORKTREE_ORCHESTRATION_PERMISSION),
  ]);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function organization(
  implementation = false,
  economy = false,
  directReview = false,
) {
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
      activation: economy ? "on_demand" as const : "always" as const,
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
      reportsToKey: economy ? "orchestrator" : "lead",
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
    }, ...(!implementation ? [{
      ...common,
      key: "implementation_candidate",
      displayName: "Implementation Candidate",
      kind: "worker" as const,
      responsibility: "Implement the researched company handoff.",
      instructions: "Work only in the isolated team workspace.",
      reportsToKey: "lead",
      capabilities: ["implement" as const],
      executionProfileId: "implement_v2" as const,
      toolBundles: ["implementation_v1" as const],
      expectedEvidence: ["A verified implementation patch."],
    }] : []), ...(directReview ? [{
      ...common,
      key: "direct_reviewer",
      displayName: "Direct Reviewer",
      kind: "reviewer" as const,
      responsibility: "Review one read-only company handoff.",
      instructions: "Review independently and cite concrete evidence.",
      reportsToKey: "orchestrator",
      capabilities: ["review" as const],
      executionProfileId: "review_v1" as const,
      toolBundles: ["quality_v1" as const],
      expectedEvidence: ["Evidence-backed direct review."],
    }] : []), {
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
    defaultActiveRoleKeys: economy
      ? ["orchestrator", "worker", "reviewer"]
      : [
          "orchestrator",
          "lead",
          ...(directReview ? ["direct_reviewer"] : []),
          "worker",
          ...(!implementation ? ["implementation_candidate"] : []),
          "reviewer",
        ],
  };
}

async function fixture(options: {
  readonly teamReviewResult?:
    "success" | "failure" | "cancelled" | "cost" | "unknown";
  readonly nestedHandoffIds?: readonly string[];
  readonly implementation?: boolean;
  readonly teamStatus?: "approved" | "failed" | "cancelled" | "interrupted";
  readonly teamStatuses?: readonly (
    "approved" | "failed" | "cancelled" | "interrupted"
  )[];
  readonly learning?: boolean;
  readonly learningFailure?: "select" | "record";
  readonly operatingModeId?: OperatingModeId;
  readonly reviewBackendPin?: ReturnType<typeof testBackendPin>;
} = {}) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-company-goal-")),
  );
  directories.push(root);
  const sessions = new JsonlSessionStore(path.join(root, "sessions"));
  const blueprints = new FileCompanyBlueprintV2Store(path.join(root, "blueprints"));
  const runs = new JsonlCompanyGoalStore(path.join(root, "goals"));
  const teamControls = new FileTeamControlPolicyStore(
    path.join(root, "team-controls"),
  );
  const owners = new TeamRunOwnerLeaseManager({
    rootDirectory: path.join(root, "company-goal-owners"),
  });
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
    operatingModeId: options.operatingModeId ?? "balanced_v6",
    organization: organization(
      options.implementation === true,
      options.operatingModeId === "economy_v6",
      options.reviewBackendPin !== undefined,
    ),
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
  const backendRouter = new AgentBackendRouter();
  const children = new ChildAgentManager({
    sessions,
    backendRouter,
    getCoordinator: () => coordinator,
    async emit(event) { events.push(event); },
    createId: () => `child-${++childIndex}`,
    now: () => testAt,
  });
  let currentTeamStatus = options.teamStatus ??
    (options.teamReviewResult === "failure"
      ? "failed"
      : options.teamReviewResult === "cancelled"
        ? "cancelled"
        : "approved");
  type TeamCorrelation = Parameters<NonNullable<
    ConstructorParameters<typeof CompanyGoalSupervisor>[0]["team"]
  >["reserveCompanyRun"]>[2];
  const teamCorrelations = new Map<string, TeamCorrelation>();
  const teamStatuses = new Map<string, typeof currentTeamStatus>();
  let teamIndex = 0;
  const teamCalls: string[] = [];
  let currentReviewBackendPin = options.reviewBackendPin;
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
          usage: options.teamReviewResult === "unknown"
            ? null
            : {
                inputTokens: 4,
                outputTokens: 2,
                costUsd: options.teamReviewResult === "cost" ? 4 : 0.02,
              },
          usageReportedChildren: options.teamReviewResult === "unknown" ? 0 : 2,
          usageMissingChildren: options.teamReviewResult === "unknown" ? 2 : 0,
          reportedCostUsd: options.teamReviewResult === "unknown"
            ? null
            : options.teamReviewResult === "cost" ? 4 : 0.02,
          costReportedChildren: options.teamReviewResult === "unknown" ? 0 : 2,
          costMissingChildren: options.teamReviewResult === "unknown" ? 2 : 0,
          costCoverage: options.teamReviewResult === "unknown"
            ? "unknown" as const
            : "complete" as const,
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
            usage: options.teamReviewResult === "unknown" &&
                binding.assignmentId === "review-assignment"
              ? null
              : {
                  inputTokens: 2,
                  outputTokens: 1,
                  costUsd: options.teamReviewResult === "cost" ? 2 : 0.01,
                },
            usageSource: options.teamReviewResult === "unknown" &&
                binding.assignmentId === "review-assignment"
              ? "unknown" as const
              : "provider" as const,
          })),
        },
        ...(terminalFailure
          ? {
              failure: {
                code: teamStatus,
                message: options.teamReviewResult === "failure"
                  ? "Independent review failed"
                  : options.teamReviewResult === "cancelled"
                    ? "Independent review was cancelled"
                    : `team ${teamStatus}`,
              },
            }
          : {}),
      },
    };
  };
  const team = {
    async selectCompanyChildBackend(input: {
      readonly parent: PinnedSessionState;
      readonly profileId: "review_v1";
      readonly modelRoute: "review";
      readonly background: false;
    }) {
      return backendRouter.select({
        role: "review",
        candidateRole: input.modelRoute,
        executionMode: "act",
        permissionMode: input.parent.permissionMode,
        background: input.background,
        candidates: [{
          id: "parent",
          pin: input.parent.backend.pin,
          parent: true,
          roles: ["implement", "review", "repair"],
          executionModes: ["act"],
          permissionModes: [input.parent.permissionMode],
          hostTools: true,
          background: true,
          ready: true,
        }, ...(currentReviewBackendPin === undefined ? [] : [{
          id: "direct-review",
          pin: currentReviewBackendPin,
          parent: false,
          roles: ["review" as const],
          executionModes: ["act" as const],
          permissionModes: [input.parent.permissionMode],
          hostTools: true,
          background: true,
          ready: true,
        }])],
      });
    },
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
  const supervisorDependencies = {
    sessions,
    blueprints,
    runs,
    teamControls,
    owners,
    children,
    team,
    ...(learningDependency === undefined ? {} : { learning: learningDependency }),
    async emit(event) { events.push(event); },
    createId: () => `company-run-id-${++runIndex}`,
    now: () => testAt,
  };
  const supervisor = new CompanyGoalSupervisor(supervisorDependencies);
  supervisorReference.current = supervisor;
  const context: ToolContext = {
    sessionId: parent.id,
    cwd: parent.cwd,
    executionMode: parent.executionMode,
    signal: new AbortController().signal,
    readRevisions: new Map(),
    runContext: trusted,
    approvedIntents: companyResumeApprovals(),
    delegationBudget: createDelegationBudget(parent.agent),
  };
  return {
    root,
    sessions,
    blueprints,
    runs,
    teamControls,
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
    team,
    teamCalls,
    teamCorrelations,
    createSupervisor(
      overrides: Partial<typeof supervisorDependencies> = {},
    ) {
      return new CompanyGoalSupervisor({
        ...supervisorDependencies,
        ...overrides,
      });
    },
    setReviewBackendPin(
      reviewBackendPin: typeof currentReviewBackendPin,
    ) {
      currentReviewBackendPin = reviewBackendPin;
    },
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
  const implementationCandidate = setup.roles["Implementation Candidate"];
  const directReviewer = setup.roles["Direct Reviewer"];
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
    }, ...(directReviewer === undefined ? [] : [{
      id: "direct-review-assignment",
      roleId: directReviewer.id,
      parentAssignmentId: null,
      dependsOn: ["lead-assignment"],
      description: "Review the planned runtime seam",
      prompt: "Independently review the plan before implementation.",
      acceptance: ["Return a cited review."],
    }]), {
      id: "worker-assignment",
      roleId: worker.id,
      parentAssignmentId: "lead-assignment",
      dependsOn: directReviewer === undefined ? [] : ["direct-review-assignment"],
      description: "Investigate the runtime seam",
      prompt: "Inspect the approved seam and cite evidence.",
      acceptance: ["Cite the inspected implementation."],
    }, ...(implementationCandidate === undefined ? [] : [{
      id: "implementation-assignment",
      roleId: implementationCandidate.id,
      parentAssignmentId: "lead-assignment",
      dependsOn: ["worker-assignment"],
      description: "Implement the researched runtime seam",
      prompt: "Implement and verify the approved bounded change.",
      acceptance: ["Return a verified patch."],
    }]), {
      id: "review-assignment",
      roleId: reviewer.id,
      parentAssignmentId: null,
      dependsOn: [
        "lead-assignment",
        ...(directReviewer === undefined ? [] : ["direct-review-assignment"]),
        "worker-assignment",
        ...(implementationCandidate === undefined
          ? []
          : ["implementation-assignment"]),
      ],
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

async function seedRecoverableChild(
  setup: Awaited<ReturnType<typeof fixture>>,
  runStatus: "running" | "interrupted" = "running",
): Promise<string> {
  const input = goal(setup);
  const lead = input.assignments[0]!;
  const worker = input.assignments[1]!;
  const implementation = input.assignments[2]!;
  const reviewer = input.assignments[3]!;
  const leadRole = setup.roles["Planning Lead"]!;
  const workerRole = setup.roles["Research Worker"]!;
  const implementationRole = setup.roles["Implementation Candidate"]!;
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
    status: runStatus,
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
        ...worker,
        expectedEvidence: workerRole.expectedEvidence,
        status: "completed",
        result: {
          summary: "completed historical worker assignment",
          evidence: ["historical worker evidence"],
          usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.01 },
          usageSource: "provider",
        },
        failure: null,
      }, {
        ...implementation,
        expectedEvidence: implementationRole.expectedEvidence,
        status: "pending",
        result: null,
        failure: null,
      }, {
        ...reviewer,
        expectedEvidence: reviewRole.expectedEvidence,
        status: "pending",
        result: null,
        failure: null,
      }],
    },
    budget: {
      maxAssignments: 8,
      assignmentsStarted: 2,
      maxConcurrentAssignments: 3,
      maxRequests: 80,
      requestsReserved: 20,
      requestsUsed: 1,
      maxReportedCostUsd: 3,
      reportedCostUsd: 0.01,
    },
    result: null,
    failure: null,
  });
  return child.metadata.childSessionId;
}

async function seedRecoverableDirectReview(
  setup: Awaited<ReturnType<typeof fixture>>,
  options: {
    readonly runStatus?: "running" | "interrupted";
    readonly includeRunningTeam?: boolean;
  } = {},
): Promise<string> {
  const input = goal(setup);
  const lead = input.assignments.find((assignment) =>
    assignment.id === "lead-assignment"
  )!;
  const directReview = input.assignments.find((assignment) =>
    assignment.id === "direct-review-assignment"
  )!;
  const worker = input.assignments.find((assignment) =>
    assignment.id === "worker-assignment"
  )!;
  const finalReview = input.assignments.find((assignment) =>
    assignment.id === "review-assignment"
  )!;
  const leadRole = setup.roles["Planning Lead"]!;
  const directReviewRole = setup.roles["Direct Reviewer"]!;
  const workerRole = setup.roles["Implementation Worker"]!;
  const finalReviewRole = setup.roles["Independent Reviewer"]!;
  const companyGoal = {
    runId: "direct-review-recovery-run",
    assignmentId: directReview.id,
    parentAssignmentId: null,
  };
  const childInput = {
    profile: "review_v1" as const,
    description: directReview.description,
    prompt: directReview.prompt,
  };
  const childOptions = {
    company: {
      blueprintId: setup.blueprint.id,
      blueprintVersion: 2 as const,
      blueprintRevision: setup.blueprint.revision,
      roleId: directReviewRole.id,
      roleVersion: 1 as const,
    },
    companyPermissionMode: directReviewRole.permissionMode,
    companyGoal,
    backend: {
      decision: await setup.team.selectCompanyChildBackend({
        parent: setup.parent,
        profileId: "review_v1",
        modelRoute: "review",
        background: false,
      }),
    },
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
    id: companyGoal.runId,
    version: 1,
    parentSessionId: setup.parent.id,
    goalId: "direct-review-recovery-goal",
    objective: input.objective,
    company: setup.parent.agent.company as Extract<
      NonNullable<typeof setup.parent.agent.company>,
      { blueprintVersion: 2 }
    >,
    status: options.runStatus ?? "running",
    createdAt: testAt,
    updatedAt: testAt,
    plan: {
      revision: 1,
      createdAt: testAt,
      assignments: [{
        ...lead,
        expectedEvidence: leadRole.expectedEvidence,
        status: "completed",
        result: {
          summary: "completed historical lead assignment",
          evidence: ["historical lead evidence"],
          usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.01 },
          usageSource: "provider",
        },
        failure: null,
      }, {
        ...directReview,
        expectedEvidence: directReviewRole.expectedEvidence,
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
        ...worker,
        expectedEvidence: workerRole.expectedEvidence,
        status: options.includeRunningTeam === true ? "running" : "pending",
        ...(options.includeRunningTeam === true
          ? {
              execution: {
                attempt: 1 as const,
                teamRunId: "preflight-order-team",
                teamRole: "implement" as const,
                taskIndex: 1,
                startedAt: testAt,
                completedAt: null,
              },
            }
          : {}),
        result: null,
        failure: null,
      }, {
        ...finalReview,
        expectedEvidence: finalReviewRole.expectedEvidence,
        status: "pending",
        result: null,
        failure: null,
      }],
    },
    budget: {
      maxAssignments: 8,
      assignmentsStarted: options.includeRunningTeam === true ? 3 : 2,
      maxConcurrentAssignments: 3,
      maxRequests: 80,
      requestsReserved: options.includeRunningTeam === true ? 28 : 20,
      requestsUsed: 1,
      maxReportedCostUsd: 3,
      reportedCostUsd: 0.01,
    },
    result: null,
    failure: null,
  });
  return child.metadata.childSessionId;
}

async function expectDirectReviewRecoveryRejectedWithoutSideEffects(
  setup: Awaited<ReturnType<typeof fixture>>,
  supervisor: CompanyGoalSupervisor,
): Promise<void> {
  const before = await setup.runs.load("direct-review-recovery-run");
  const sessionsBefore = await setup.sessions.list();
  const promptsBefore = [...setup.prompts];
  const eventsBefore = [...setup.events];
  const teamCallsBefore = [...setup.teamCalls];

  await expect(supervisor.resume(
    "direct-review-recovery-run",
    setup.context,
  )).rejects.toMatchObject({
    code: "execution_failed",
    message: expect.stringContaining("correlation"),
  });

  await expect(setup.runs.load("direct-review-recovery-run")).resolves
    .toEqual(before);
  await expect(setup.sessions.list()).resolves.toEqual(sessionsBefore);
  expect(setup.prompts).toEqual(promptsBefore);
  expect(setup.events).toEqual(eventsBefore);
  expect(setup.teamCalls).toEqual(teamCallsBefore);
}

function corruptChildCorrelation(
  state: PinnedSessionState,
  path: readonly string[],
  replacement: unknown,
): PinnedSessionState {
  const corrupted = structuredClone(state) as unknown as Record<string, unknown>;
  let target = corrupted;
  for (const key of path.slice(0, -1)) {
    const value = target[key];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Invalid child corruption path: ${path.join(".")}`);
    }
    target = value as Record<string, unknown>;
  }
  target[path.at(-1)!] = replacement;
  return corrupted as unknown as PinnedSessionState;
}

const childCorrelationCorruptions = [
  ["child agent", ["agent", "id"], "wrong-child-agent"],
  ["task", ["agent", "task", "id"], "wrong-task"],
  ["parent session", ["agent", "parentSessionId"], "wrong-parent-session"],
  ["parent agent", ["agent", "parentAgentId"], "wrong-parent-agent"],
  ["goal run", ["agent", "companyGoal", "runId"], "wrong-run"],
  ["goal assignment", ["agent", "companyGoal", "assignmentId"], "wrong-assignment"],
  [
    "goal parent assignment",
    ["agent", "companyGoal", "parentAssignmentId"],
    "wrong-parent-assignment",
  ],
  ["blueprint", ["agent", "company", "blueprintId"], "wrong-blueprint"],
  ["blueprint revision", ["agent", "company", "blueprintRevision"], 2],
  ["role", ["agent", "company", "roleId"], "wrong-role"],
  ["profile", ["agent", "profile", "id"], "review_v1"],
  ["operating mode", ["agent", "operatingMode", "version"], 5],
  ["session backend", ["backend", "pin", "modelId"], "wrong-model"],
  ["agent backend", ["agent", "backend", "modelId"], "wrong-model"],
  ["permission binding", ["agent", "permissions", "permissionMode"], "full_access"],
] as const;

describe("CompanyGoalSupervisor", () => {
  it("freezes effective project team controls into every new goal", async () => {
    const setup = await fixture();
    const selected = {
      ...recommendedTeamControlPolicy("balanced_v6"),
      maxConcurrentAgents: 1,
      maxRequests: 20,
      maxReportedCostUsd: 1,
    };
    await setup.teamControls.publish(setup.root, selected, null);

    await setup.supervisor.start(goal(setup), setup.context);

    const run = (await setup.runs.load("company-run-id-1")).state;
    expect(run).toMatchObject({
      version: 2,
      teamControl: {
        selected,
        effective: {
          sourceRevision: 1,
          operatingModeId: "balanced_v6",
          blueprintId: setup.blueprint.id,
          blueprintRevision: setup.blueprint.revision,
          maxConcurrentAgents: 1,
          maxRequests: 20,
          maxReportedCostUsd: 1,
        },
      },
      budget: {
        maxConcurrentAssignments: 1,
        maxRequests: 20,
        maxReportedCostUsd: 1,
      },
    });
    expect(setup.events.find((event) => event.type === "company_goal_started"))
      .toMatchObject({
        topology: "recommended",
        maxActiveAgents: 8,
        maxConcurrentAgents: 1,
        maxDelegationDepth: 2,
        maxRepairRounds: 1,
        maxRequests: 20,
        maxReportedCostUsd: 1,
      });
  });

  it("rejects stored team controls for another operating mode before starting work", async () => {
    const setup = await fixture();
    await setup.teamControls.publish(
      setup.root,
      recommendedTeamControlPolicy("economy_v6"),
      null,
    );

    await expect(setup.supervisor.start(goal(setup), setup.context)).rejects
      .toMatchObject({
        code: "permission_denied",
        message: expect.stringContaining("another operating mode"),
      });
    expect(await setup.runs.list()).toEqual([]);
    expect(setup.prompts).toEqual([]);
  });

  it("resumes with the frozen team controls instead of newer project preferences", async () => {
    const setup = await fixture({
      implementation: true,
      teamStatus: "interrupted",
    });
    const original = {
      ...recommendedTeamControlPolicy("balanced_v6"),
      maxConcurrentAgents: 2,
    };
    await setup.teamControls.publish(setup.root, original, null);
    await expect(setup.supervisor.start(goal(setup), setup.context)).rejects
      .toMatchObject({ code: "checkpoint_conflict" });
    await setup.teamControls.publish(setup.root, {
      ...original,
      revision: 2,
      maxConcurrentAgents: 1,
    }, 1);
    setup.setTeamStatus("approved");

    await setup.supervisor.resume("company-run-id-1", setup.context);

    expect((await setup.runs.load("company-run-id-1")).state).toMatchObject({
      version: 2,
      teamControl: {
        selected: {
          revision: 1,
          maxConcurrentAgents: 2,
        },
        effective: {
          sourceRevision: 1,
          maxConcurrentAgents: 2,
        },
      },
      budget: { maxConcurrentAssignments: 2 },
    });
  });

  it("rejects missing, unknown, and non-default assignment roles before durable work", async () => {
    const missing = await fixture();
    const missingInput = goal(missing);
    await expect(missing.supervisor.start({
      ...missingInput,
      assignments: missingInput.assignments
        .filter((assignment) =>
          assignment.id !== "worker-assignment" &&
          assignment.id !== "implementation-assignment"
        )
        .map((assignment) => assignment.id === "review-assignment"
          ? { ...assignment, dependsOn: ["lead-assignment"] }
          : assignment),
    }, missing.context)).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("Every default-active role"),
    });
    await expect(missing.runs.load("company-run-id-1")).rejects
      .toMatchObject({ code: "not_found" });

    const unknown = await fixture();
    const unknownInput = goal(unknown);
    await expect(unknown.supervisor.start({
      ...unknownInput,
      assignments: unknownInput.assignments.map((assignment) =>
        assignment.id === "worker-assignment"
          ? { ...assignment, roleId: "unknown-role" }
          : assignment
      ),
    }, unknown.context)).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(unknown.runs.load("company-run-id-1")).rejects
      .toMatchObject({ code: "not_found" });

    const inactive = await fixture();
    const inactiveWorker = inactive.roles["Research Worker"]!;
    const inactiveBlueprint = {
      ...inactive.blueprint,
      activation: {
        defaultActiveRoleIds:
          inactive.blueprint.activation.defaultActiveRoleIds.filter(
            (roleId) => roleId !== inactiveWorker.id,
          ),
      },
    };
    await expect(inactive.createSupervisor({
      blueprints: { async load() { return inactiveBlueprint; } },
    }).start(goal(inactive), inactive.context)).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("not active"),
    });
    await expect(inactive.runs.load("company-run-id-1")).rejects
      .toMatchObject({ code: "not_found" });
    expect(inactive.prompts).toEqual([]);
    expect(inactive.teamCalls).toEqual([]);
    expect(inactive.events).toEqual([]);
  });

  it("requires mandatory review and rejects unsupported active profiles at authority", async () => {
    const missingReview = await fixture();
    const input = goal(missingReview);
    await expect(missingReview.supervisor.start({
      ...input,
      assignments: input.assignments.filter((assignment) =>
        assignment.id !== "review-assignment"
      ),
    }, missingReview.context)).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("Every default-active role"),
    });

    const unsupported = await fixture();
    const lead = unsupported.roles["Planning Lead"]!;
    const unsupportedBlueprint = {
      ...unsupported.blueprint,
      roles: unsupported.blueprint.roles.map((role) => role.id === lead.id
        ? {
            ...role,
            executionProfileId: "implement_v1" as const,
            modelRoute: "implement" as const,
          }
        : role),
    };
    await expect(unsupported.createSupervisor({
      blueprints: { async load() { return unsupportedBlueprint; } },
    }).start(goal(unsupported), unsupported.context)).rejects.toMatchObject({
      code: "permission_denied",
      message: expect.stringContaining("execution profile"),
    });
    await expect(unsupported.runs.load("company-run-id-1")).rejects
      .toMatchObject({ code: "not_found" });
    expect(unsupported.prompts).toEqual([]);
    expect(unsupported.teamCalls).toEqual([]);
    expect(unsupported.events).toEqual([]);
  });

  it("revalidates a historical inactive-role plan before resume side effects", async () => {
    const setup = await fixture();
    await seedRecoverableChild(setup);
    const lead = setup.roles["Planning Lead"]!;
    const worker = setup.roles["Research Worker"]!;
    const historicalBlueprint = {
      ...setup.blueprint,
      activation: {
        defaultActiveRoleIds: setup.blueprint.activation.defaultActiveRoleIds
          .filter((roleId) => roleId !== lead.id && roleId !== worker.id),
      },
    };
    const before = await setup.runs.load("recovery-run");
    const prompts = setup.prompts.length;
    const events = setup.events.length;
    const teamCalls = [...setup.teamCalls];
    const childLoads: string[] = [];
    const sessions = {
      async loadState(sessionId: string, signal?: AbortSignal) {
        childLoads.push(sessionId);
        return await setup.sessions.loadState(sessionId, signal);
      },
    };

    await expect(setup.createSupervisor({
      sessions,
      blueprints: { async load() { return historicalBlueprint; } },
    }).resume("recovery-run", setup.context)).rejects.toMatchObject({
      code: "permission_denied",
      message: expect.stringContaining("reporting ancestry"),
    });

    expect(childLoads).toEqual([setup.parent.id]);
    expect(setup.prompts).toHaveLength(prompts);
    expect(setup.events).toHaveLength(events);
    expect(setup.teamCalls).toEqual(teamCalls);
    await expect(setup.runs.load("recovery-run")).resolves.toMatchObject({
      sequence: before.sequence,
      state: {
        status: "running",
        budget: before.state.budget,
      },
    });
  });

  it("rejects a historical review_v2 topology without implementation before resume side effects", async () => {
    const setup = await fixture({
      implementation: true,
      teamStatus: "interrupted",
    });
    await expect(setup.supervisor.start(goal(setup), setup.context)).rejects
      .toMatchObject({ code: "checkpoint_conflict" });
    const implementation = setup.roles["Implementation Worker"]!;
    const historicalBlueprint = {
      ...setup.blueprint,
      roles: setup.blueprint.roles.map((role) => role.id === implementation.id
        ? {
            ...role,
            capabilities: ["review" as const],
            executionProfileId: "review_v1" as const,
            modelRoute: "review" as const,
          }
        : role),
    };
    const before = await setup.runs.load("company-run-id-1");
    const prompts = setup.prompts.length;
    const events = setup.events.length;
    const teamCalls = [...setup.teamCalls];
    const childLoads: string[] = [];
    const sessions = {
      async loadState(sessionId: string, signal?: AbortSignal) {
        childLoads.push(sessionId);
        return await setup.sessions.loadState(sessionId, signal);
      },
    };

    await expect(setup.createSupervisor({
      sessions,
      blueprints: { async load() { return historicalBlueprint; } },
    }).resume("company-run-id-1", {
      ...setup.context,
      signal: new AbortController().signal,
      delegationBudget: createDelegationBudget(setup.parent.agent),
    })).rejects.toMatchObject({
      code: "permission_denied",
      message: expect.stringMatching(/review_v2.*implement_v2/iu),
    });

    expect(childLoads).toEqual([setup.parent.id]);
    expect(setup.prompts).toHaveLength(prompts);
    expect(setup.events).toHaveLength(events);
    expect(setup.teamCalls).toEqual(teamCalls);
    await expect(setup.runs.load("company-run-id-1")).resolves.toMatchObject({
      sequence: before.sequence,
      state: { status: "interrupted", budget: before.state.budget },
    });
  });

  it("never binds inactive repair capacity into a company team", async () => {
    const setup = await fixture({ implementation: true });
    const root = setup.blueprint.roles.find((role) =>
      role.id === setup.blueprint.authorityAnchors.rootRoleId
    )!;
    const worker = setup.roles["Implementation Worker"]!;
    const inactiveRepair = {
      ...worker,
      id: "inactive-repair-role",
      displayName: "Inactive Repair Specialist",
      reportsTo: root.id,
      delegatesTo: [],
      capabilities: ["repair" as const],
      executionProfileId: "repair_v1" as const,
      modelRoute: "repair" as const,
      activation: "on_demand" as const,
    };
    const noAssignedRepair = {
      ...setup.blueprint,
      roles: [
        ...setup.blueprint.roles.map((role) => role.id === root.id
          ? { ...role, delegatesTo: [...role.delegatesTo, inactiveRepair.id] }
          : role.id === worker.id
            ? {
                ...role,
                capabilities: role.capabilities.filter((capability) =>
                  capability !== "repair"
                ),
              }
            : role),
        inactiveRepair,
      ],
    };

    await expect(setup.createSupervisor({
      blueprints: { async load() { return noAssignedRepair; } },
    }).start(goal(setup), setup.context)).resolves.toMatchObject({
      metadata: { status: "completed" },
    });
    expect([...setup.teamCorrelations.values()][0]?.repair).toBeNull();
  });

  it("runs direct review_v1 assignments on their declared Review backend", async () => {
    const reviewPin = testBackendPin("review-model", "review-connection");
    const setup = await fixture({
      implementation: true,
      reviewBackendPin: reviewPin,
    });

    const result = await setup.supervisor.start(goal(setup), setup.context);
    expect(result.output).not.toContain("terminal failure");
    expect(result).toMatchObject({ metadata: { status: "completed" } });

    const run = await setup.runs.load("company-run-id-1");
    const assignment = run.state.plan.assignments.find((candidate) =>
      candidate.id === "direct-review-assignment"
    )!;
    expect(assignment.execution).toMatchObject({
      childSessionId: expect.any(String),
    });
    const child = await setup.sessions.loadState(
      (assignment.execution as { readonly childSessionId: string }).childSessionId,
    );
    expect(child).toMatchObject({
      backend: { pin: reviewPin },
      agent: {
        profile: { id: "review_v1", version: 1 },
        backend: {
          strategy: "policy_route",
          candidateId: "direct-review",
          reason: "eligible_role_candidate",
          adapterId: reviewPin.adapterId,
          connectionId: reviewPin.connectionId,
          modelId: reviewPin.modelId,
        },
      },
    });
  });

  it("runs the Economy builder and reviewer as sequential team phases", async () => {
    const setup = await fixture({
      implementation: true,
      operatingModeId: "economy_v6",
    });
    const builder = setup.roles["Implementation Worker"]!;
    const reviewer = setup.roles["Independent Reviewer"]!;
    const input: DelegateCompanyGoalInput = {
      objective: "Deliver one bounded Economy implementation with review.",
      assignments: [{
        id: "economy-implementation",
        roleId: builder.id,
        parentAssignmentId: null,
        dependsOn: [],
        description: "Implement the Economy slice",
        prompt: "Implement and verify the bounded slice.",
        acceptance: ["Return a verified patch."],
      }, {
        id: "economy-review",
        roleId: reviewer.id,
        parentAssignmentId: null,
        dependsOn: ["economy-implementation"],
        description: "Review the Economy slice",
        prompt: "Independently review the complete patch.",
        acceptance: ["Approve or return findings."],
      }],
    };

    const result = await setup.supervisor.start(input, setup.context);
    expect(result.output).not.toContain("terminal failure");
    expect(result).toMatchObject({ metadata: { status: "completed" } });
    expect(setup.teamCalls).toEqual(["reserve", "start"]);
    const run = await setup.runs.load("company-run-id-1");
    expect(run.state).toMatchObject({
      status: "completed",
      budget: {
        assignmentsStarted: 2,
        maxConcurrentAssignments: 1,
      },
    });
  });

  it("allows exactly one durable start across two supervisor instances", async () => {
    const setup = await fixture({ implementation: true });
    const second = setup.createSupervisor();

    const outcomes = await Promise.allSettled([
      setup.supervisor.start(goal(setup), setup.context),
      second.start(goal(setup), {
        ...setup.context,
        signal: new AbortController().signal,
        delegationBudget: createDelegationBudget(setup.parent.agent),
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled"))
      .toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected"))
      .toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({
            code: "permission_denied",
            message: expect.stringContaining(
              "Do not retry delegate_company_goal",
            ),
          }),
        }),
      ]);
    expect(await setup.runs.list()).toHaveLength(1);
    expect(setup.prompts).toHaveLength(1);
    expect(setup.teamCalls).toEqual(["reserve", "start"]);
    expect(setup.events.filter((event) => event.type === "company_goal_started"))
      .toHaveLength(1);
  });

  it("allows exactly one durable resume across two supervisor instances", async () => {
    const setup = await fixture({
      implementation: true,
      teamStatus: "interrupted",
    });
    await expect(setup.supervisor.start(goal(setup), setup.context)).rejects
      .toMatchObject({ code: "checkpoint_conflict" });
    setup.setTeamStatus("approved");
    const second = setup.createSupervisor();

    const outcomes = await Promise.allSettled([
      setup.supervisor.resume("company-run-id-1", {
        ...setup.context,
        signal: new AbortController().signal,
        delegationBudget: createDelegationBudget(setup.parent.agent),
      }),
      second.resume("company-run-id-1", {
        ...setup.context,
        signal: new AbortController().signal,
        delegationBudget: createDelegationBudget(setup.parent.agent),
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled"))
      .toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected"))
      .toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({
            code: "permission_denied",
            message: expect.stringContaining("already owned"),
          }),
        }),
      ]);
    expect(setup.teamCalls.filter((call) => call === "inspect")).toHaveLength(1);
    await expect(setup.runs.load("company-run-id-1")).resolves.toMatchObject({
      state: { status: "completed" },
    });
  });

  it("fails closed when legacy state has multiple unresolved company runs", async () => {
    const setup = await fixture({
      implementation: true,
      teamStatus: "interrupted",
    });
    await expect(setup.supervisor.start(goal(setup), setup.context)).rejects
      .toMatchObject({ code: "checkpoint_conflict" });
    const selected = await setup.runs.load("company-run-id-1");
    await setup.runs.create({
      ...selected.state,
      id: "legacy-sibling",
      goalId: "legacy-sibling-goal",
    });
    setup.setTeamStatus("approved");

    await expect(setup.supervisor.resume(
      "company-run-id-1",
      setup.context,
    )).rejects.toMatchObject({
      code: "permission_denied",
      message: expect.stringContaining("multiple unresolved"),
    });
    expect(setup.teamCalls.filter((call) => call === "inspect")).toHaveLength(0);
  });

  it("does not generically resume a run waiting for approval", async () => {
    const setup = await fixture({
      implementation: true,
      teamStatus: "interrupted",
    });
    await expect(setup.supervisor.start(goal(setup), setup.context)).rejects
      .toMatchObject({ code: "checkpoint_conflict" });
    const interrupted = await setup.runs.load("company-run-id-1");
    const running = await setup.runs.append(
      interrupted.state.id,
      interrupted.sequence,
      { ...interrupted.state, status: "running" },
    );
    await setup.runs.append(
      running.state.id,
      running.sequence,
      { ...running.state, status: "waiting_for_approval" },
    );
    setup.setTeamStatus("approved");

    await expect(setup.supervisor.resume(
      "company-run-id-1",
      setup.context,
    )).rejects.toMatchObject({
      code: "permission_denied",
      message: expect.stringContaining("waiting for approval"),
    });
    expect(setup.teamCalls.filter((call) => call === "inspect")).toHaveLength(0);
  });

  it.each([
    ["Plan", (context: ToolContext) => ({ ...context, executionMode: "plan" as const })],
    ["stale project", (context: ToolContext) => ({
      ...context,
      cwd: path.join(context.cwd, "stale-project"),
    })],
    ["non-REPL", (context: ToolContext) => ({
      ...context,
      runContext: { ...trusted, invocation: "goal" as const },
    })],
    ["remote", (context: ToolContext) => ({
      ...context,
      runContext: { ...trusted, location: "remote" as const },
    })],
    ["automated", (context: ToolContext) => ({
      ...context,
      runContext: { ...trusted, automation: "scripted" as const },
    })],
    ["unattended", (context: ToolContext) => ({
      ...context,
      runContext: { ...trusted, presence: "unattended" as const },
    })],
    ["non-CLI", (context: ToolContext) => ({
      ...context,
      runContext: { ...trusted, embedding: "desktop" as const },
    })],
    ["missing team apply approval", (context: ToolContext) => ({
      ...context,
      approvedIntents: new Set([
        permissionIntentKey(WORKTREE_ORCHESTRATION_PERMISSION),
      ]),
    })],
    ["missing worktree approval", (context: ToolContext) => ({
      ...context,
      approvedIntents: new Set([
        permissionIntentKey(TEAM_APPLY_PERMISSION),
      ]),
    })],
  ] as const)(
    "rejects %s direct resume authority before durable execution",
    async (label, mutate) => {
      const setup = await fixture({
        implementation: true,
        teamStatus: "interrupted",
      });
      await expect(setup.supervisor.start(goal(setup), setup.context)).rejects
        .toMatchObject({ code: "checkpoint_conflict" });
      setup.setTeamStatus("approved");
      const before = await setup.runs.load("company-run-id-1");

      await expect(setup.supervisor.resume(
        "company-run-id-1",
        mutate({
          ...setup.context,
          signal: new AbortController().signal,
          delegationBudget: createDelegationBudget(setup.parent.agent),
        }),
      )).rejects.toMatchObject({
        code: label === "stale project"
          ? "tool_unavailable"
          : "permission_denied",
      });
      await expect(setup.runs.load("company-run-id-1")).resolves
        .toMatchObject({ sequence: before.sequence, state: { status: "interrupted" } });
      expect(setup.teamCalls.filter((call) => call === "inspect")).toHaveLength(0);
    },
  );

  it("returns completed state idempotently without replaying execution", async () => {
    const setup = await fixture({ implementation: true });
    const completed = await setup.supervisor.start(goal(setup), setup.context);
    const before = await setup.runs.load("company-run-id-1");
    const calls = [...setup.teamCalls];
    const events = setup.events.length;

    const replay = await setup.createSupervisor().resume(
      "company-run-id-1",
      {
        ...setup.context,
        signal: new AbortController().signal,
        delegationBudget: createDelegationBudget(setup.parent.agent),
      },
    );

    expect(replay).toEqual(completed);
    await expect(setup.runs.load("company-run-id-1")).resolves
      .toMatchObject({ sequence: before.sequence, state: { status: "completed" } });
    expect(setup.teamCalls).toEqual(calls);
    expect(setup.events).toHaveLength(events);
  });

  it.each(["failed", "cancelled"] as const)(
    "keeps a %s terminal run truthful during direct resume",
    async (status) => {
      const setup = await fixture({
        implementation: true,
        teamStatus: status,
      });
      const started = setup.supervisor.start(goal(setup), setup.context);
      if (status === "failed") await started;
      else await expect(started).rejects.toMatchObject({ code: "cancelled" });
      const before = await setup.runs.load("company-run-id-1");

      await expect(setup.createSupervisor().resume(
        "company-run-id-1",
        {
          ...setup.context,
          signal: new AbortController().signal,
          delegationBudget: createDelegationBudget(setup.parent.agent),
        },
      )).rejects.toMatchObject({
        code: status === "failed" ? "execution_failed" : "cancelled",
        message: expect.stringContaining(`team ${status}`),
      });
      await expect(setup.runs.load("company-run-id-1")).resolves
        .toMatchObject({ sequence: before.sequence, state: { status } });
    },
  );

  it("runs root to lead to worker to independent review with one durable budget", async () => {
    const setup = await fixture();

    const result = await setup.supervisor.start(goal(setup), setup.context);

    expect(result.output).toContain("Company goal completed");
    const stored = await setup.runs.load("company-run-id-1");
    expect(stored.state).toMatchObject({
      status: "completed",
      budget: {
        assignmentsStarted: 4,
        requestsReserved: 68,
        requestsUsed: 4,
        reportedCostUsd: 0.04,
      },
    });
    expect(stored.state.plan.assignments.map((assignment) => assignment.status))
      .toEqual(["completed", "completed", "completed", "completed"]);
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
      "company_goal_completed",
    ]);
    expect(companyEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "company_assignment_started",
        roleName: "Planning Lead",
      }),
    ]));
    expect(setup.teamCalls).toEqual(["reserve", "start"]);
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
      entriesAdded: 4,
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

      const operation = setup.supervisor.start(goal(setup), setup.context);
      if (teamStatus === "cancelled") {
        await expect(operation).rejects.toMatchObject({ code: "cancelled" });
      } else {
        await expect(operation).resolves.toMatchObject({
          output: expect.stringContaining(
            "terminal failure after acceptance",
          ),
          metadata: {
            goalRunId: "company-run-id-1",
            status: "failed",
          },
        });
      }

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
    const implementation = base.assignments[2]!;
    const review = base.assignments[3]!;
    const input: DelegateCompanyGoalInput = {
      ...base,
      assignments: [
        base.assignments[0]!,
        ...workerIds.map((id) => ({ ...worker, id })),
        { ...implementation, dependsOn: workerIds },
        {
          ...review,
          dependsOn: [
            "lead-assignment",
            ...workerIds,
            "implementation-assignment",
          ],
        },
      ],
    };

    await expect(setup.supervisor.start(input, setup.context))
      .resolves.toMatchObject({
        output: expect.stringMatching(/failure[\s\S]*concurrency/iu),
        metadata: { status: "failed" },
      });
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
    const failed = await fixture({ teamReviewResult: "failure" });
    await expect(failed.supervisor.start(goal(failed), failed.context))
      .resolves.toMatchObject({
        output: expect.stringMatching(/failure[\s\S]*review failed/iu),
        metadata: { status: "failed" },
      });
    await expect(failed.runs.load("company-run-id-1")).resolves.toMatchObject({
      state: { status: "failed" },
    });

    const costly = await fixture({ teamReviewResult: "cost" });
    await expect(costly.supervisor.start(goal(costly), costly.context))
      .resolves.toMatchObject({
        output: expect.stringMatching(/failure[\s\S]*cost/iu),
        metadata: { status: "failed" },
      });
    const stored = await costly.runs.load("company-run-id-1");
    expect(stored.state).toMatchObject({
      status: "failed",
      budget: { reportedCostUsd: 4.02, maxReportedCostUsd: 3 },
    });
  });

  it("preserves unknown usage instead of inventing accounting", async () => {
    const setup = await fixture({ teamReviewResult: "unknown" });
    await setup.supervisor.start(goal(setup), setup.context);
    const run = await setup.runs.load("company-run-id-1");
    expect(run.state.plan.assignments.at(-1)?.result).toMatchObject({
      usage: null,
      usageSource: "unknown",
    });
  });

  it("propagates cancellation into the assignment and goal records", async () => {
    const setup = await fixture({ teamReviewResult: "cancelled" });
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
    expect(run.state.plan.assignments.at(-2)).toMatchObject({
      status: "cancelled",
      failure: "Independent review was cancelled",
    });
    expect(setup.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "company_goal_cancelled",
        status: "cancelled",
      }),
    ]));
  });

  it("recovers a completed durable child before continuing pending review", async () => {
    const setup = await fixture();
    await seedRecoverableChild(setup);

    const result = await setup.supervisor.resume("recovery-run", setup.context);

    expect(result.output).toContain("Company goal completed");
    const recovered = await setup.runs.load("recovery-run");
    expect(recovered.state).toMatchObject({
      status: "completed",
      budget: {
        assignmentsStarted: 4,
        requestsReserved: 68,
        requestsUsed: 4,
        reportedCostUsd: 0.04,
      },
    });
  });

  it.each(["running", "interrupted"] as const)(
    "reconciles an exact completed durable direct Review child from a %s goal without replay",
    async (runStatus) => {
      const reviewPin = testBackendPin("review-model", "review-connection");
      const setup = await fixture({
        implementation: true,
        reviewBackendPin: reviewPin,
      });
      const childSessionId = await seedRecoverableDirectReview(setup, {
        runStatus,
      });
      const promptsBefore = [...setup.prompts];
      const sessionsBefore = await setup.sessions.list();

      const result = await setup.supervisor.resume(
        "direct-review-recovery-run",
        setup.context,
      );

      expect(result).toMatchObject({ metadata: { status: "completed" } });
      expect(setup.prompts).toEqual(promptsBefore);
      await expect(setup.sessions.list()).resolves.toEqual(sessionsBefore);
      expect(setup.events).not.toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "company_assignment_started",
          assignmentId: "direct-review-assignment",
        }),
      ]));
      const recovered = await setup.runs.load("direct-review-recovery-run");
      expect(recovered.state.plan.assignments.find((assignment) =>
        assignment.id === "direct-review-assignment"
      )).toMatchObject({
        status: "completed",
        execution: { childSessionId },
        result: {
          summary: expect.stringContaining("completed"),
          evidence: expect.arrayContaining([expect.any(String)]),
        },
      });
    },
  );

  it.each([
    ["running", "changed"],
    ["running", "missing"],
    ["interrupted", "changed"],
    ["interrupted", "missing"],
  ] as const)(
    "rejects a %s goal with a %s direct Review route before team, provider, event, or journal side effects",
    async (runStatus, routeState) => {
      const setup = await fixture({
        implementation: true,
        reviewBackendPin: testBackendPin("review-model", "review-connection"),
      });
      await seedRecoverableDirectReview(setup, {
        runStatus,
        includeRunningTeam: true,
      });
      let supervisor = setup.supervisor;
      if (routeState === "changed") {
        setup.setReviewBackendPin(
          testBackendPin("changed-review-model", "changed-review-connection"),
        );
      } else {
        supervisor = setup.createSupervisor({
          team: {
            ...setup.team,
            async selectCompanyChildBackend() {
              throw new ToolError(
                "tool_unavailable",
                "No eligible agent backend",
              );
            },
          },
        });
      }

      await expectDirectReviewRecoveryRejectedWithoutSideEffects(
        setup,
        supervisor,
      );
    },
  );

  it.each([
    [
      "running",
      "backend pin",
      ["backend", "pin", "modelId"],
      "corrupted-model",
    ],
    [
      "running",
      "backend selection",
      ["agent", "backend", "candidateId"],
      "corrupted-candidate",
    ],
    [
      "interrupted",
      "backend pin",
      ["backend", "pin", "modelId"],
      "corrupted-model",
    ],
    [
      "interrupted",
      "backend selection",
      ["agent", "backend", "candidateId"],
      "corrupted-candidate",
    ],
  ] as const)(
    "rejects a %s goal with a corrupted persisted direct Review %s without provider or journal side effects",
    async (runStatus, _field, path, replacement) => {
      const setup = await fixture({
        implementation: true,
        reviewBackendPin: testBackendPin("review-model", "review-connection"),
      });
      const childSessionId = await seedRecoverableDirectReview(setup, {
        runStatus,
      });
      const sessions = {
        async loadState(sessionId: string, signal?: AbortSignal) {
          const state = await setup.sessions.loadState(sessionId, signal);
          return sessionId === childSessionId
            ? corruptChildCorrelation(
                state as PinnedSessionState,
                path,
                replacement,
              )
            : state;
        },
      };

      await expectDirectReviewRecoveryRejectedWithoutSideEffects(
        setup,
        setup.createSupervisor({ sessions }),
      );
    },
  );

  it.each(
    (["running", "interrupted"] as const).flatMap((runStatus) =>
      childCorrelationCorruptions.map(([field, path, replacement]) =>
        [runStatus, field, path, replacement] as const
      )
    ),
  )(
    "fails closed without journal mutation when a %s goal has mismatched durable child %s correlation",
    async (runStatus, _field, path, replacement) => {
      const setup = await fixture();
      const childSessionId = await seedRecoverableChild(setup, runStatus);
      const before = await setup.runs.load("recovery-run");
      const sessions = {
        async loadState(sessionId: string) {
          const state = await setup.sessions.loadState(sessionId);
          return sessionId === childSessionId
            ? corruptChildCorrelation(
                state as PinnedSessionState,
                path,
                replacement,
              )
            : state;
        },
      };

      await expect(setup.createSupervisor({ sessions }).resume(
        "recovery-run",
        setup.context,
      )).rejects.toMatchObject({
        code: "execution_failed",
        message: expect.stringContaining("correlation"),
      });
      await expect(setup.runs.load("recovery-run")).resolves.toEqual(before);
    },
  );

  it("does not reconcile a team result after cancellation during inspection", async () => {
    const setup = await fixture({
      implementation: true,
      teamStatus: "interrupted",
    });
    await expect(setup.supervisor.start(goal(setup), setup.context)).rejects
      .toMatchObject({ code: "checkpoint_conflict" });
    setup.setTeamStatus("approved");
    const controller = new AbortController();
    const team = {
      ...setup.team,
      async inspectCompanyRun(
        parentSessionId: string,
        teamRunId: string,
        signal?: AbortSignal,
      ) {
        const result = await setup.team.inspectCompanyRun(
          parentSessionId,
          teamRunId,
        );
        if (signal === controller.signal) controller.abort();
        return result;
      },
    };

    await expect(setup.createSupervisor({ team }).resume(
      "company-run-id-1",
      {
        ...setup.context,
        signal: controller.signal,
        delegationBudget: createDelegationBudget(setup.parent.agent),
      },
    )).rejects.toMatchObject({ code: "cancelled" });
    await expect(setup.runs.load("company-run-id-1")).resolves.toMatchObject({
      state: {
        status: "running",
        budget: { requestsUsed: 1, reportedCostUsd: 0.01 },
        plan: {
          assignments: [
            { status: "completed" },
            { status: "running" },
            { status: "running" },
          ],
        },
      },
    });
  });

  it("does not reconcile a child result after cancellation during loading", async () => {
    const setup = await fixture();
    const childSessionId = await seedRecoverableChild(setup);
    const controller = new AbortController();
    const sessions = {
      async loadState(sessionId: string, signal?: AbortSignal) {
        const state = await setup.sessions.loadState(sessionId);
        if (sessionId === childSessionId && signal === controller.signal) {
          controller.abort();
        }
        return state;
      },
    };

    await expect(setup.createSupervisor({ sessions }).resume(
      "recovery-run",
      { ...setup.context, signal: controller.signal },
    )).rejects.toMatchObject({ code: "cancelled" });
    await expect(setup.runs.load("recovery-run")).resolves.toMatchObject({
      state: {
        status: "running",
        budget: { requestsUsed: 1, reportedCostUsd: 0.01 },
        plan: {
          assignments: [
            { status: "running", result: null },
            { status: "completed", result: expect.any(Object) },
            { status: "pending", result: null },
            { status: "pending", result: null },
          ],
        },
      },
    });
  });

  it("does not complete a goal cancelled after team reconciliation", async () => {
    const setup = await fixture({
      implementation: true,
      teamStatus: "interrupted",
    });
    await expect(setup.supervisor.start(goal(setup), setup.context)).rejects
      .toMatchObject({ code: "checkpoint_conflict" });
    setup.setTeamStatus("approved");
    const controller = new AbortController();
    const runs = {
      create: setup.runs.create.bind(setup.runs),
      load: setup.runs.load.bind(setup.runs),
      list: setup.runs.list.bind(setup.runs),
      append: async (...args: Parameters<typeof setup.runs.append>) => {
        const next = await setup.runs.append(...args);
        if (next.state.status === "running" &&
          next.state.plan.assignments.every(
            (assignment) => assignment.status === "completed",
          )) {
          controller.abort();
        }
        return next;
      },
    };

    await expect(setup.createSupervisor({ runs }).resume(
      "company-run-id-1",
      {
        ...setup.context,
        signal: controller.signal,
        delegationBudget: createDelegationBudget(setup.parent.agent),
      },
    )).rejects.toMatchObject({ code: "cancelled" });
    await expect(setup.runs.load("company-run-id-1")).resolves.toMatchObject({
      state: {
        status: "running",
        result: null,
        plan: {
          assignments: [
            { status: "completed" },
            { status: "completed" },
            { status: "completed" },
          ],
        },
      },
    });
  });
});
