import { randomUUID } from "node:crypto";

import {
  getOperatingModePolicy,
  parseCompanyBlueprintBindingV2,
  parseCompanyGoalPlan,
  parseCompanyGoalRun,
  reserveCompanyGoalBudget,
  validateCompanyGoalPlanAgainstBlueprint,
  type AgentProfileId,
  type CompanyBlueprintV2,
  type CompanyGoalAssignmentV1,
  type CompanyGoalChildExecutionV1,
  type CompanyGoalPlanV1,
  type CompanyGoalRunV1,
  type CompanyToolBundleId,
  type TeamRunCompanyGoalCorrelation,
  type TeamRunCompanyRoleBinding,
} from "@recurs/contracts";
import {
  ToolError,
  type DelegationBudget,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@recurs/tools";

import { childRequestAllowance, delegationWorkflowUsage } from "./agent-profile.js";
import type {
  ChildAgentManager,
  ChildDelegationOptions,
  ChildDelegationResult,
  ChildIdentityReservation,
} from "./child-agent-manager.js";
import type { FileCompanyBlueprintV2Store } from "./file-company-blueprint-v2-store.js";
import type {
  CompanyGoalLearningResult,
  CompanyKnowledgeSelection,
} from "./company-learning.js";
import type { RecursEvent } from "./events.js";
import type { JsonlCompanyGoalStore } from "./jsonl-company-goal-store.js";
import type { JsonlSessionStore } from "./jsonl-session-store.js";
import type { SequencedCompanyState } from "./private-state-store.js";
import { isPinnedSessionState, type PinnedSessionState } from "./session-v2.js";
import type { DelegateTeamInput } from "./team-agent-manager.js";
import {
  TEAM_APPLY_PERMISSION,
  type CompanyTeamRunBudgetLimits,
  type CompanyTeamRunReservation,
  type TeamRunResult,
  type TeamRunSupervisor,
} from "./team-run-supervisor.js";

const MAX_DESCRIPTION_BYTES = 256;
const MAX_PROMPT_BYTES = 32_768;
const encoder = new TextEncoder();

export interface CompanyGoalAssignmentInput {
  readonly id: string;
  readonly roleId: string;
  readonly parentAssignmentId: string | null;
  readonly dependsOn: readonly string[];
  readonly description: string;
  readonly prompt: string;
  readonly acceptance: readonly string[];
}

export interface DelegateCompanyGoalInput {
  readonly objective: string;
  readonly assignments: readonly CompanyGoalAssignmentInput[];
}

export interface RequestCompanyHandoffInput {
  readonly runId: string;
  readonly assignmentId: string;
}

export interface CompanyGoalAssignmentExecutor {
  reserveIdentity: ChildAgentManager["reserveIdentity"];
  delegate: ChildAgentManager["delegate"];
}

export type CompanyGoalTeamExecutor = Pick<
  TeamRunSupervisor,
  "reserveCompanyRun" | "startCompanyForeground" | "inspectCompanyRun"
>;

export interface CompanyGoalSupervisorDependencies {
  readonly sessions: Pick<JsonlSessionStore, "loadState">;
  readonly blueprints: Pick<FileCompanyBlueprintV2Store, "load">;
  readonly runs: Pick<JsonlCompanyGoalStore, "create" | "append" | "load">;
  readonly children: CompanyGoalAssignmentExecutor;
  /** Mutating/review/repair work must be supplied by the durable team adapter. */
  readonly work?: CompanyGoalAssignmentExecutor;
  readonly team?: CompanyGoalTeamExecutor;
  readonly learning?: {
    selectCompanyKnowledge(input: {
      readonly companyId: string;
      readonly query: string;
      readonly asOf: string;
      readonly maximumEntries: number;
      readonly maximumBytes: number;
      readonly signal?: AbortSignal;
    }): Promise<CompanyKnowledgeSelection>;
    recordCompletedGoal(input: {
      readonly blueprint: CompanyBlueprintV2;
      readonly run: CompanyGoalRunV1;
      readonly at: string;
      readonly signal?: AbortSignal;
    }): Promise<CompanyGoalLearningResult>;
  };
  emit(event: RecursEvent): Promise<void>;
  readonly createId?: () => string;
  readonly now?: () => string;
}

type RunState = SequencedCompanyState<CompanyGoalRunV1>;

function exactRecord(
  value: unknown,
  keys: readonly string[],
  message: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_input", message);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== [...keys].sort().join(",")) {
    throw new ToolError("invalid_input", message);
  }
  return record;
}

function boundedText(value: unknown, maximum: number, message: string): string {
  if (typeof value !== "string") throw new ToolError("invalid_input", message);
  const parsed = value.trim();
  if (parsed.length === 0 || encoder.encode(parsed).byteLength > maximum) {
    throw new ToolError("invalid_input", message);
  }
  return parsed;
}

function truncateUtf8(value: string, maximum: number, suffix = ""): string {
  if (encoder.encode(value).byteLength <= maximum) return value;
  const suffixBytes = encoder.encode(suffix).byteLength;
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maximum - suffixBytes) break;
    output += character;
    bytes += size;
  }
  return `${output.trimEnd()}${suffix}`;
}

function boundedEvidence(values: readonly string[], maximum = 64): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .slice(0, maximum)
    .map((value) => truncateUtf8(value, 2_000, " [truncated]"));
}

function parseAssignments(value: unknown): CompanyGoalAssignmentInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new ToolError("invalid_input", "Company goal assignments are invalid");
  }
  return value.map((entry) => {
    const item = exactRecord(entry, [
      "id", "roleId", "parentAssignmentId", "dependsOn", "description",
      "prompt", "acceptance",
    ], "Each company assignment must contain exactly the documented fields");
    if (typeof item.id !== "string" || typeof item.roleId !== "string" ||
      (item.parentAssignmentId !== null &&
        typeof item.parentAssignmentId !== "string") ||
      !Array.isArray(item.dependsOn) ||
      item.dependsOn.some((id) => typeof id !== "string") ||
      !Array.isArray(item.acceptance) ||
      item.acceptance.some((criterion) => typeof criterion !== "string")) {
      throw new ToolError("invalid_input", "Company assignment fields are invalid");
    }
    return {
      id: item.id,
      roleId: item.roleId,
      parentAssignmentId: item.parentAssignmentId as string | null,
      dependsOn: item.dependsOn as string[],
      description: boundedText(
        item.description,
        MAX_DESCRIPTION_BYTES,
        "Company assignment description is invalid",
      ),
      prompt: boundedText(
        item.prompt,
        MAX_PROMPT_BYTES,
        "Company assignment prompt is invalid",
      ),
      acceptance: item.acceptance as string[],
    };
  });
}

function parseGoalInput(value: unknown): DelegateCompanyGoalInput {
  const record = exactRecord(
    value,
    ["objective", "assignments"],
    "delegate_company_goal requires exactly objective and assignments",
  );
  return {
    objective: boundedText(
      record.objective,
      4_000,
      "Company goal objective is invalid",
    ),
    assignments: parseAssignments(record.assignments),
  };
}

function parseHandoffInput(value: unknown): RequestCompanyHandoffInput {
  const record = exactRecord(
    value,
    ["runId", "assignmentId"],
    "request_company_handoff requires exactly runId and assignmentId",
  );
  return {
    runId: boundedText(record.runId, 128, "Company goal run id is invalid"),
    assignmentId: boundedText(
      record.assignmentId,
      128,
      "Company assignment id is invalid",
    ),
  };
}

function safeMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;
  const message = raw.trim().length === 0 ? fallback : raw.trim();
  return truncateUtf8(message, 2_000, " [truncated]");
}

function isCancelled(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || error instanceof ToolError && error.code === "cancelled";
}

function isChildExecution(
  execution: NonNullable<CompanyGoalAssignmentV1["execution"]>,
): execution is CompanyGoalChildExecutionV1 {
  return "childSessionId" in execution;
}

function isTeamExecution(
  execution: NonNullable<CompanyGoalAssignmentV1["execution"]>,
): execution is Extract<
  NonNullable<CompanyGoalAssignmentV1["execution"]>,
  { readonly teamRunId: string }
> {
  return "teamRunId" in execution;
}

