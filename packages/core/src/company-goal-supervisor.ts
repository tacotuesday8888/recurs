import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  effectiveTeamControlPolicy,
  getAgentProfilePolicy,
  getOperatingModePolicy,
  narrowAgentPermissionMode,
  parseCompanyBlueprintBindingV2,
  parseCompanyGoalPlan,
  parseCompanyGoalRun,
  recommendedTeamControlPolicy,
  reserveCompanyGoalBudget,
  validateCompanyGoalPlanAgainstBlueprint,
  validateTeamControlPolicyAgainstMode,
  type AgentBackendSelection,
  type AgentProfileId,
  type CompanyBlueprintBindingV2,
  type CompanyBlueprintV2,
  type CompanyGoalAssignmentV1,
  type CompanyGoalChildExecutionV1,
  type CompanyGoalPlanV1,
  type CompanyGoalRun,
  type CompanyGoalRunV2,
  type CompanyToolBundleId,
  type EffectiveTeamControlPolicyV1,
  type TeamRunCompanyGoalCorrelation,
  type TeamRunCompanyRoleBinding,
} from "@recurs/contracts";
import {
  permissionIntentKey,
  ToolError,
  type DelegationBudget,
  type PermissionIntent,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@recurs/tools";

import { childRequestAllowance, delegationWorkflowUsage } from "./agent-profile.js";
import { companyAgentLimits } from "./company-agent-binding.js";
import { validateCompanyBlueprintV2ExecutionPolicy } from "./company-blueprint-v2.js";
import { renderCompanyAssignmentPrompt } from "./company-role-charter.js";
import type {
  ChildAgentManager,
  ChildDelegationOptions,
  ChildDelegationResult,
  ChildIdentityReservation,
} from "./child-agent-manager.js";
import type { FileCompanyBlueprintV2Store } from "./file-company-blueprint-v2-store.js";
import type { FileTeamControlPolicyStore } from "./file-team-control-policy-store.js";
import type {
  CompanyGoalLearningResult,
  CompanyKnowledgeSelection,
} from "./company-learning.js";
import type { RecursEvent } from "./events.js";
import type { JsonlCompanyGoalStore } from "./jsonl-company-goal-store.js";
import type { JsonlSessionStore } from "./jsonl-session-store.js";
import type { SequencedCompanyState } from "./private-state-store.js";
import { isPinnedSessionState, type PinnedSessionState } from "./session-v2.js";
import type {
  TeamRunOwnerLease,
  TeamRunOwnerLeaseManager,
} from "./team-run-owner-lease.js";
import type { DelegateTeamInput } from "./team-agent-manager.js";
import { validateCompanyGoalPlanAgainstTeamControls } from "./team-control-policy.js";
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
const unresolvedStatuses = new Set<CompanyGoalRun["status"]>([
  "created",
  "running",
  "waiting_for_approval",
  "interrupted",
]);

export const COMPANY_GOAL_WORKTREE_PERMISSION = Object.freeze({
  category: "shell",
  resource: "fixed Git worktree orchestration",
  risk: "normal",
} as const satisfies PermissionIntent);

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
  | "reserveCompanyRun"
  | "selectCompanyChildBackend"
  | "startCompanyForeground"
  | "inspectCompanyRun"
>;

export interface CompanyGoalSupervisorDependencies {
  readonly sessions: {
    loadState(
      sessionId: string,
      signal?: AbortSignal,
    ): ReturnType<JsonlSessionStore["loadState"]>;
  };
  readonly blueprints: Pick<FileCompanyBlueprintV2Store, "load">;
  readonly teamControls?: Pick<FileTeamControlPolicyStore, "latest">;
  readonly runs: Pick<
    JsonlCompanyGoalStore<CompanyGoalRun>,
    "create" | "append" | "load" | "list"
  >;
  readonly owners: Pick<TeamRunOwnerLeaseManager, "tryAcquire">;
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
      readonly run: CompanyGoalRun;
      readonly at: string;
      readonly signal?: AbortSignal;
    }): Promise<CompanyGoalLearningResult>;
  };
  emit(event: RecursEvent): Promise<void>;
  readonly createId?: () => string;
  readonly now?: () => string;
}

type RunState = SequencedCompanyState<CompanyGoalRun>;

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

function assertRecoveryActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ToolError("cancelled", "Company goal resume was cancelled");
  }
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