function mutatingProfile(profile: AgentProfileId | null): boolean {
  return profile === "implement_v2" || profile === "repair_v1";
}

function sortedToolBundles(
  bundles: readonly CompanyToolBundleId[],
): readonly CompanyToolBundleId[] {
  return Object.freeze([...new Set(bundles)].sort());
}

function mutableBudget(run: CompanyGoalRunV1): DelegationBudget {
  return {
    maxChildren: run.budget.maxAssignments,
    childrenStarted: run.budget.assignmentsStarted,
    maxRequests: run.budget.maxRequests,
    requestsReserved: run.budget.requestsReserved,
    requestsUsed: run.budget.requestsUsed,
    maxReportedCostUsd: run.budget.maxReportedCostUsd,
    reportedCostUsd: run.budget.reportedCostUsd,
  };
}

function withBudget(
  run: CompanyGoalRunV1,
  budget: DelegationBudget,
): CompanyGoalRunV1["budget"] {
  return {
    maxAssignments: budget.maxChildren,
    assignmentsStarted: budget.childrenStarted,
    maxConcurrentAssignments: run.budget.maxConcurrentAssignments,
    maxRequests: budget.maxRequests,
    requestsReserved: budget.requestsReserved,
    requestsUsed: budget.requestsUsed,
    maxReportedCostUsd: budget.maxReportedCostUsd,
    reportedCostUsd: budget.reportedCostUsd,
  };
}

function assignmentDepth(
  assignment: CompanyGoalAssignmentV1,
  assignments: ReadonlyMap<string, CompanyGoalAssignmentV1>,
): number {
  let current = assignment;
  let depth = 1;
  while (current.parentAssignmentId !== null) {
    current = assignments.get(current.parentAssignmentId)!;
    depth += 1;
  }
  return depth;
}

function buildPlan(
  input: DelegateCompanyGoalInput,
  blueprint: CompanyBlueprintV2,
  at: string,
): CompanyGoalPlanV1 {
  const roles = new Map(blueprint.roles.map((role) => [role.id, role] as const));
  let plan: CompanyGoalPlanV1;
  try {
    plan = parseCompanyGoalPlan({
      revision: 1,
      createdAt: at,
      assignments: input.assignments.map((assignment) => ({
        ...assignment,
        expectedEvidence: roles.get(assignment.roleId)?.expectedEvidence ?? [],
        status: "pending",
        result: null,
        failure: null,
      })),
    });
    validateCompanyGoalPlanAgainstBlueprint(plan, blueprint);
  } catch (error) {
    throw new ToolError(
      "invalid_input",
      safeMessage(error, "Company goal plan is invalid"),
    );
  }
  validatePlanPolicy(plan, blueprint);
  return plan;
}

function validatePlanPolicy(
  plan: CompanyGoalPlanV1,
  blueprint: CompanyBlueprintV2,
): void {
  const roles = new Map(blueprint.roles.map((role) => [role.id, role] as const));
  const mode = getOperatingModePolicy(blueprint.authority.operatingModeId);
  const company = mode.company!;
  const root = roles.get(blueprint.authorityAnchors.rootRoleId)!;
  const byId = new Map(plan.assignments.map((item) => [item.id, item] as const));
  const activeRoles = new Set([root.id, ...plan.assignments.map((item) => item.roleId)]);
  if (plan.assignments.length > company.maxActiveRoles ||
    activeRoles.size > company.maxActiveRoles ||
    plan.assignments.some((assignment) =>
      assignmentDepth(assignment, byId) > company.maxDepth
    )) {
    throw new ToolError(
      "permission_denied",
      "Company goal plan exceeds its active-role or depth policy",
    );
  }
  for (const assignment of plan.assignments) {
    const role = roles.get(assignment.roleId)!;
    if (assignment.parentAssignmentId === null &&
      !root.delegatesTo.includes(role.id)) {
      throw new ToolError(
        "permission_denied",
        "Top-level company assignments must be delegated by the root role",
      );
    }
  }
  const reviewers = new Set(blueprint.authorityAnchors.independentReviewRoleIds);
  const reviewAssignments = plan.assignments.filter((item) => reviewers.has(item.roleId));
  if ([...reviewers].some((roleId) =>
    !reviewAssignments.some((assignment) => assignment.roleId === roleId)
  )) {
    throw new ToolError(
      "permission_denied",
      "Every company goal requires its approved independent-review authority",
    );
  }
  const nonReviewIds = plan.assignments
    .filter((item) => !reviewers.has(item.roleId))
    .map((item) => item.id);
  if (reviewAssignments.some((review) =>
    review.parentAssignmentId !== null ||
    nonReviewIds.some((id) => !review.dependsOn.includes(id))
  )) {
    throw new ToolError(
      "permission_denied",
      "Independent review must be top-level and follow every non-review assignment",
    );
  }
  const implementationIds = new Set(plan.assignments.filter((assignment) =>
    roles.get(assignment.roleId)?.executionProfileId === "implement_v2"
  ).map((assignment) => assignment.id));
  if ([...implementationIds].some((id) => {
    const assignment = byId.get(id)!;
    return (assignment.parentAssignmentId !== null &&
        implementationIds.has(assignment.parentAssignmentId)) ||
      assignment.dependsOn.some((dependency) => implementationIds.has(dependency));
  })) {
    throw new ToolError(
      "permission_denied",
      "Company implementation assignments must form one parallel reviewed batch",
    );
  }
}

function rolePrompt(
  run: CompanyGoalRunV1,
  blueprint: CompanyBlueprintV2,
  assignment: CompanyGoalAssignmentV1,
  knowledgeContext: string,
): string {
  const role = blueprint.roles.find((candidate) => candidate.id === assignment.roleId)!;
  const dependencies = run.plan.assignments
    .filter((candidate) => assignment.dependsOn.includes(candidate.id))
    .map((candidate) => [
      `Handoff ${candidate.id}: ${candidate.result?.summary ?? "No result"}`,
      ...(candidate.result?.evidence ?? []).map((item) => `Evidence: ${item}`),
    ].join("\n"));
  const text = [
    `You are the approved Recurs company role: ${role.displayName}.`,
    `Responsibility: ${role.responsibility}`,
    role.instructions,
    ...(knowledgeContext.length === 0 ? [] : [knowledgeContext]),
    `Company goal: ${run.objective}`,
    `Assignment: ${assignment.prompt}`,
    "Acceptance:",
    ...assignment.acceptance.map((item) => `- ${item}`),
    "Required evidence:",
    ...assignment.expectedEvidence.map((item) => `- ${item}`),
    ...(dependencies.length === 0 ? [] : ["Prior handoffs:", ...dependencies]),
    "Return a concise result with concrete evidence. Do not exceed this assignment.",
  ].join("\n\n");
  return truncateUtf8(
    text,
    MAX_PROMPT_BYTES,
    "\n[company prompt truncated by Recurs]",
  );
}

class GoalJournal {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly runs: Pick<JsonlCompanyGoalStore, "append">,
    public current: RunState,
  ) {}

  update(
    transform: (run: CompanyGoalRunV1) => CompanyGoalRunV1,
    signal?: AbortSignal,
  ): Promise<RunState> {
    const operation = this.#tail.then(async () => {
      const next = parseCompanyGoalRun(transform(this.current.state));
      this.current = await this.runs.append(
        next.id,
        this.current.sequence,
        next,
        signal,
      );
    });
    this.#tail = operation.catch(() => undefined);
    return operation.then(() => this.current);
  }
}

interface ActiveCompanyGoal {
  readonly blueprint: CompanyBlueprintV2;
  readonly journal: GoalJournal;
  readonly rootContext: ToolContext;
  readonly root: PinnedSessionState;
  readonly knowledgeContext: string;
  readonly knowledgeRevision: number | null;
  readonly budget: DelegationBudget;
  readonly activeAssignments: Set<string>;
}

interface PreparedCompanyTeam {
  readonly assignments: readonly CompanyGoalAssignmentV1[];
  readonly input: DelegateTeamInput;
  readonly correlation: TeamRunCompanyGoalCorrelation;
}