function mutableBudget(run: CompanyGoalRun): DelegationBudget {
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
  run: CompanyGoalRun,
  budget: DelegationBudget,
): CompanyGoalRun["budget"] {
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
  if (reviewAssignments.some((review) => review.parentAssignmentId !== null) ||
    !reviewAssignments.some((review) =>
      nonReviewIds.every((id) => review.dependsOn.includes(id))
    )) {
    throw new ToolError(
      "permission_denied",
      "Independent review must be top-level and one final review must follow every non-review assignment",
    );
  }
  const implementationIds = new Set(plan.assignments.filter((assignment) =>
    roles.get(assignment.roleId)?.executionProfileId === "implement_v2"
  ).map((assignment) => assignment.id));
  if ([...implementationIds].some((id) =>
    !reviewAssignments.some((review) => review.dependsOn.includes(id))
  )) {
    throw new ToolError(
      "permission_denied",
      "Every company implementation assignment requires a dependent independent review",
    );
  }
  const pending = new Set(plan.assignments.map((assignment) => assignment.id));
  const completed = new Set<string>();
  const dependencyReady = (assignment: CompanyGoalAssignmentV1): boolean =>
    (assignment.parentAssignmentId === null ||
      completed.has(assignment.parentAssignmentId)) &&
    assignment.dependsOn.every((id) => completed.has(id));
  while (pending.size > 0) {
    const readyImplementations = plan.assignments.filter((assignment) =>
      pending.has(assignment.id) && implementationIds.has(assignment.id) &&
      dependencyReady(assignment)
    );
    const readyIds = new Set(readyImplementations.map((assignment) => assignment.id));
    const eligibleReviews = reviewAssignments.filter((review) =>
      pending.has(review.id) && review.dependsOn.every((id) =>
        completed.has(id) || readyIds.has(id)
      )
    );
    const reviewedIds = new Set(eligibleReviews.flatMap((review) =>
      review.dependsOn.filter((id) => readyIds.has(id))
    ));
    const frontier = readyImplementations.filter((assignment) =>
      reviewedIds.has(assignment.id)
    );
    if (frontier.length > 0) {
      const frontierIds = new Set(frontier.map((assignment) => assignment.id));
      const reviews = eligibleReviews.filter((review) =>
        review.dependsOn.some((id) => frontierIds.has(id))
      );
      for (const assignment of [...frontier, ...reviews]) {
        pending.delete(assignment.id);
        completed.add(assignment.id);
      }
      continue;
    }
    const nonMutating = plan.assignments.filter((assignment) =>
      pending.has(assignment.id) && !implementationIds.has(assignment.id) &&
      dependencyReady(assignment)
    );
    if (nonMutating.length === 0) {
      throw new ToolError(
        "permission_denied",
        "Company implementation stages cannot reach a reviewed execution frontier",
      );
    }
    for (const assignment of nonMutating) {
      pending.delete(assignment.id);
      completed.add(assignment.id);
    }
  }
}

function rolePrompt(
  run: CompanyGoalRun,
  blueprint: CompanyBlueprintV2,
  assignment: CompanyGoalAssignmentV1,
  knowledgeContext: string,
  maximumBytes = MAX_PROMPT_BYTES,
): string {
  const dependencies = run.plan.assignments
    .filter((candidate) => assignment.dependsOn.includes(candidate.id))
    .map((candidate) => [
      `Handoff ${candidate.id}: ${candidate.result?.summary ?? "No result"}`,
      ...(candidate.result?.evidence ?? []).map((item) => `Evidence: ${item}`),
    ].join("\n"));
  return renderCompanyAssignmentPrompt({
    blueprint,
    assignment,
    objective: run.objective,
    knowledgeContext,
    dependencyHandoffs: dependencies,
    maximumBytes,
  });
}