export class CompanyGoalSupervisor {
  readonly #createId: () => string;
  readonly #now: () => string;
  readonly #activeRuns = new Map<string, ActiveCompanyGoal>();
  readonly #assignmentBySession = new Map<string, {
    readonly runId: string;
    readonly assignmentId: string;
  }>();

  constructor(private readonly dependencies: CompanyGoalSupervisorDependencies) {
    this.#createId = dependencies.createId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  createTool(): Tool<DelegateCompanyGoalInput> {
    return {
      definition: {
        name: "delegate_company_goal",
        description: [
          "Run one approved goal through the active Recurs company.",
          "Assignments must form a bounded role DAG and include independent review.",
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: {
            objective: { type: "string" },
            assignments: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  roleId: { type: "string" },
                  parentAssignmentId: { type: ["string", "null"] },
                  dependsOn: { type: "array", items: { type: "string" } },
                  description: { type: "string" },
                  prompt: { type: "string" },
                  acceptance: { type: "array", items: { type: "string" } },
                },
                required: [
                  "id", "roleId", "parentAssignmentId", "dependsOn",
                  "description", "prompt", "acceptance",
                ],
                additionalProperties: false,
              },
            },
          },
          required: ["objective", "assignments"],
          additionalProperties: false,
        },
      },
      executionClass: "in_process",
      mutating: true,
      checkpointOwnership: "self_managed",
      parse: parseGoalInput,
      permissions() {
        return [
          TEAM_APPLY_PERMISSION,
          {
            category: "shell",
            resource: "fixed Git worktree orchestration",
            risk: "normal",
          },
        ];
      },
      execute: (input, context) => this.start(input, context),
    };
  }

  createHandoffTool(): Tool<RequestCompanyHandoffInput> {
    return {
      definition: {
        name: "request_company_handoff",
        description: "Execute one already-approved child assignment from the active company goal plan.",
        inputSchema: {
          type: "object",
          properties: {
            runId: { type: "string" },
            assignmentId: { type: "string" },
          },
          required: ["runId", "assignmentId"],
          additionalProperties: false,
        },
      },
      executionClass: "in_process",
      mutating: true,
      available: (context) => this.#assignmentBySession.has(context.sessionId),
      parse: parseHandoffInput,
      permissions() { return []; },
      execute: (input, context) => this.requestHandoff(input, context),
    };
  }

  async #emit(event: RecursEvent): Promise<void> {
    try {
      await this.dependencies.emit(event);
    } catch {
      // Durable goal state remains authoritative; presentation is best effort.
    }
  }

  async #knowledge(
    blueprint: CompanyBlueprintV2,
    objective: string,
    runCreatedAt: string,
    signal: AbortSignal,
  ): Promise<CompanyKnowledgeSelection> {
    if (this.dependencies.learning === undefined) {
      return Object.freeze({
        revision: null,
        entries: Object.freeze([]),
        context: "",
      });
    }
    try {
      const beforeRun = new Date(
        new Date(runCreatedAt).valueOf() - 1,
      ).toISOString();
      return await this.dependencies.learning.selectCompanyKnowledge({
        companyId: blueprint.companyId,
        query: objective,
        asOf: beforeRun,
        maximumEntries: 12,
        maximumBytes: 8_192,
        signal,
      });
    } catch {
      throw new ToolError(
        "execution_failed",
        "Company knowledge context is unavailable",
      );
    }
  }

  async #learn(
    runtime: ActiveCompanyGoal,
    run: CompanyGoalRunV1,
  ): Promise<CompanyGoalLearningResult | null> {
    if (this.dependencies.learning === undefined) return null;
    try {
      return await this.dependencies.learning.recordCompletedGoal({
        blueprint: runtime.blueprint,
        run,
        at: run.updatedAt,
        signal: runtime.rootContext.signal,
      });
    } catch {
      await this.#emit({
        type: "warning",
        sessionId: runtime.root.id,
        at: this.#now(),
        code: "company_learning_failed",
        message: "Company goal completed, but project learning could not be updated",
      });
      return null;
    }
  }

  async #authority(
    context: ToolContext,
  ): Promise<{ root: PinnedSessionState; blueprint: CompanyBlueprintV2 }> {
    const root = await this.dependencies.sessions.loadState(context.sessionId);
    if (!isPinnedSessionState(root) || root.agent.role !== "parent" ||
      root.cwd !== context.cwd || root.agent.company?.blueprintVersion !== 2 ||
      root.agent.company.roleId.length === 0) {
      throw new ToolError("tool_unavailable", "No approved V2 company is active");
    }
    const blueprint = await this.dependencies.blueprints.load(
      root.agent.company.blueprintId,
      context.signal,
    );
    const binding = root.agent.company;
    if (blueprint.state !== "approved" || blueprint.revision !== binding.blueprintRevision ||
      blueprint.authorityAnchors.rootRoleId !== binding.roleId ||
      blueprint.authority.operatingModeId !== root.agent.operatingMode.id ||
      blueprint.authority.operatingModeVersion !== root.agent.operatingMode.version ||
      blueprint.authority.permissionMode !== root.permissionMode ||
      root.executionMode !== context.executionMode) {
      throw new ToolError(
        "permission_denied",
        "The approved company no longer matches the live parent authority",
      );
    }
    return { root, blueprint };
  }

  #executor(profile: AgentProfileId): CompanyGoalAssignmentExecutor {
    return profile === "explore_v1" || profile === "review_v1"
      ? this.dependencies.children
      : this.dependencies.work ?? (() => {
          throw new ToolError(
            "tool_unavailable",
            "Company implementation and independent review require the durable team engine",
          );
        })();
  }

  #claim(runtime: ActiveCompanyGoal, assignmentId: string): () => void {
    if (runtime.activeAssignments.has(assignmentId)) {
      throw new ToolError("permission_denied", "Company assignment is already running");
    }
    if (runtime.activeAssignments.size >=
      runtime.journal.current.state.budget.maxConcurrentAssignments) {
      throw new ToolError(
        "permission_denied",
        "Company goal concurrency limit is reached",
      );
    }
    runtime.activeAssignments.add(assignmentId);
    return () => runtime.activeAssignments.delete(assignmentId);
  }

  async #assignmentContext(
    runtime: ActiveCompanyGoal,
    assignment: CompanyGoalAssignmentV1,
  ): Promise<ToolContext> {
    if (assignment.parentAssignmentId === null) {
      return { ...runtime.rootContext, delegationBudget: runtime.budget };
    }
    const parent = runtime.journal.current.state.plan.assignments.find(
      (candidate) => candidate.id === assignment.parentAssignmentId,
    );
    const parentExecution = parent?.execution;
    const sessionId = parentExecution !== undefined &&
      isChildExecution(parentExecution)
      ? parentExecution.childSessionId
      : undefined;
    if (sessionId === undefined || parent === undefined) {
      throw new ToolError(
        "execution_failed",
        "Parent company assignment has no durable child session",
      );
    }
    const state = await this.dependencies.sessions.loadState(sessionId);
    if (!isPinnedSessionState(state) || state.cwd !== runtime.root.cwd ||
      state.agent.company?.blueprintVersion !== 2 ||
      state.agent.company.roleId !== parent.roleId) {
      throw new ToolError(
        "execution_failed",
        "Parent company handoff session is unavailable",
      );
    }
    return {
      ...runtime.rootContext,
      sessionId: state.id,
      executionMode: state.executionMode,
      delegationBudget: runtime.budget,
    };
  }

  #teamBinding(
    runtime: ActiveCompanyGoal,
    assignment: CompanyGoalAssignmentV1,
    requiredBundle: CompanyToolBundleId,
  ): TeamRunCompanyRoleBinding {
    const role = runtime.blueprint.roles.find(
      (candidate) => candidate.id === assignment.roleId,
    )!;
    const toolBundles = sortedToolBundles(role.toolBundles);
    if (!toolBundles.includes(requiredBundle)) {
      throw new ToolError(
        "permission_denied",
        `${role.displayName} lacks the approved ${requiredBundle} tool bundle`,
      );
    }
    return Object.freeze({
      assignmentId: assignment.id,
      parentAssignmentId: assignment.parentAssignmentId,
      roleId: role.id,
      departmentId: role.departmentId,
      permissionMode: role.permissionMode,
      modelRoute: role.modelRoute,
      toolBundles,
    });
  }

  #companyTeam(
    runtime: ActiveCompanyGoal,
  ): PreparedCompanyTeam | null {
    const run = runtime.journal.current.state;
    const roles = new Map(runtime.blueprint.roles.map((role) => [role.id, role]));
    const implementations = run.plan.assignments.filter((assignment) =>
      assignment.status === "pending" &&
      roles.get(assignment.roleId)?.executionProfileId === "implement_v2"
    );
    if (implementations.length === 0) return null;
    const implementationIds = new Set(implementations.map((item) => item.id));
    const dependencyReady = (assignment: CompanyGoalAssignmentV1): boolean => {
      const parentReady = assignment.parentAssignmentId === null ||
        run.plan.assignments.find((candidate) =>
          candidate.id === assignment.parentAssignmentId
        )?.status === "completed";
      return parentReady && assignment.dependsOn.every((id) =>
        run.plan.assignments.find((candidate) => candidate.id === id)?.status ===
          "completed"
      );
    };
    if (!implementations.every(dependencyReady)) return null;
    const independentRoles = new Set(
      runtime.blueprint.authorityAnchors.independentReviewRoleIds,
    );
    const reviews = run.plan.assignments.filter((assignment) =>
      assignment.status === "pending" && independentRoles.has(assignment.roleId)
    );
    if (reviews.length === 0 || reviews.some((assignment) =>
      roles.get(assignment.roleId)?.executionProfileId !== "review_v2" ||
      assignment.dependsOn.some((id) => {
        const dependency = run.plan.assignments.find((item) => item.id === id);
        return dependency?.status !== "completed" && !implementationIds.has(id);
      })
    )) {
      throw new ToolError(
        "permission_denied",
        "Company implementation requires every independent review assignment in the durable team",
      );
    }
    const mode = getOperatingModePolicy(runtime.root.agent.operatingMode.id);
    const policy = mode.workflow.team;
    if (policy === null || implementations.length > policy.maxImplementers ||
      reviews.length > policy.maxReviewers) {
      throw new ToolError(
        "permission_denied",
        "Company implementation batch exceeds the operating-mode team policy",
      );
    }
    const implementationBindings = implementations.map((assignment) =>
      this.#teamBinding(runtime, assignment, "implementation_v1")
    );
    const reviewBindings = reviews.map((assignment) =>
      this.#teamBinding(runtime, assignment, "quality_v1")
    );
    const repairRole = runtime.blueprint.roles.find((role) =>
      role.capabilities.includes("repair") &&
      role.toolBundles.includes("implementation_v1")
    ) ?? roles.get(implementations[0]!.roleId)!;
    const repairBundles = sortedToolBundles(repairRole.toolBundles);
    if (!repairBundles.includes("implementation_v1")) {
      throw new ToolError(
        "permission_denied",
        "Company implementation has no approved repair authority",
      );
    }
    const repair = policy.maxRepairRounds === 0
      ? null
      : Object.freeze({
          assignmentId: implementations[0]!.id,
          parentAssignmentId: implementations[0]!.parentAssignmentId,
          roleId: repairRole.id,
          departmentId: repairRole.departmentId,
          permissionMode: repairRole.permissionMode,
          modelRoute: repairRole.modelRoute,
          toolBundles: repairBundles,
        });
    const correlation: TeamRunCompanyGoalCorrelation = Object.freeze({
      version: 1,
      runId: run.id,
      goalId: run.goalId,
      blueprintId: runtime.blueprint.id,
      blueprintRevision: runtime.blueprint.revision,
      implementations: Object.freeze(implementationBindings),
      reviews: Object.freeze(reviewBindings),
      repair,
    });
    const input: DelegateTeamInput = Object.freeze({
      description: truncateUtf8(run.objective, MAX_DESCRIPTION_BYTES),
      tasks: Object.freeze(implementations.map((assignment) => ({
        description: assignment.description,
        prompt: rolePrompt(
          run,
          runtime.blueprint,
          assignment,
          runtime.knowledgeContext,
        ),
      }))),
      review: Object.freeze({
        instructions: truncateUtf8([
          `Independently review the complete company goal: ${run.objective}`,
          ...reviews.map((assignment) => rolePrompt(
            run,
            runtime.blueprint,
            assignment,
            runtime.knowledgeContext,
          )),
        ].join("\n\n"), 12_000, "\n[review instructions truncated by Recurs]"),
      }),
      execution: "foreground",
    });
    return {
      assignments: Object.freeze([...implementations, ...reviews]),
      input,
      correlation,
    };
  }

  async #markTeamStarted(
    runtime: ActiveCompanyGoal,
    assignments: readonly CompanyGoalAssignmentV1[],
    reservation: CompanyTeamRunReservation,
  ): Promise<void> {
    const run = runtime.journal.current.state;
    if (run.budget.assignmentsStarted + assignments.length >
        run.budget.maxAssignments ||
      run.budget.requestsReserved + reservation.allocation.maxRequests >
        run.budget.maxRequests ||
      assignments.length > run.budget.maxConcurrentAssignments) {
      throw new ToolError(
        "permission_denied",
        "Company team exceeds the remaining goal budget",
      );
    }
    const ids = new Set(assignments.map((assignment) => assignment.id));
    const at = this.#now();
    await runtime.journal.update((current) => ({
      ...current,
      updatedAt: at,
      plan: {
        ...current.plan,
        assignments: current.plan.assignments.map((assignment) =>
          !ids.has(assignment.id)
            ? assignment
            : {
                ...assignment,
                status: "running" as const,
                execution: {
                  attempt: 1 as const,
                  teamRunId: reservation.teamRunId,
                  teamRole: reservation.companyGoal.implementations.some(
                    (binding) => binding.assignmentId === assignment.id,
                  ) ? "implement" as const : "review" as const,
                  taskIndex: (() => {
                    const index = reservation.companyGoal.implementations.findIndex(
                      (binding) => binding.assignmentId === assignment.id,
                    );
                    return index < 0 ? null : index + 1;
                  })(),
                  startedAt: at,
                  completedAt: null,
                },
              }
        ),
      },
      budget: {
        ...current.budget,
        assignmentsStarted:
          current.budget.assignmentsStarted + assignments.length,
        requestsReserved:
          current.budget.requestsReserved + reservation.allocation.maxRequests,
      },
    }));
    this.#reconcileBudget(runtime);
  }

  async #markStarted(
    runtime: ActiveCompanyGoal,
    assignment: CompanyGoalAssignmentV1,
    identity: ChildIdentityReservation,
  ): Promise<void> {
    const allowance = childRequestAllowance(runtime.root.agent);
    await runtime.journal.update((run) => ({
      ...run,
      updatedAt: this.#now(),
      plan: {
        ...run.plan,
        assignments: run.plan.assignments.map((candidate) =>
          candidate.id !== assignment.id
            ? candidate
            : {
                ...candidate,
                status: "running" as const,
                execution: {
                  attempt: 1 as const,
                  ...identity,
                  startedAt: this.#now(),
                  completedAt: null,
                },
              }
        ),
      },
      budget: reserveCompanyGoalBudget(run.budget, allowance),
    }));
  }

  #reconcileBudget(runtime: ActiveCompanyGoal): void {
    const durable = runtime.journal.current.state.budget;
    runtime.budget.childrenStarted = Math.max(
      runtime.budget.childrenStarted,
      durable.assignmentsStarted,
    );
    runtime.budget.requestsReserved = Math.max(
      runtime.budget.requestsReserved,
      durable.requestsReserved,
    );
    runtime.budget.requestsUsed = Math.max(
      runtime.budget.requestsUsed,
      durable.requestsUsed,
    );
    runtime.budget.reportedCostUsd = Math.max(
      runtime.budget.reportedCostUsd,
      durable.reportedCostUsd,
    );
  }

  async #completeAssignment(
    runtime: ActiveCompanyGoal,
    assignment: CompanyGoalAssignmentV1,
    result: ChildDelegationResult,
  ): Promise<void> {
    const evidence = boundedEvidence(result.metadata.evidence);
    if (evidence.length === 0 || result.metadata.costLimitExceeded) {
      throw new ToolError(
        "execution_failed",
        evidence.length === 0
          ? "Company child returned no attributable evidence"
          : "Company goal reported-cost ceiling was exceeded",
      );
    }
    const usageSource = result.metadata.usage === null
      ? "unknown" as const
      : result.metadata.usageSource === "runtime"
        ? "runtime" as const
        : "provider" as const;
    await runtime.journal.update((run) => ({
      ...run,
      updatedAt: this.#now(),
      plan: {
        ...run.plan,
        assignments: run.plan.assignments.map((candidate) =>
          candidate.id !== assignment.id
            ? candidate
            : {
                ...candidate,
                status: "completed" as const,
                execution: {
                  ...candidate.execution!,
                  completedAt: this.#now(),
                },
                result: {
                  summary: truncateUtf8(result.output, 8_192, " [truncated]"),
                  evidence,
                  usage: result.metadata.usage,
                  usageSource,
                },
              }
        ),
      },
      budget: withBudget(run, runtime.budget),
    }));
  }

  #nextTeamBudget(
    run: CompanyGoalRunV1,
    result: TeamRunResult,
  ): CompanyGoalRunV1["budget"] {
    const requestsUsed = run.budget.requestsUsed +
      result.metadata.accounting.requestsUsed;
    const reportedCostUsd = run.budget.reportedCostUsd +
      (result.metadata.accounting.reportedCostUsd ?? 0);
    if (requestsUsed > run.budget.requestsReserved) {
      throw new ToolError(
        "execution_failed",
        "Company team used more requests than its durable reservation",
      );
    }
    return {
      ...run.budget,
      requestsUsed,
      reportedCostUsd,
    };
  }

  async #failTeamAssignments(
    runtime: ActiveCompanyGoal,
    teamRunId: string,
    reason: string,
    cancelled: boolean,
    result?: TeamRunResult,
  ): Promise<void> {
    const at = this.#now();
    await runtime.journal.update((run) => ({
      ...run,
      updatedAt: at,
      plan: {
        ...run.plan,
        assignments: run.plan.assignments.map((assignment) =>
          assignment.execution !== undefined &&
            isTeamExecution(assignment.execution) &&
            assignment.execution.teamRunId === teamRunId &&
            assignment.status === "running"
            ? {
                ...assignment,
                status: cancelled ? "cancelled" as const : "failed" as const,
                execution: { ...assignment.execution, completedAt: at },
                result: null,
                failure: truncateUtf8(reason, 2_000, " [truncated]"),
              }
            : assignment
        ),
      },
      budget: result === undefined ? run.budget : this.#nextTeamBudget(run, result),
    }));
    this.#reconcileBudget(runtime);
  }

  async #settleTeamResult(
    runtime: ActiveCompanyGoal,
    teamRunId: string,
    result: TeamRunResult,
  ): Promise<"settled" | "interrupted"> {
    const running = runtime.journal.current.state.plan.assignments.filter(
      (assignment) => assignment.status === "running" &&
        assignment.execution !== undefined &&
        isTeamExecution(assignment.execution) &&
        assignment.execution.teamRunId === teamRunId,
    );
    const company = result.metadata.companyGoal;
    if (running.length === 0 || company?.goalRunId !==
        runtime.journal.current.state.id ||
      company.assignments.length !== running.length ||
      new Set(company.assignments.map((assignment) => assignment.assignmentId)).size !==
        company.assignments.length ||
      running.some((assignment) => !company.assignments.some(
        (candidate) => candidate.assignmentId === assignment.id,
      ))) {
      await this.#failTeamAssignments(
        runtime,
        teamRunId,
        "Company team result did not match its durable assignment reservation",
        false,
        result,
      );
      return "settled";
    }
    if (result.metadata.status !== "approved" &&
      result.metadata.status !== "changes_requested" &&
      result.metadata.status !== "unverified" &&
      result.metadata.status !== "failed" &&
      result.metadata.status !== "cancelled") {
      await runtime.journal.update((run) => ({
        ...run,
        status: "interrupted",
        updatedAt: this.#now(),
      }));
      this.#reconcileBudget(runtime);
      await this.#emit({
        type: "company_goal_interrupted",
        sessionId: runtime.root.id,
        at: this.#now(),
        parentAgentId: runtime.root.agent.id,
        goalRunId: runtime.journal.current.state.id,
        status: "interrupted",
        evidence: [...result.metadata.evidence],
        reason: `Company team requires recovery from ${result.metadata.status}`,
        workflow: delegationWorkflowUsage(runtime.budget),
      });
      return "interrupted";
    }
    if (result.metadata.status !== "approved") {
      const cancelled = result.metadata.status === "cancelled" ||
        runtime.rootContext.signal.aborted;
      await this.#failTeamAssignments(
        runtime,
        teamRunId,
        result.metadata.failure?.message ??
          `Company team ended with ${result.metadata.status}`,
        cancelled,
        result,
      );
      return "settled";
    }
    if (company.assignments.some((assignment) =>
      assignment.evidence.length === 0 ||
      (assignment.usage === null) !== (assignment.usageSource === "unknown")
    )) {
      await this.#failTeamAssignments(
        runtime,
        teamRunId,
        "Company team returned incomplete or inconsistent evidence",
        false,
        result,
      );
      return "settled";
    }
    const at = this.#now();
    try {
      await runtime.journal.update((run) => {
        const budget = this.#nextTeamBudget(run, result);
        if (budget.reportedCostUsd > budget.maxReportedCostUsd) {
          throw new ToolError(
            "execution_failed",
            "Company goal reported-cost ceiling was exceeded",
          );
        }
        return {
          ...run,
          updatedAt: at,
          plan: {
            ...run.plan,
            assignments: run.plan.assignments.map((assignment) => {
              if (assignment.execution === undefined ||
                !isTeamExecution(assignment.execution) ||
                assignment.execution.teamRunId !== teamRunId ||
                assignment.status !== "running") return assignment;
              const settled = company.assignments.find(
                (candidate) => candidate.assignmentId === assignment.id,
              )!;
              return {
                ...assignment,
                status: "completed" as const,
                execution: { ...assignment.execution, completedAt: at },
                result: {
                  summary: truncateUtf8(settled.summary, 8_192, " [truncated]"),
                  evidence: boundedEvidence(settled.evidence),
                  usage: settled.usage,
                  usageSource: settled.usageSource,
                },
                failure: null,
              };
            }),
          },
          budget,
        };
      });
      this.#reconcileBudget(runtime);
      return "settled";
    } catch (error) {
      await this.#failTeamAssignments(
        runtime,
        teamRunId,
        safeMessage(error, "Company team result could not be reconciled"),
        false,
        result,
      );
      return "settled";
    }
  }

  async #executeCompanyTeam(
    runtime: ActiveCompanyGoal,
    team: PreparedCompanyTeam,
  ): Promise<void> {
    const executor = this.dependencies.team;
    if (executor === undefined) {
      throw new ToolError(
        "tool_unavailable",
        "Company implementation requires the durable team engine",
      );
    }
    const remaining: CompanyTeamRunBudgetLimits = {
      maxRequests: runtime.budget.maxRequests - runtime.budget.requestsReserved,
      maxReportedCostUsd:
        runtime.budget.maxReportedCostUsd - runtime.budget.reportedCostUsd,
    };
    if (remaining.maxRequests < 1 || remaining.maxReportedCostUsd <= 0) {
      throw new ToolError("permission_denied", "Company goal budget is exhausted");
    }
    const reservation = await executor.reserveCompanyRun(
      team.input,
      runtime.rootContext,
      team.correlation,
      remaining,
    );
    const releases: Array<() => void> = [];
    try {
      for (const assignment of team.assignments) {
        releases.push(this.#claim(runtime, assignment.id));
      }
      await this.#markTeamStarted(runtime, team.assignments, reservation);
      let result: TeamRunResult;
      try {
        result = await executor.startCompanyForeground(
          team.input,
          runtime.rootContext,
          reservation,
        );
      } catch (error) {
        await this.#failTeamAssignments(
          runtime,
          reservation.teamRunId,
          safeMessage(error, "Company team failed before producing a durable result"),
          isCancelled(error, runtime.rootContext.signal),
        );
        return;
      }
      const outcome = await this.#settleTeamResult(
        runtime,
        reservation.teamRunId,
        result,
      );
      if (outcome === "interrupted") {
        throw new ToolError(
          "checkpoint_conflict",
          "Company team is interrupted and requires durable recovery",
        );
      }
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  async #failAssignment(
    runtime: ActiveCompanyGoal,
    assignment: CompanyGoalAssignmentV1,
    identity: ChildIdentityReservation,
    error: unknown,
  ): Promise<never> {
    this.#reconcileBudget(runtime);
    const cancelled = isCancelled(error, runtime.rootContext.signal);
    const reason = safeMessage(error, "Company child execution failed");
    const status = cancelled ? "cancelled" as const : "failed" as const;
    await runtime.journal.update((run) => ({
      ...run,
      updatedAt: this.#now(),
      plan: {
        ...run.plan,
        assignments: run.plan.assignments.map((candidate) =>
          candidate.id !== assignment.id
            ? candidate
            : {
                ...candidate,
                status,
                execution: {
                  ...(candidate.execution ?? {
                    attempt: 1 as const,
                    ...identity,
                    startedAt: this.#now(),
                  }),
                  completedAt: this.#now(),
                },
                result: null,
                failure: reason,
              }
        ),
      },
      budget: withBudget(run, runtime.budget),
    }));
    const role = runtime.blueprint.roles.find(
      (candidate) => candidate.id === assignment.roleId,
    )!;
    await this.#emit({
      type: cancelled ? "company_handoff_cancelled" : "company_handoff_failed",
      sessionId: runtime.root.id,
      at: this.#now(),
      parentAgentId: runtime.root.agent.id,
      goalRunId: runtime.journal.current.state.id,
      assignmentId: assignment.id,
      parentAssignmentId: assignment.parentAssignmentId,
      departmentId: role.departmentId,
      roleId: role.id,
      childAgentId: identity.childAgentId,
      childSessionId: identity.childSessionId,
      status,
      reason,
    });
    throw new ToolError(cancelled ? "cancelled" : "execution_failed", reason);
  }

  async #executeAssignment(
    runtime: ActiveCompanyGoal,
    assignmentId: string,
    suppliedContext?: ToolContext,
  ): Promise<ChildDelegationResult> {
    const assignment = runtime.journal.current.state.plan.assignments.find(
      (candidate) => candidate.id === assignmentId,
    );
    if (assignment === undefined || assignment.status !== "pending") {
      throw new ToolError(
        "permission_denied",
        "Company handoff is not an approved pending assignment",
      );
    }
    const dependenciesReady = assignment.dependsOn.every((id) =>
      runtime.journal.current.state.plan.assignments.find(
        (candidate) => candidate.id === id,
      )?.status === "completed"
    );
    const parent = assignment.parentAssignmentId === null
      ? null
      : runtime.journal.current.state.plan.assignments.find(
          (candidate) => candidate.id === assignment.parentAssignmentId,
        );
    if (!dependenciesReady || parent !== null && parent?.status !== "completed" &&
      parent?.status !== "running") {
      throw new ToolError(
        "permission_denied",
        "Company handoff dependencies are not complete",
      );
    }
    const role = runtime.blueprint.roles.find(
      (candidate) => candidate.id === assignment.roleId,
    )!;
    const profile = role.executionProfileId!;
    const executor = this.#executor(profile);
    const context = suppliedContext === undefined
      ? await this.#assignmentContext(runtime, assignment)
      : { ...suppliedContext, delegationBudget: runtime.budget };
    const input = {
      profile,
      description: assignment.description,
      prompt: rolePrompt(
        runtime.journal.current.state,
        runtime.blueprint,
        assignment,
        runtime.knowledgeContext,
      ),
    };
    const company = parseCompanyBlueprintBindingV2({
      blueprintId: runtime.blueprint.id,
      blueprintVersion: 2,
      blueprintRevision: runtime.blueprint.revision,
      roleId: role.id,
      roleVersion: role.version,
    });
    const companyGoal = {
      runId: runtime.journal.current.state.id,
      assignmentId: assignment.id,
      parentAssignmentId: assignment.parentAssignmentId,
    };
    const options: ChildDelegationOptions = {
      company,
      companyPermissionMode: role.permissionMode,
      companyGoal,
    };
    const identity = executor.reserveIdentity(input, context, options);
    const release = this.#claim(runtime, assignment.id);
    this.#assignmentBySession.set(identity.childSessionId, {
      runId: companyGoal.runId,
      assignmentId: assignment.id,
    });
    try {
      await this.#markStarted(runtime, assignment, identity);
      await this.#emit({
        type: "company_assignment_started",
        sessionId: runtime.root.id,
        at: this.#now(),
        parentAgentId: runtime.root.agent.id,
        goalRunId: companyGoal.runId,
        assignmentId: assignment.id,
        parentAssignmentId: assignment.parentAssignmentId,
        departmentId: role.departmentId,
        roleId: role.id,
        roleName: role.displayName,
        profileId: profile,
        childAgentId: identity.childAgentId,
        childSessionId: identity.childSessionId,
      });
      const result = await executor.delegate(input, context, {
        ...options,
        identity,
      });
      await this.#completeAssignment(runtime, assignment, result);
      await this.#emit({
        type: "company_handoff_completed",
        sessionId: runtime.root.id,
        at: this.#now(),
        parentAgentId: runtime.root.agent.id,
        goalRunId: companyGoal.runId,
        assignmentId: assignment.id,
        parentAssignmentId: assignment.parentAssignmentId,
        departmentId: role.departmentId,
        roleId: role.id,
        childAgentId: result.metadata.childAgentId,
        childSessionId: result.metadata.childSessionId,
        usage: result.metadata.usage,
        evidence: [...result.metadata.evidence],
        workflow: result.metadata.workflow,
      });
      return result;
    } catch (error) {
      return await this.#failAssignment(runtime, assignment, identity, error);
    } finally {
      this.#assignmentBySession.delete(identity.childSessionId);
      release();
    }
  }

  async #blockPending(runtime: ActiveCompanyGoal, reason: string): Promise<void> {
    await runtime.journal.update((run) => ({
      ...run,
      updatedAt: this.#now(),
      plan: {
        ...run.plan,
        assignments: run.plan.assignments.map((assignment) =>
          assignment.status !== "pending"
            ? assignment
            : {
                ...assignment,
                status: "blocked" as const,
                result: null,
                failure: reason,
              }
        ),
      },
      budget: withBudget(run, runtime.budget),
    }));
  }

  async #recoverTerminalAssignment(
    runtime: ActiveCompanyGoal,
    assignment: CompanyGoalAssignmentV1,
    child: PinnedSessionState,
  ): Promise<void> {
    if (assignment.execution === undefined ||
      !isChildExecution(assignment.execution)) {
      throw new ToolError(
        "execution_failed",
        "Company child recovery correlation is invalid",
      );
    }
    const lifecycle = child.agentLifecycle;
    const cancelled = lifecycle.status === "cancelled";
    const reason = lifecycle.status === "cancelled"
      ? lifecycle.reason
      : lifecycle.status === "failed"
        ? lifecycle.failure.safeMessage
        : "Company child recovery failed";
    const status = cancelled ? "cancelled" as const : "failed" as const;
    await runtime.journal.update((run) => ({
      ...run,
      updatedAt: this.#now(),
      plan: {
        ...run.plan,
        assignments: run.plan.assignments.map((candidate) =>
          candidate.id !== assignment.id
            ? candidate
            : {
                ...candidate,
                status,
                execution: {
                  ...candidate.execution!,
                  completedAt: this.#now(),
                },
                result: null,
                failure: truncateUtf8(reason, 2_000, " [truncated]"),
              }
        ),
      },
      budget: withBudget(run, runtime.budget),
    }));
    const role = runtime.blueprint.roles.find(
      (candidate) => candidate.id === assignment.roleId,
    )!;
    await this.#emit({
      type: cancelled ? "company_handoff_cancelled" : "company_handoff_failed",
      sessionId: runtime.root.id,
      at: this.#now(),
      parentAgentId: runtime.root.agent.id,
      goalRunId: runtime.journal.current.state.id,
      assignmentId: assignment.id,
      parentAssignmentId: assignment.parentAssignmentId,
      departmentId: role.departmentId,
      roleId: role.id,
      childAgentId: assignment.execution.childAgentId,
      childSessionId: assignment.execution.childSessionId,
      status,
      reason: truncateUtf8(reason, 2_000, " [truncated]"),
    });
  }

  async #finish(runtime: ActiveCompanyGoal): Promise<ToolResult> {
    for (;;) {
      const run = runtime.journal.current.state;
      const terminalFailure = run.plan.assignments.find((assignment) =>
        assignment.status === "failed" || assignment.status === "cancelled"
      );
      if (terminalFailure !== undefined) {
        const cancelled = terminalFailure.status === "cancelled" ||
          runtime.rootContext.signal.aborted;
        const reason = terminalFailure.failure ?? "Company assignment failed";
        await this.#blockPending(runtime, reason);
        await runtime.journal.update((current) => ({
          ...current,
          status: cancelled ? "cancelled" : "failed",
          updatedAt: this.#now(),
          result: null,
          failure: reason,
          budget: withBudget(current, runtime.budget),
        }));
        const eventType = cancelled
          ? "company_goal_cancelled" as const
          : "company_goal_failed" as const;
        await this.#emit({
          type: eventType,
          sessionId: runtime.root.id,
          at: this.#now(),
          parentAgentId: runtime.root.agent.id,
          goalRunId: run.id,
          status: cancelled ? "cancelled" : "failed",
          evidence: [],
          reason,
          workflow: delegationWorkflowUsage(runtime.budget),
        });
        throw new ToolError(cancelled ? "cancelled" : "execution_failed", reason);
      }
      const pending = run.plan.assignments.filter((assignment) =>
        assignment.status === "pending"
      );
      if (pending.length === 0) break;
      let companyTeam: PreparedCompanyTeam | null;
      try {
        companyTeam = this.#companyTeam(runtime);
      } catch (error) {
        await this.#blockPending(
          runtime,
          safeMessage(error, "Company implementation plan is invalid"),
        );
        continue;
      }
      if (companyTeam !== null) {
        try {
          await this.#executeCompanyTeam(runtime, companyTeam);
        } catch (error) {
          if (runtime.journal.current.state.status === "interrupted") {
            throw error;
          }
          await this.#blockPending(
            runtime,
            safeMessage(error, "Company implementation could not start"),
          );
        }
        continue;
      }
      const ready = pending.filter((assignment) => {
        const profile = runtime.blueprint.roles.find(
          (role) => role.id === assignment.roleId,
        )?.executionProfileId ?? null;
        if (mutatingProfile(profile)) return false;
        const parentReady = assignment.parentAssignmentId === null ||
          run.plan.assignments.find(
            (candidate) => candidate.id === assignment.parentAssignmentId,
          )?.status === "completed";
        return parentReady && assignment.dependsOn.every((id) =>
          run.plan.assignments.find((candidate) => candidate.id === id)?.status ===
            "completed"
        );
      });
      if (ready.length === 0) {
        await this.#blockPending(runtime, "Company assignment dependencies failed");
        continue;
      }
      const available = Math.max(
        1,
        run.budget.maxConcurrentAssignments - runtime.activeAssignments.size,
      );
      const priorSequence = runtime.journal.current.sequence;
      const outcomes = await Promise.allSettled(
        ready.slice(0, available).map((assignment) =>
          this.#executeAssignment(runtime, assignment.id)
        ),
      );
      if (runtime.journal.current.sequence === priorSequence) {
        const rejected = outcomes.find((outcome) => outcome.status === "rejected");
        await this.#blockPending(
          runtime,
          rejected?.status === "rejected"
            ? safeMessage(rejected.reason, "Company assignment could not start")
            : "Company assignment made no durable progress",
        );
      }
    }
    const current = runtime.journal.current.state;
    const blocked = current.plan.assignments.find((assignment) =>
      assignment.status === "blocked"
    );
    if (blocked !== undefined) {
      const reason = blocked.failure ?? "Company assignment was blocked";
      await runtime.journal.update((run) => ({
        ...run,
        status: "failed",
        updatedAt: this.#now(),
        result: null,
        failure: reason,
        budget: withBudget(run, runtime.budget),
      }));
      await this.#emit({
        type: "company_goal_failed",
        sessionId: runtime.root.id,
        at: this.#now(),
        parentAgentId: runtime.root.agent.id,
        goalRunId: current.id,
        status: "failed",
        evidence: [],
        reason,
        workflow: delegationWorkflowUsage(runtime.budget),
      });
      throw new ToolError("execution_failed", reason);
    }
    const evidence = boundedEvidence(current.plan.assignments.flatMap(
      (assignment) => assignment.result?.evidence ?? [],
    ), 128);
    const summary = truncateUtf8([
      `Company goal completed: ${current.objective}`,
      ...current.plan.assignments.map((assignment) => {
        const role = runtime.blueprint.roles.find(
          (candidate) => candidate.id === assignment.roleId,
        )!;
        return `${role.displayName}: ${assignment.result!.summary}`;
      }),
    ].join("\n"), 16_384, "\n[company synthesis truncated by Recurs]");
    const completed = await runtime.journal.update((run) => ({
      ...run,
      status: "completed",
      updatedAt: this.#now(),
      result: { summary, evidence },
      failure: null,
      budget: withBudget(run, runtime.budget),
    }));
    const learning = await this.#learn(runtime, completed.state);
    await this.#emit({
      type: "company_goal_completed",
      sessionId: runtime.root.id,
      at: this.#now(),
      parentAgentId: runtime.root.agent.id,
      goalRunId: current.id,
      status: "completed",
      evidence,
      workflow: delegationWorkflowUsage(runtime.budget),
    });
    return {
      output: summary,
      metadata: {
        goalRunId: current.id,
        status: "completed",
        evidence,
        workflow: delegationWorkflowUsage(runtime.budget),
        knowledge: learning === null
          ? { status: "unavailable", revision: runtime.knowledgeRevision }
          : {
              status: "updated",
              revision: learning.snapshotRevision,
              entriesAdded: learning.entriesAdded,
              entriesRejected: learning.entriesRejected,
            },
      },
    };
  }

  async start(
    input: DelegateCompanyGoalInput,
    context: ToolContext,
  ): Promise<ToolResult> {
    if (context.signal.aborted) throw new ToolError("cancelled", "Goal was cancelled");
    const { root, blueprint } = await this.#authority(context);
    const at = this.#now();
    const knowledge = await this.#knowledge(
      blueprint,
      input.objective,
      at,
      context.signal,
    );
    const plan = buildPlan(input, blueprint, at);
    const mode = getOperatingModePolicy(root.agent.operatingMode.id);
    const companyPolicy = mode.company!;
    const run = parseCompanyGoalRun({
      id: this.#createId(),
      version: 1,
      parentSessionId: root.id,
      goalId: this.#createId(),
      objective: input.objective,
      company: root.agent.company,
      status: "created",
      createdAt: at,
      updatedAt: at,
      plan,
      budget: {
        maxAssignments: companyPolicy.maxActiveRoles,
        assignmentsStarted: 0,
        maxConcurrentAssignments: companyPolicy.maxConcurrentAssignments,
        maxRequests: companyPolicy.maxGoalRequests,
        requestsReserved: 0,
        requestsUsed: 0,
        maxReportedCostUsd: companyPolicy.maxReportedCostUsd,
        reportedCostUsd: 0,
      },
      result: null,
      failure: null,
    });
    const created = await this.dependencies.runs.create(run, context.signal);
    const journal = new GoalJournal(this.dependencies.runs, created);
    await journal.update((current) => ({
      ...current,
      status: "running",
      updatedAt: this.#now(),
    }), context.signal);
    const runtime: ActiveCompanyGoal = {
      blueprint,
      journal,
      rootContext: context,
      root,
      knowledgeContext: knowledge.context,
      knowledgeRevision: knowledge.revision,
      budget: mutableBudget(run),
      activeAssignments: new Set(),
    };
    this.#activeRuns.set(run.id, runtime);
    await this.#emit({
      type: "company_goal_started",
      sessionId: root.id,
      at: this.#now(),
      parentAgentId: root.agent.id,
      goalRunId: run.id,
      objective: run.objective,
      blueprintId: blueprint.id,
      blueprintRevision: blueprint.revision,
      operatingModeId: mode.id,
      assignmentCount: plan.assignments.length,
    });
    try {
      return await this.#finish(runtime);
    } finally {
      this.#activeRuns.delete(run.id);
    }
  }

  async requestHandoff(
    input: RequestCompanyHandoffInput,
    context: ToolContext,
  ): Promise<ToolResult> {
    const caller = this.#assignmentBySession.get(context.sessionId);
    const runtime = this.#activeRuns.get(input.runId);
    const assignment = runtime?.journal.current.state.plan.assignments.find(
      (candidate) => candidate.id === input.assignmentId,
    );
    if (caller === undefined || runtime === undefined || assignment === undefined ||
      caller.runId !== input.runId ||
      assignment.parentAssignmentId !== caller.assignmentId) {
      throw new ToolError(
        "permission_denied",
        "The requested company handoff is not assigned to this live role",
      );
    }
    return await this.#executeAssignment(runtime, assignment.id, context);
  }

  async resume(runId: string, context: ToolContext): Promise<ToolResult> {
    const { root, blueprint } = await this.#authority(context);
    const loaded = await this.dependencies.runs.load(runId, context.signal);
    if (loaded.state.parentSessionId !== root.id ||
      loaded.state.company.blueprintId !== blueprint.id ||
      loaded.state.company.blueprintRevision !== blueprint.revision) {
      throw new ToolError("permission_denied", "Company goal authority is stale");
    }
    try {
      validateCompanyGoalPlanAgainstBlueprint(loaded.state.plan, blueprint);
      validatePlanPolicy(loaded.state.plan, blueprint);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(
        "permission_denied",
        safeMessage(error, "Stored company goal policy is invalid"),
      );
    }
    if (loaded.state.status === "completed") {
      const runtime: ActiveCompanyGoal = {
        blueprint,
        journal: new GoalJournal(this.dependencies.runs, loaded),
        rootContext: context,
        root,
        knowledgeContext: "",
        knowledgeRevision: null,
        budget: mutableBudget(loaded.state),
        activeAssignments: new Set(),
      };
      const learning = await this.#learn(runtime, loaded.state);
      return {
        output: loaded.state.result!.summary,
        metadata: {
          goalRunId: loaded.state.id,
          status: "completed",
          evidence: [...loaded.state.result!.evidence],
          knowledge: learning === null
            ? { status: "unavailable", revision: null }
            : {
                status: "updated",
                revision: learning.snapshotRevision,
                entriesAdded: learning.entriesAdded,
                entriesRejected: learning.entriesRejected,
              },
        },
      };
    }
    if (loaded.state.status === "failed" || loaded.state.status === "cancelled") {
      throw new ToolError(
        loaded.state.status === "cancelled" ? "cancelled" : "execution_failed",
        loaded.state.failure!,
      );
    }
    const journal = new GoalJournal(this.dependencies.runs, loaded);
    const knowledge = await this.#knowledge(
      blueprint,
      loaded.state.objective,
      loaded.state.createdAt,
      context.signal,
    );
    if (loaded.state.status === "created" || loaded.state.status === "interrupted") {
      await journal.update((run) => ({
        ...run,
        status: "running",
        updatedAt: this.#now(),
      }));
    }
    const runtime: ActiveCompanyGoal = {
      blueprint,
      journal,
      rootContext: context,
      root,
      knowledgeContext: knowledge.context,
      knowledgeRevision: knowledge.revision,
      budget: mutableBudget(journal.current.state),
      activeAssignments: new Set(),
    };
    const teamRunIds = new Set(journal.current.state.plan.assignments.flatMap(
      (assignment) => assignment.status === "running" &&
          assignment.execution !== undefined && isTeamExecution(assignment.execution)
        ? [assignment.execution.teamRunId]
        : [],
    ));
    for (const teamRunId of teamRunIds) {
      const team = this.dependencies.team;
      if (team === undefined) {
        await journal.update((run) => ({
          ...run,
          status: "interrupted",
          updatedAt: this.#now(),
        }));
        throw new ToolError(
          "execution_failed",
          "Company team recovery requires the durable team engine",
        );
      }
      let result: TeamRunResult;
      try {
        result = await team.inspectCompanyRun(root.id, teamRunId);
      } catch (error) {
        await journal.update((run) => ({
          ...run,
          status: "interrupted",
          updatedAt: this.#now(),
        }));
        throw new ToolError(
          "execution_failed",
          safeMessage(error, "Company team recovery state is unavailable"),
        );
      }
      if (result.metadata.status !== "approved" &&
        result.metadata.status !== "changes_requested" &&
        result.metadata.status !== "unverified" &&
        result.metadata.status !== "failed" &&
        result.metadata.status !== "cancelled") {
        await journal.update((run) => ({
          ...run,
          status: "interrupted",
          updatedAt: this.#now(),
        }));
        await this.#emit({
          type: "company_goal_interrupted",
          sessionId: root.id,
          at: this.#now(),
          parentAgentId: root.agent.id,
          goalRunId: runId,
          status: "interrupted",
          evidence: [],
          reason: "A durable company team requires explicit runtime recovery",
          workflow: delegationWorkflowUsage(runtime.budget),
        });
        throw new ToolError(
          "execution_failed",
          "Company goal is interrupted; its team run needs reconciliation",
        );
      }
      await this.#settleTeamResult(runtime, teamRunId, result);
    }
    for (const assignment of journal.current.state.plan.assignments) {
      if (assignment.status !== "running" || assignment.execution === undefined) continue;
      if (!isChildExecution(assignment.execution)) {
        continue;
      }
      const child = await this.dependencies.sessions.loadState(
        assignment.execution.childSessionId,
      ).catch(() => null);
      if (child !== null && isPinnedSessionState(child) &&
        (child.agentLifecycle.status === "failed" ||
          child.agentLifecycle.status === "cancelled")) {
        await this.#recoverTerminalAssignment(runtime, assignment, child);
        continue;
      }
      if (child === null || !isPinnedSessionState(child) ||
        child.agentResult === null || child.agentLifecycle.status !== "completed") {
        await journal.update((run) => ({
          ...run,
          status: "interrupted",
          updatedAt: this.#now(),
        }));
        await this.#emit({
          type: "company_goal_interrupted",
          sessionId: root.id,
          at: this.#now(),
          parentAgentId: root.agent.id,
          goalRunId: runId,
          status: "interrupted",
          evidence: [],
          reason: "A running child could not be recovered truthfully",
          workflow: delegationWorkflowUsage(runtime.budget),
        });
        throw new ToolError(
          "execution_failed",
          "Company goal is interrupted; its running child needs reconciliation",
        );
      }
      const used = child.agentResult.steps === null
        ? childRequestAllowance(root.agent)
        : Math.min(childRequestAllowance(root.agent), child.agentResult.steps);
      runtime.budget.requestsUsed = Math.min(
        runtime.budget.maxRequests,
        runtime.budget.requestsUsed + used,
      );
      runtime.budget.reportedCostUsd += child.agentResult.usage?.costUsd ?? 0;
      const result: ChildDelegationResult = {
        output: child.agentResult.finalText,
        metadata: {
          childAgentId: child.agent.id,
          childSessionId: child.id,
          taskId: child.agent.task!.id,
          attempts: 1,
          retries: 0,
          operatingModeId: child.agent.operatingMode.id,
          profileId: child.agent.profile!.id,
          usage: child.agentResult.usage,
          usageSource: child.agentResult.usageSource,
          requestsUsed: used,
          evidenceSource: child.agentResult.evidenceSource,
          changedFiles: [...child.agentResult.changedFiles],
          evidence: [...child.agentResult.evidence],
          costLimitUsd: runtime.budget.maxReportedCostUsd,
          costLimitExceeded:
            runtime.budget.reportedCostUsd > runtime.budget.maxReportedCostUsd,
          workflow: delegationWorkflowUsage(runtime.budget),
          company: child.agent.company!,
        },
      };
      await this.#completeAssignment(runtime, assignment, result);
    }
    this.#activeRuns.set(runId, runtime);
    try {
      return await this.#finish(runtime);
    } finally {
      this.#activeRuns.delete(runId);
    }
  }
}