class GoalJournal {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly runs: Pick<JsonlCompanyGoalStore<CompanyGoalRun>, "append">,
    public current: RunState,
  ) {}

  update(
    transform: (run: CompanyGoalRun) => CompanyGoalRun,
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
  readonly knowledgeByAssignment: ReadonlyMap<string, string>;
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

  async #teamControlAuthority(
    root: PinnedSessionState,
    blueprint: CompanyBlueprintV2,
    signal: AbortSignal,
  ): Promise<CompanyGoalRunV2["teamControl"]> {
    let selected;
    try {
      selected = await this.dependencies.teamControls?.latest(root.cwd, signal) ??
        recommendedTeamControlPolicy(root.agent.operatingMode.id);
    } catch {
      throw new ToolError(
        "execution_failed",
        "Project team controls are unavailable",
      );
    }
    try {
      validateTeamControlPolicyAgainstMode(
        selected,
        root.agent.operatingMode.id,
      );
      return Object.freeze({
        selected,
        effective: effectiveTeamControlPolicy(selected, blueprint),
      });
    } catch (error) {
      throw new ToolError(
        "permission_denied",
        safeMessage(error, "Project team controls are invalid"),
      );
    }
  }

  #assertFrozenTeamControls(runtime: ActiveCompanyGoal): void {
    const run = runtime.journal.current.state;
    if (run.version !== 2) return;
    try {
      parseCompanyGoalRun<CompanyGoalRunV2>(run);
      validateCompanyGoalPlanAgainstTeamControls(
        run.plan,
        runtime.blueprint,
        run.teamControl.effective,
      );
    } catch (error) {
      throw new ToolError(
        "permission_denied",
        safeMessage(error, "Stored company goal team controls are invalid"),
      );
    }
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
          COMPANY_GOAL_WORKTREE_PERMISSION,
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

  async #knowledgeForPlan(
    blueprint: CompanyBlueprintV2,
    objective: string,
    plan: CompanyGoalPlanV1,
    runCreatedAt: string,
    signal: AbortSignal,
  ): Promise<{
    readonly revision: number | null;
    readonly byAssignment: ReadonlyMap<string, string>;
  }> {
    if (this.dependencies.learning === undefined) {
      return Object.freeze({
        revision: null,
        byAssignment: new Map(plan.assignments.map((assignment) => [
          assignment.id,
          "",
        ])),
      });
    }
    try {
      const beforeRun = new Date(
        new Date(runCreatedAt).valueOf() - 1,
      ).toISOString();
      const selections = await Promise.all(plan.assignments.map(async (assignment) => {
        const role = blueprint.roles.find((candidate) =>
          candidate.id === assignment.roleId
        )!;
        const selection = await this.dependencies.learning!
          .selectCompanyKnowledge({
            companyId: blueprint.companyId,
            query: truncateUtf8([
              objective,
              blueprint.project.purpose,
              role.displayName,
              role.kind,
              role.responsibility,
              assignment.description,
              assignment.prompt,
              ...assignment.acceptance,
              ...assignment.expectedEvidence,
            ].join("\n"), 4_000),
            asOf: beforeRun,
            maximumEntries: 6,
            maximumBytes: 4_096,
            signal,
          });
        return { assignmentId: assignment.id, selection };
      }));
      const revisions = new Set(selections.map((item) => item.selection.revision));
      if (revisions.size > 1) {
        throw new TypeError("Company knowledge snapshot changed during selection");
      }
      return Object.freeze({
        revision: selections[0]?.selection.revision ?? null,
        byAssignment: new Map(selections.map((item) => [
          item.assignmentId,
          item.selection.context,
        ])),
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
    run: CompanyGoalRun,
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
    try {
      validateCompanyBlueprintV2ExecutionPolicy(blueprint);
    } catch (error) {
      throw new ToolError(
        "permission_denied",
        safeMessage(error, "The approved company execution policy is invalid"),
      );
    }
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

  async #resumeAuthority(
    context: ToolContext,
  ): Promise<{ root: PinnedSessionState; blueprint: CompanyBlueprintV2 }> {
    const authority = await this.#authority(context);
    const invocation = context.runContext;
    if (context.executionMode !== "act" ||
      authority.root.executionMode !== "act" ||
      invocation?.invocation !== "repl" ||
      invocation.presence !== "present" ||
      invocation.location !== "local" ||
      invocation.automation !== "manual" ||
      invocation.embedding !== "cli") {
      throw new ToolError(
        "permission_denied",
        "Company goal resume requires a local, manual, user-present Act CLI session",
      );
    }
    if (authority.root.permissionMode !== "full_access") {
      const approved = context.approvedIntents;
      if (approved?.has(permissionIntentKey(TEAM_APPLY_PERMISSION)) !== true ||
        approved.has(permissionIntentKey(COMPANY_GOAL_WORKTREE_PERMISSION)) !==
          true) {
        throw new ToolError(
          "permission_denied",
          "Company goal resume requires explicit team apply and worktree approvals",
        );
      }
    }
    return authority;
  }

  async #acquireOwner(
    runId: string,
    parentSessionId: string,
    operation: "start" | "resume",
  ): Promise<TeamRunOwnerLease> {
    const ownership = await this.dependencies.owners.tryAcquire(
      runId,
      parentSessionId,
    );
    if (ownership.status === "busy") {
      throw new ToolError(
        "permission_denied",
        operation === "start"
          ? "A company goal already owns this parent. Do not retry delegate_company_goal; inspect /company operations."
          : "This company goal or its parent is already owned by another live execution",
      );
    }
    return ownership.lease;
  }

  async #unresolvedRuns(
    root: PinnedSessionState,
    blueprint: CompanyBlueprintV2,
    signal: AbortSignal,
  ): Promise<readonly CompanyGoalRun[]> {
    return (await this.dependencies.runs.list(signal))
      .map((entry) => entry.state)
      .filter((run) =>
        run.parentSessionId === root.id &&
        run.company.blueprintId === blueprint.id &&
        run.company.blueprintRevision === blueprint.revision &&
        unresolvedStatuses.has(run.status)
      )
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id)
      );
  }

  #rejectExistingRun(run: CompanyGoalRun): never {
    throw new ToolError(
      "permission_denied",
      [
        `Company goal ${run.id} is unresolved (${run.status}).`,
        "Do not retry delegate_company_goal.",
        run.status === "waiting_for_approval"
          ? `Inspect it with /company run ${run.id}.`
          : `Resume it with /company resume ${run.id}.`,
      ].join(" "),
    );
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

  async #directReviewBackend(
    parent: PinnedSessionState,
    modelRoute: CompanyBlueprintV2["roles"][number]["modelRoute"],
  ): Promise<NonNullable<ChildDelegationOptions["backend"]>> {
    if (this.dependencies.team === undefined || modelRoute !== "review") {
      throw new ToolError(
        "tool_unavailable",
        "Direct company review requires a trusted backend router",
      );
    }
    return {
      decision: await this.dependencies.team.selectCompanyChildBackend({
        parent,
        profileId: "review_v1",
        modelRoute,
        background: false,
      }),
    };
  }

  #claim(runtime: ActiveCompanyGoal, assignmentId: string): () => void {
    this.#assertFrozenTeamControls(runtime);
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

  #claimTeam(
    runtime: ActiveCompanyGoal,
    assignments: readonly CompanyGoalAssignmentV1[],
    reservation: CompanyTeamRunReservation,
  ): () => void {
    this.#assertFrozenTeamControls(runtime);
    if (assignments.some((assignment) =>
      runtime.activeAssignments.has(assignment.id)
    )) {
      throw new ToolError("permission_denied", "Company assignment is already running");
    }
    const phaseConcurrency = Math.max(
      reservation.companyGoal.implementations.length,
      reservation.companyGoal.reviews.length,
      reservation.companyGoal.repair === null ? 0 : 1,
    );
    if (runtime.activeAssignments.size + phaseConcurrency >
      runtime.journal.current.state.budget.maxConcurrentAssignments) {
      throw new ToolError(
        "permission_denied",
        "Company goal concurrency limit is reached",
      );
    }
    for (const assignment of assignments) {
      runtime.activeAssignments.add(assignment.id);
    }
    return () => {
      for (const assignment of assignments) {
        runtime.activeAssignments.delete(assignment.id);
      }
    };
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
    const readyImplementations = run.plan.assignments.filter((assignment) =>
      assignment.status === "pending" &&
      roles.get(assignment.roleId)?.executionProfileId === "implement_v2" &&
      dependencyReady(assignment)
    );
    if (readyImplementations.length === 0) return null;
    const readyImplementationIds = new Set(
      readyImplementations.map((item) => item.id),
    );
    const independentRoles = new Set(
      runtime.blueprint.authorityAnchors.independentReviewRoleIds,
    );
    const eligibleReviews = run.plan.assignments.filter((assignment) =>
      assignment.status === "pending" && independentRoles.has(assignment.roleId) &&
      assignment.dependsOn.every((id) => {
        const dependency = run.plan.assignments.find((item) => item.id === id);
        return dependency?.status === "completed" || readyImplementationIds.has(id);
      })
    );
    const reviewedImplementationIds = new Set(eligibleReviews.flatMap((review) =>
      review.dependsOn.filter((id) => readyImplementationIds.has(id))
    ));
    const implementations = readyImplementations.filter((assignment) =>
      reviewedImplementationIds.has(assignment.id)
    );
    if (implementations.length === 0) return null;
    const implementationIds = new Set(implementations.map((item) => item.id));
    const reviews = eligibleReviews.filter((review) =>
      review.dependsOn.some((id) => implementationIds.has(id))
    );
    if (reviews.some((assignment) =>
      roles.get(assignment.roleId)?.executionProfileId !== "review_v2"
    ) || [...implementationIds].some((id) =>
      !reviews.some((review) => review.dependsOn.includes(id))
    )) {
      throw new ToolError(
        "permission_denied",
        "Company implementation frontier requires dependent independent review",
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
    const repairAssignment = implementations.find((assignment) => {
      const role = roles.get(assignment.roleId)!;
      return role.capabilities.includes("repair") &&
        role.toolBundles.includes("implementation_v1");
    });
    const modeRepairRounds = policy.maxRepairRounds ?? 0;
    const maxRepairRounds = run.version === 2
      ? Math.min(modeRepairRounds, run.teamControl.effective.maxRepairRounds)
      : modeRepairRounds;
    const repair = maxRepairRounds === 0 || repairAssignment === undefined
      ? null
      : this.#teamBinding(runtime, repairAssignment, "implementation_v1");
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
    const reviewHeader = `Independently review the complete company goal: ${
      truncateUtf8(run.objective, 1_000, " [truncated]")
    }`;
    const reviewPromptBytes = Math.floor(
      (12_000 - encoder.encode(reviewHeader).byteLength -
        Math.max(0, reviews.length - 1) * 2) / reviews.length,
    );
    if (reviewPromptBytes < 2_048) {
      throw new ToolError(
        "permission_denied",
        "Company review charters exceed the bounded review instruction limit",
      );
    }
    const input: DelegateTeamInput = Object.freeze({
      description: truncateUtf8(run.objective, MAX_DESCRIPTION_BYTES),
      tasks: Object.freeze(implementations.map((assignment) => ({
        description: assignment.description,
        prompt: rolePrompt(
          run,
          runtime.blueprint,
          assignment,
          runtime.knowledgeByAssignment.get(assignment.id) ?? "",
        ),
      }))),
      review: Object.freeze({
        instructions: [
          reviewHeader,
          ...reviews.map((assignment) => rolePrompt(
            run,
            runtime.blueprint,
            assignment,
            runtime.knowledgeByAssignment.get(assignment.id) ?? "",
            reviewPromptBytes,
          )),
        ].join("\n\n"),
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
      Math.max(
        reservation.companyGoal.implementations.length,
        reservation.companyGoal.reviews.length,
        reservation.companyGoal.repair === null ? 0 : 1,
      ) > run.budget.maxConcurrentAssignments) {
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
    signal?: AbortSignal,
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
    }), signal);
  }

  #nextTeamBudget(
    run: CompanyGoalRun,
    result: TeamRunResult,
  ): CompanyGoalRun["budget"] {
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
    signal?: AbortSignal,
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
    }), signal);
    this.#reconcileBudget(runtime);
  }

  async #settleTeamResult(
    runtime: ActiveCompanyGoal,
    teamRunId: string,
    result: TeamRunResult,
    signal?: AbortSignal,
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
        signal,
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
      }), signal);
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
        signal,
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
        signal,
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
      }, signal);
      this.#reconcileBudget(runtime);
      return "settled";
    } catch (error) {
      if (signal?.aborted === true) throw error;
      await this.#failTeamAssignments(
        runtime,
        teamRunId,
        safeMessage(error, "Company team result could not be reconciled"),
        false,
        result,
        signal,
      );
      return "settled";
    }
  }

  async #executeCompanyTeam(
    runtime: ActiveCompanyGoal,
    team: PreparedCompanyTeam,
  ): Promise<void> {
    this.#assertFrozenTeamControls(runtime);
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
    const release = this.#claimTeam(runtime, team.assignments, reservation);
    try {
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
      release();
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
        runtime.knowledgeByAssignment.get(assignment.id) ?? "",
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
    let backend: ChildDelegationOptions["backend"] | undefined;
    if (profile === "review_v1") {
      const delegationParent = await this.dependencies.sessions.loadState(
        context.sessionId,
        context.signal,
      );
      if (!isPinnedSessionState(delegationParent)) {
        throw new ToolError(
          "tool_unavailable",
          "Company assignment parent is unavailable",
        );
      }
      backend = await this.#directReviewBackend(
        delegationParent,
        role.modelRoute,
      );
    }
    const options: ChildDelegationOptions = {
      company,
      companyPermissionMode: role.permissionMode,
      companyGoal,
      ...(backend === undefined ? {} : { backend }),
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

  async #blockPending(
    runtime: ActiveCompanyGoal,
    reason: string,
    signal?: AbortSignal,
  ): Promise<void> {
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
    }), signal);
  }

  async #recoverTerminalAssignment(
    runtime: ActiveCompanyGoal,
    assignment: CompanyGoalAssignmentV1,
    child: PinnedSessionState,
    signal?: AbortSignal,
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
    }), signal);
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

  async #finish(
    runtime: ActiveCompanyGoal,
    recoverySignal?: AbortSignal,
  ): Promise<ToolResult> {
    for (;;) {
      if (recoverySignal !== undefined) assertRecoveryActive(recoverySignal);
      const run = runtime.journal.current.state;
      const terminalFailure = run.plan.assignments.find((assignment) =>
        assignment.status === "failed" || assignment.status === "cancelled"
      );
      if (terminalFailure !== undefined) {
        const cancelled = terminalFailure.status === "cancelled" ||
          runtime.rootContext.signal.aborted;
        const reason = terminalFailure.failure ?? "Company assignment failed";
        await this.#blockPending(runtime, reason, recoverySignal);
        await runtime.journal.update((current) => ({
          ...current,
          status: cancelled ? "cancelled" : "failed",
          updatedAt: this.#now(),
          result: null,
          failure: reason,
          budget: withBudget(current, runtime.budget),
        }), recoverySignal);
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
        if (cancelled) {
          throw new ToolError("cancelled", reason);
        }
        return this.#failedResult(runtime, reason);
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
          recoverySignal,
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
            recoverySignal,
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
        await this.#blockPending(
          runtime,
          "Company assignment dependencies failed",
          recoverySignal,
        );
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
          recoverySignal,
        );
      }
    }
    const current = runtime.journal.current.state;
    const blocked = current.plan.assignments.find((assignment) =>
      assignment.status === "blocked"
    );
    if (blocked !== undefined) {
      if (recoverySignal !== undefined) assertRecoveryActive(recoverySignal);
      const reason = blocked.failure ?? "Company assignment was blocked";
      await runtime.journal.update((run) => ({
        ...run,
        status: "failed",
        updatedAt: this.#now(),
        result: null,
        failure: reason,
        budget: withBudget(run, runtime.budget),
      }), recoverySignal);
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
      return this.#failedResult(runtime, reason);
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
    if (recoverySignal !== undefined) assertRecoveryActive(recoverySignal);
    const completed = await runtime.journal.update((run) => ({
      ...run,
      status: "completed",
      updatedAt: this.#now(),
      result: { summary, evidence },
      failure: null,
      budget: withBudget(run, runtime.budget),
    }), recoverySignal);
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

  #failedResult(runtime: ActiveCompanyGoal, reason: string): ToolResult {
    const run = runtime.journal.current.state;
    const evidence = boundedEvidence(run.plan.assignments.flatMap(
      (assignment) => assignment.result?.evidence ?? [],
    ), 128);
    return {
      output: truncateUtf8([
        `Company goal reached a terminal failure after acceptance: ${run.objective}`,
        `Goal run: ${run.id}`,
        `Reason: ${reason}`,
        "Do not call delegate_company_goal again for this objective; synthesize this durable result.",
      ].join("\n"), 16_384, "\n[company failure truncated by Recurs]"),
      metadata: {
        goalRunId: run.id,
        status: "failed",
        evidence,
        workflow: delegationWorkflowUsage(runtime.budget),
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
    const mode = getOperatingModePolicy(root.agent.operatingMode.id);
    const plan = buildPlan(input, blueprint, at);
    const teamControl = await this.#teamControlAuthority(
      root,
      blueprint,
      context.signal,
    );
    try {
      validateCompanyGoalPlanAgainstTeamControls(
        plan,
        blueprint,
        teamControl.effective,
      );
    } catch (error) {
      throw new ToolError(
        "permission_denied",
        safeMessage(error, "Company goal plan exceeds its team controls"),
      );
    }
    const runId = this.#createId();
    const owner = await this.#acquireOwner(runId, root.id, "start");
    try {
      const [existing] = await this.#unresolvedRuns(
        root,
        blueprint,
        context.signal,
      );
      if (existing !== undefined) this.#rejectExistingRun(existing);
      await owner.assertOwned();
      const knowledge = await this.#knowledgeForPlan(
        blueprint,
        input.objective,
        plan,
        at,
        context.signal,
      );
      const run = parseCompanyGoalRun<CompanyGoalRunV2>({
        id: runId,
        version: 2 as const,
        parentSessionId: root.id,
        goalId: this.#createId(),
        objective: input.objective,
        company: root.agent.company as CompanyBlueprintBindingV2,
        status: "created",
        createdAt: at,
        updatedAt: at,
        plan,
        teamControl,
        budget: {
          maxAssignments: teamControl.effective.maxActiveAgents,
          assignmentsStarted: 0,
          maxConcurrentAssignments: teamControl.effective.maxConcurrentAgents,
          maxRequests: teamControl.effective.maxRequests,
          requestsReserved: 0,
          requestsUsed: 0,
          maxReportedCostUsd: teamControl.effective.maxReportedCostUsd,
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
        knowledgeByAssignment: knowledge.byAssignment,
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
        topology: teamControl.effective.topology,
        maxActiveAgents: teamControl.effective.maxActiveAgents,
        maxConcurrentAgents: teamControl.effective.maxConcurrentAgents,
        maxDelegationDepth: teamControl.effective.maxDelegationDepth,
        maxRepairRounds: teamControl.effective.maxRepairRounds,
        maxRequests: teamControl.effective.maxRequests,
        maxReportedCostUsd: teamControl.effective.maxReportedCostUsd,
      });
      try {
        return await this.#finish(runtime);
      } finally {
        this.#activeRuns.delete(run.id);
      }
    } finally {
      await owner.release();
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

  async #matchesRecoveredChild(
    runtime: ActiveCompanyGoal,
    assignment: CompanyGoalAssignmentV1,
    child: PinnedSessionState,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (assignment.execution === undefined ||
      !isChildExecution(assignment.execution)) return false;
    let parent = runtime.root;
    if (assignment.parentAssignmentId !== null) {
      const parentAssignment = runtime.journal.current.state.plan.assignments.find(
        (candidate) => candidate.id === assignment.parentAssignmentId,
      );
      if (parentAssignment?.status !== "completed" ||
        parentAssignment.execution === undefined ||
        !isChildExecution(parentAssignment.execution)) return false;
      try {
        const loaded = await this.dependencies.sessions.loadState(
          parentAssignment.execution.childSessionId,
          signal,
        );
        assertRecoveryActive(signal);
        if (!isPinnedSessionState(loaded) ||
          loaded.id !== parentAssignment.execution.childSessionId ||
          loaded.agent.id !== parentAssignment.execution.childAgentId ||
          !await this.#matchesRecoveredChild(
            runtime,
            parentAssignment,
            loaded,
            signal,
          )) return false;
        parent = loaded;
      } catch {
        assertRecoveryActive(signal);
        return false;
      }
    }
    const role = runtime.blueprint.roles.find(
      (candidate) => candidate.id === assignment.roleId,
    );
    if (role?.executionProfileId === null || role?.executionProfileId === undefined) {
      return false;
    }
    const profile = getAgentProfilePolicy(role.executionProfileId);
    const company = {
      blueprintId: runtime.blueprint.id,
      blueprintVersion: 2 as const,
      blueprintRevision: runtime.blueprint.revision,
      roleId: role.id,
      roleVersion: role.version,
    };
    const companyGoal = {
      runId: runtime.journal.current.state.id,
      assignmentId: assignment.id,
      parentAssignmentId: assignment.parentAssignmentId,
    };
    const permissions = {
      parentExecutionMode: parent.executionMode,
      executionMode: profile.executionMode,
      parentPermissionMode: parent.permissionMode,
      permissionMode: narrowAgentPermissionMode(
        parent.permissionMode,
        role.permissionMode,
      ),
    };
    let expectedPin = parent.backend.pin;
    let expectedBackend: AgentBackendSelection = {
      strategy: "inherit_parent" as const,
      adapterId: parent.backend.pin.adapterId,
      connectionId: parent.backend.pin.connectionId,
      modelId: parent.backend.pin.modelId,
    };
    if (profile.id === "review_v1") {
      try {
        const routed = await this.#directReviewBackend(
          parent,
          role.modelRoute,
        );
        expectedPin = routed.decision.pin;
        expectedBackend = {
          strategy: "policy_route" as const,
          candidateId: routed.decision.candidateId,
          reason: routed.decision.reason,
          adapterId: routed.decision.pin.adapterId,
          connectionId: routed.decision.pin.connectionId,
          modelId: routed.decision.pin.modelId,
        };
      } catch {
        return false;
      }
    }
    const backend = child.agent.backend;
    return child.id === assignment.execution.childSessionId &&
      child.agent.role === "child" &&
      child.agent.id === assignment.execution.childAgentId &&
      child.agent.task?.id === assignment.execution.taskId &&
      child.agent.parentSessionId === parent.id &&
      child.agent.parentAgentId === parent.agent.id &&
      child.agent.depth === parent.agent.depth + 1 &&
      child.cwd === parent.cwd &&
      child.pendingCompaction === null &&
      isDeepStrictEqual(child.agent.company, company) &&
      isDeepStrictEqual(child.agent.companyGoal, companyGoal) &&
      isDeepStrictEqual(child.agent.profile, {
        id: profile.id,
        version: profile.version,
      }) &&
      isDeepStrictEqual(child.agent.operatingMode, parent.agent.operatingMode) &&
      isDeepStrictEqual(child.backend.pin, expectedPin) &&
      isDeepStrictEqual(backend, expectedBackend) &&
      isDeepStrictEqual(child.agent.permissions, permissions) &&
      child.executionMode === permissions.executionMode &&
      child.permissionMode === permissions.permissionMode &&
      isDeepStrictEqual(
        child.agent.limits,
        {
          ...companyAgentLimits(parent.agent.operatingMode.id, company),
          maxRequests: childRequestAllowance(parent.agent),
        },
      ) &&
      child.agent.workspace === undefined &&
      child.agent.team === undefined;
  }

  async #preflightRecoveredChildren(
    runtime: ActiveCompanyGoal,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, PinnedSessionState>> {
    const recovered = new Map<string, PinnedSessionState>();
    for (const assignment of runtime.journal.current.state.plan.assignments) {
      if (assignment.status !== "running" ||
        assignment.execution === undefined ||
        !isChildExecution(assignment.execution)) continue;
      let child: Awaited<ReturnType<JsonlSessionStore["loadState"]>> | null;
      try {
        child = await this.dependencies.sessions.loadState(
          assignment.execution.childSessionId,
          signal,
        );
        assertRecoveryActive(signal);
      } catch {
        assertRecoveryActive(signal);
        child = null;
      }
      if (child === null || !isPinnedSessionState(child) ||
        !await this.#matchesRecoveredChild(
          runtime,
          assignment,
          child,
          signal,
        )) {
        assertRecoveryActive(signal);
        throw new ToolError(
          "execution_failed",
          "Company child recovery correlation or terminal state is invalid",
        );
      }
      assertRecoveryActive(signal);
      if (child.agentLifecycle.status !== "failed" &&
        child.agentLifecycle.status !== "cancelled" &&
        (child.agentLifecycle.status !== "completed" ||
          child.agentResult === null)) {
        throw new ToolError(
          "execution_failed",
          "Company child recovery correlation or terminal state is invalid",
        );
      }
      recovered.set(assignment.id, child);
    }
    return recovered;
  }

  async #resumeOwned(
    runId: string,
    context: ToolContext,
    root: PinnedSessionState,
    blueprint: CompanyBlueprintV2,
  ): Promise<ToolResult> {
    const loaded = await this.dependencies.runs.load(runId, context.signal);
    assertRecoveryActive(context.signal);
    if (loaded.state.parentSessionId !== root.id ||
      loaded.state.company.blueprintId !== blueprint.id ||
      loaded.state.company.blueprintRevision !== blueprint.revision) {
      throw new ToolError("permission_denied", "Company goal authority is stale");
    }
    try {
      validateCompanyGoalPlanAgainstBlueprint(loaded.state.plan, blueprint);
      validatePlanPolicy(loaded.state.plan, blueprint);
      if (loaded.state.version === 2) {
        validateCompanyGoalPlanAgainstTeamControls(
          loaded.state.plan,
          blueprint,
          loaded.state.teamControl.effective,
        );
      }
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(
        "permission_denied",
        safeMessage(error, "Stored company goal policy is invalid"),
      );
    }
    const unresolved = await this.#unresolvedRuns(
      root,
      blueprint,
      context.signal,
    );
    assertRecoveryActive(context.signal);
    if (loaded.state.status === "waiting_for_approval") {
      throw new ToolError(
        "permission_denied",
        "Company goal is waiting for approval and cannot be generically resumed",
      );
    }
    if (unresolvedStatuses.has(loaded.state.status) &&
      (unresolved.length !== 1 || unresolved[0]?.id !== runId)) {
      throw new ToolError(
        "permission_denied",
        unresolved.length > 1
          ? "Company goal recovery found multiple unresolved runs; inspect /company operations"
          : "The selected company goal is not the sole unresolved run",
      );
    }
    if (loaded.state.status === "completed") {
      const runtime: ActiveCompanyGoal = {
        blueprint,
        journal: new GoalJournal(this.dependencies.runs, loaded),
        rootContext: context,
        root,
        knowledgeByAssignment: new Map(),
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
          workflow: delegationWorkflowUsage(runtime.budget),
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
    const knowledge = await this.#knowledgeForPlan(
      blueprint,
      loaded.state.objective,
      loaded.state.plan,
      loaded.state.createdAt,
      context.signal,
    );
    assertRecoveryActive(context.signal);
    const runtime: ActiveCompanyGoal = {
      blueprint,
      journal,
      rootContext: context,
      root,
      knowledgeByAssignment: knowledge.byAssignment,
      knowledgeRevision: knowledge.revision,
      budget: mutableBudget(journal.current.state),
      activeAssignments: new Set(),
    };
    const recoveredChildren = await this.#preflightRecoveredChildren(
      runtime,
      context.signal,
    );
    assertRecoveryActive(context.signal);
    if (loaded.state.status === "created" || loaded.state.status === "interrupted") {
      await journal.update((run) => ({
        ...run,
        status: "running",
        updatedAt: this.#now(),
      }), context.signal);
      assertRecoveryActive(context.signal);
    }
    const teamRunIds = new Set(journal.current.state.plan.assignments.flatMap(
      (assignment) => assignment.status === "running" &&
          assignment.execution !== undefined && isTeamExecution(assignment.execution)
        ? [assignment.execution.teamRunId]
        : [],
    ));
    for (const teamRunId of teamRunIds) {
      const team = this.dependencies.team;
      if (team === undefined) {
        assertRecoveryActive(context.signal);
        await journal.update((run) => ({
          ...run,
          status: "interrupted",
          updatedAt: this.#now(),
        }), context.signal);
        throw new ToolError(
          "execution_failed",
          "Company team recovery requires the durable team engine",
        );
      }
      let result: TeamRunResult;
      try {
        result = await team.inspectCompanyRun(
          root.id,
          teamRunId,
          context.signal,
        );
        assertRecoveryActive(context.signal);
      } catch (error) {
        assertRecoveryActive(context.signal);
        await journal.update((run) => ({
          ...run,
          status: "interrupted",
          updatedAt: this.#now(),
        }), context.signal);
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
        assertRecoveryActive(context.signal);
        await journal.update((run) => ({
          ...run,
          status: "interrupted",
          updatedAt: this.#now(),
        }), context.signal);
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
      await this.#settleTeamResult(
        runtime,
        teamRunId,
        result,
        context.signal,
      );
      assertRecoveryActive(context.signal);
    }
    for (const assignment of journal.current.state.plan.assignments) {
      if (assignment.status !== "running" || assignment.execution === undefined) continue;
      if (!isChildExecution(assignment.execution)) {
        continue;
      }
      const recoveredChild = recoveredChildren.get(assignment.id) ?? null;
      assertRecoveryActive(context.signal);
      if (recoveredChild !== null &&
        (recoveredChild.agentLifecycle.status === "failed" ||
          recoveredChild.agentLifecycle.status === "cancelled")) {
        await this.#recoverTerminalAssignment(
          runtime,
          assignment,
          recoveredChild,
          context.signal,
        );
        assertRecoveryActive(context.signal);
        continue;
      }
      if (recoveredChild === null ||
        recoveredChild.agentResult === null ||
        recoveredChild.agentLifecycle.status !== "completed") {
        assertRecoveryActive(context.signal);
        throw new ToolError(
          "execution_failed",
          "Company child recovery correlation or terminal state is invalid",
        );
      }
      const used = recoveredChild.agentResult.steps === null
        ? childRequestAllowance(root.agent)
        : Math.min(
            childRequestAllowance(root.agent),
            recoveredChild.agentResult.steps,
          );
      runtime.budget.requestsUsed = Math.min(
        runtime.budget.maxRequests,
        runtime.budget.requestsUsed + used,
      );
      runtime.budget.reportedCostUsd +=
        recoveredChild.agentResult.usage?.costUsd ?? 0;
      const result: ChildDelegationResult = {
        output: recoveredChild.agentResult.finalText,
        metadata: {
          childAgentId: recoveredChild.agent.id,
          childSessionId: recoveredChild.id,
          taskId: recoveredChild.agent.task!.id,
          attempts: 1,
          retries: 0,
          operatingModeId: recoveredChild.agent.operatingMode.id,
          profileId: recoveredChild.agent.profile!.id,
          usage: recoveredChild.agentResult.usage,
          usageSource: recoveredChild.agentResult.usageSource,
          requestsUsed: used,
          evidenceSource: recoveredChild.agentResult.evidenceSource,
          changedFiles: [...recoveredChild.agentResult.changedFiles],
          evidence: [...recoveredChild.agentResult.evidence],
          costLimitUsd: runtime.budget.maxReportedCostUsd,
          costLimitExceeded:
            runtime.budget.reportedCostUsd > runtime.budget.maxReportedCostUsd,
          workflow: delegationWorkflowUsage(runtime.budget),
          company: recoveredChild.agent.company!,
        },
      };
      await this.#completeAssignment(
        runtime,
        assignment,
        result,
        context.signal,
      );
      assertRecoveryActive(context.signal);
    }
    this.#activeRuns.set(runId, runtime);
    try {
      assertRecoveryActive(context.signal);
      return await this.#finish(runtime, context.signal);
    } finally {
      this.#activeRuns.delete(runId);
    }
  }

  async resume(runId: string, context: ToolContext): Promise<ToolResult> {
    if (context.signal.aborted) {
      throw new ToolError("cancelled", "Company goal resume was cancelled");
    }
    const { root, blueprint } = await this.#resumeAuthority(context);
    const owner = await this.#acquireOwner(runId, root.id, "resume");
    try {
      await owner.assertOwned();
      try {
        return await this.#resumeOwned(runId, context, root, blueprint);
      } catch (error) {
        if (context.signal.aborted) assertRecoveryActive(context.signal);
        throw error;
      }
    } finally {
      await owner.release();
    }
  }
}
