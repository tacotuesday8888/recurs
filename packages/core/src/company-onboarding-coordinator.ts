import { randomUUID } from "node:crypto";

import {
  COMPANY_REPOSITORY_MARKERS,
  getCompanyOnboardingDepthPolicy,
  getOperatingModePolicy,
  parseCompanyBlueprintV2,
  parseCompanyOnboardingRun,
  type AgentPermissionMode,
  type AgentProfileId,
  type CompanyOnboardingDepth,
  type CompanyOnboardingRunV1,
  type CompanyProjectStage,
  type CompanyProjectType,
  type CompanyProjectV2,
  type CompanyRoleCapability,
  type CompanyRoleKind,
  type CompanyToolBundleId,
  type CompanyDesignMode,
  type CompanyBlueprintV2,
  type OperatingModeId,
} from "@recurs/contracts";

import {
  approveCompanyBlueprintV2,
  compileCompanyBlueprintV2,
  type CompanyOrganizationDraftV1,
} from "./company-blueprint-v2.js";
import type { FileCompanyBlueprintV2Store } from "./file-company-blueprint-v2-store.js";
import type { FileCompanyOnboardingStore } from "./file-company-onboarding-store.js";
import type { SequencedCompanyState } from "./private-state-store.js";

export const COMPANY_ONBOARDING_TOOL_NAMES = Object.freeze([
  "read_file",
  "list_files",
  "search_text",
  "code_outline",
  "git_status",
  "git_history",
  "git_show",
  "git_diff",
] as const);

export interface CompanyOnboardingResearchDraftV1 {
  readonly key: string;
  readonly description: string;
  readonly prompt: string;
}

export type CompanyOnboardingDecisionV1 =
  | {
    readonly kind: "question";
    readonly id: string;
    readonly question: string;
  }
  | {
    readonly kind: "research";
    readonly assignments: readonly CompanyOnboardingResearchDraftV1[];
  }
  | {
    readonly kind: "propose";
    readonly project: CompanyProjectV2;
    readonly organization?: CompanyOrganizationDraftV1;
    readonly initialGoal: string;
    readonly roadmap: readonly string[];
  };

export interface CompanyOnboardingModelResult {
  readonly decision: unknown;
  readonly requestsUsed: number;
  readonly reportedCostUsd: number;
}

export interface CompanyOnboardingModelPort {
  decide(input: {
    readonly run: CompanyOnboardingRunV1;
    readonly allowedTools: typeof COMPANY_ONBOARDING_TOOL_NAMES;
    readonly maxRequests: number;
  }, signal: AbortSignal): Promise<CompanyOnboardingModelResult>;
}

export interface CompanyOnboardingResearchPort {
  run(input: {
    readonly run: CompanyOnboardingRunV1;
    readonly assignment: CompanyOnboardingRunV1["research"][number];
    readonly profile: "explore_v1";
    readonly allowedTools: typeof COMPANY_ONBOARDING_TOOL_NAMES;
    readonly maxRequests: number;
  }, signal: AbortSignal): Promise<{
    readonly evidence: readonly string[];
    readonly requestsUsed: number;
    readonly reportedCostUsd: number;
  }>;
}

export interface CompanyProposalRevisionModelPort {
  revise(input: {
    readonly run: CompanyOnboardingRunV1;
    readonly blueprint: CompanyBlueprintV2;
    readonly instruction: string;
    readonly allowedTools: typeof COMPANY_ONBOARDING_TOOL_NAMES;
    readonly maxRequests: number;
  }, signal: AbortSignal): Promise<{
    readonly blueprint: unknown;
    readonly requestsUsed: number;
    readonly reportedCostUsd: number;
  }>;
}

export interface CompanyProposalRevisionInput {
  readonly source: "chat" | "yaml";
  readonly blueprint: unknown;
  readonly requestsUsed: number;
  readonly reportedCostUsd: number;
}

export interface CompanyProposalRevisionResult {
  readonly changed: boolean;
  readonly run: SequencedCompanyState<CompanyOnboardingRunV1>;
}

export interface CompanyOnboardingStartInput {
  readonly projectRoot: string;
  readonly depth: CompanyOnboardingDepth;
  readonly designMode: CompanyDesignMode;
  readonly permissionMode: AgentPermissionMode;
  readonly operatingModeId: OperatingModeId;
  readonly backendFingerprint: string;
  readonly repositoryConsent: boolean;
  readonly signal?: AbortSignal;
}

export type CompanyOnboardingAdvanceResult =
  | {
    readonly kind: "question";
    readonly question: NonNullable<
      CompanyOnboardingRunV1["interview"]["pendingQuestion"]
    >;
    readonly run: SequencedCompanyState<CompanyOnboardingRunV1>;
  }
  | {
    readonly kind: "researched";
    readonly run: SequencedCompanyState<CompanyOnboardingRunV1>;
  }
  | {
    readonly kind: "proposal";
    readonly blueprint: NonNullable<CompanyOnboardingRunV1["proposal"]>["blueprint"];
    readonly run: SequencedCompanyState<CompanyOnboardingRunV1>;
  };

export type CompanyOnboardingCoordinatorErrorCode =
  | "invalid_state"
  | "invalid_model_output"
  | "policy_violation"
  | "resume_mismatch"
  | "cancelled";

export class CompanyOnboardingCoordinatorError extends Error {
  constructor(
    readonly code: CompanyOnboardingCoordinatorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CompanyOnboardingCoordinatorError";
  }
}

interface Dependencies {
  readonly runs: Pick<
    FileCompanyOnboardingStore,
    "create" | "append" | "load" | "list"
  >;
  readonly blueprints: Pick<FileCompanyBlueprintV2Store, "create" | "load">;
  readonly model: CompanyOnboardingModelPort;
  readonly research: CompanyOnboardingResearchPort;
  readonly now?: () => string;
  readonly newId?: (kind: "onboarding" | "company" | "blueprint" | "research") => string;
}

const terminalStatuses = new Set<CompanyOnboardingRunV1["status"]>([
  "approved",
  "abandoned",
  "cancelled",
  "failed",
]);
const projectTypes = new Set<CompanyProjectType>([
  "ios_app", "macos_app", "web_app", "backend", "ai_ml",
  "infrastructure", "game", "plugin", "existing_project", "other",
]);
const projectStages = new Set<CompanyProjectStage>([
  "idea", "prototype", "active", "maintenance",
]);
const roleKinds = new Set<CompanyRoleKind>([
  "orchestrator", "lead", "specialist", "worker", "reviewer",
]);
const capabilities = new Set<CompanyRoleCapability>([
  "plan", "research", "implement", "review", "repair", "tool_curation",
  "release",
]);
const profiles = new Set<AgentProfileId>([
  "explore_v1", "implement_v1", "review_v1", "implement_v2", "review_v2",
  "repair_v1",
]);
const permissions = new Set<AgentPermissionMode>([
  "ask_always", "approved_for_me", "full_access",
]);
const bundles = new Set<CompanyToolBundleId>([
  "project_context_v1", "source_control_v1", "architecture_v1",
  "implementation_v1", "quality_v1", "security_v1", "release_v1",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const encoder = new TextEncoder();

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) =>
    key !== expected[index]
  )) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function text(value: unknown, label: string, maximum = 8_192): string {
  if (typeof value !== "string" || value.length === 0 ||
    encoder.encode(value).byteLength > maximum || value.includes("\0")) {
    throw new TypeError(`${label} must be bounded text`);
  }
  return value;
}

function id(value: unknown, label: string): string {
  const parsed = text(value, label, 128);
  if (!SAFE_ID.test(parsed)) throw new TypeError(`${label} is invalid`);
  return parsed;
}

function textArray(
  value: unknown,
  label: string,
  maximumItems: number,
  allowEmpty = true,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems ||
    (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} is invalid`);
  }
  const parsed = value.map((item) => text(item, label, 2_000));
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError(`${label} must be unique`);
  }
  return parsed;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string,
): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value as T;
}

function parseProject(value: unknown): CompanyProjectV2 {
  const project = record(value, "Company proposal project");
  exact(project, [
    "type", "stage", "purpose", "users", "successCriteria", "constraints",
    "risks", "architecturePreferences", "deploymentTargets", "repository",
  ], "Company proposal project");
  const repository = record(project.repository, "Company proposal repository");
  exact(repository, ["inspected", "markers", "evidence"],
    "Company proposal repository");
  if (typeof repository.inspected !== "boolean" ||
    !Array.isArray(repository.markers) || !Array.isArray(repository.evidence)) {
    throw new TypeError("Company proposal repository is invalid");
  }
  const markerSet = new Set<string>(COMPANY_REPOSITORY_MARKERS);
  const markers = repository.markers.map((marker) =>
    enumValue(marker, markerSet, "Company repository marker")
  ) as CompanyProjectV2["repository"]["markers"];
  const evidence = repository.evidence.map((item) => {
    const entry = record(item, "Company repository evidence");
    exact(entry, ["path", "finding"], "Company repository evidence");
    return {
      path: text(entry.path, "Company repository evidence path", 4_096),
      finding: text(entry.finding, "Company repository evidence finding", 2_000),
    };
  });
  return {
    type: enumValue(project.type, projectTypes, "Company project type"),
    stage: enumValue(project.stage, projectStages, "Company project stage"),
    purpose: text(project.purpose, "Company project purpose", 8_192),
    users: textArray(project.users, "Company project users", 32),
    successCriteria: textArray(
      project.successCriteria,
      "Company project success criteria",
      64,
    ),
    constraints: textArray(project.constraints, "Company project constraints", 64),
    risks: textArray(project.risks, "Company project risks", 64),
    architecturePreferences: textArray(
      project.architecturePreferences,
      "Company architecture preferences",
      64,
    ),
    deploymentTargets: textArray(
      project.deploymentTargets,
      "Company deployment targets",
      32,
    ),
    repository: { inspected: repository.inspected, markers, evidence },
  };
}

function parseOrganization(value: unknown): CompanyOrganizationDraftV1 {
  const organization = record(value, "Company organization draft");
  exact(organization, [
    "departments", "roles", "rootRoleKey", "independentReviewRoleKeys",
    "defaultActiveRoleKeys",
  ], "Company organization draft");
  if (!Array.isArray(organization.departments) ||
    !Array.isArray(organization.roles)) {
    throw new TypeError("Company organization draft is invalid");
  }
  const departments = organization.departments.map((item) => {
    const department = record(item, "Company department draft");
    exact(department, ["key", "displayName", "purpose"],
      "Company department draft");
    return {
      key: id(department.key, "Company department key"),
      displayName: text(department.displayName, "Company department name", 256),
      purpose: text(department.purpose, "Company department purpose", 2_000),
    };
  });
  const roles = organization.roles.map((item) => {
    const role = record(item, "Company role draft");
    exact(role, [
      "key", "displayName", "kind", "departmentKey", "responsibility",
      "instructions", "reportsToKey", "capabilities", "executionProfileId",
      "permissionMode", "toolBundles", "expectedEvidence", "activation",
    ], "Company role draft");
    if (!Array.isArray(role.capabilities) || !Array.isArray(role.toolBundles)) {
      throw new TypeError("Company role draft capabilities are invalid");
    }
    return {
      key: id(role.key, "Company role key"),
      displayName: text(role.displayName, "Company role name", 256),
      kind: enumValue(role.kind, roleKinds, "Company role kind"),
      departmentKey: id(role.departmentKey, "Company role department key"),
      responsibility: text(role.responsibility, "Company role responsibility", 2_000),
      instructions: text(role.instructions, "Company role instructions", 8_192),
      reportsToKey: role.reportsToKey === null
        ? null
        : id(role.reportsToKey, "Company role manager key"),
      capabilities: role.capabilities.map((capability) =>
        enumValue(capability, capabilities, "Company role capability")
      ),
      executionProfileId: role.executionProfileId === null
        ? null
        : enumValue(role.executionProfileId, profiles, "Company role profile"),
      permissionMode: enumValue(
        role.permissionMode,
        permissions,
        "Company role permission",
      ),
      toolBundles: role.toolBundles.map((bundle) =>
        enumValue(bundle, bundles, "Company role tool bundle")
      ),
      expectedEvidence: textArray(
        role.expectedEvidence,
        "Company role expected evidence",
        16,
        false,
      ),
      activation: enumValue(
        role.activation,
        new Set(["always", "on_demand"] as const),
        "Company role activation",
      ),
    };
  });
  return {
    departments,
    roles,
    rootRoleKey: id(organization.rootRoleKey, "Company root role key"),
    independentReviewRoleKeys: textArray(
      organization.independentReviewRoleKeys,
      "Company independent reviewer key",
      16,
      false,
    ),
    defaultActiveRoleKeys: textArray(
      organization.defaultActiveRoleKeys,
      "Company active role key",
      24,
      false,
    ),
  };
}

export function parseCompanyOnboardingDecision(
  value: unknown,
): CompanyOnboardingDecisionV1 {
  const decision = record(value, "Company onboarding decision");
  if (decision.kind === "question") {
    exact(decision, ["kind", "id", "question"], "Company question decision");
    return {
      kind: "question",
      id: id(decision.id, "Company question id"),
      question: text(decision.question, "Company question", 2_000),
    };
  }
  if (decision.kind === "research") {
    exact(decision, ["kind", "assignments"], "Company research decision");
    if (!Array.isArray(decision.assignments) || decision.assignments.length === 0 ||
      decision.assignments.length > 8) {
      throw new TypeError("Company research decision is invalid");
    }
    const assignments = decision.assignments.map((item) => {
      const assignment = record(item, "Company research draft");
      exact(assignment, ["key", "description", "prompt"],
        "Company research draft");
      return {
        key: id(assignment.key, "Company research key"),
        description: text(
          assignment.description,
          "Company research description",
          512,
        ),
        prompt: text(assignment.prompt, "Company research prompt", 8_192),
      };
    });
    if (new Set(assignments.map((item) => item.key)).size !== assignments.length) {
      throw new TypeError("Company research keys must be unique");
    }
    return { kind: "research", assignments };
  }
  if (decision.kind === "propose") {
    const allowed = ["kind", "project", "initialGoal", "roadmap"];
    if (Object.hasOwn(decision, "organization")) allowed.push("organization");
    exact(decision, allowed, "Company proposal decision");
    return {
      kind: "propose",
      project: parseProject(decision.project),
      ...(decision.organization === undefined
        ? {}
        : { organization: parseOrganization(decision.organization) }),
      initialGoal: text(decision.initialGoal, "Company initial goal", 4_000),
      roadmap: textArray(decision.roadmap, "Company roadmap", 16, false),
    };
  }
  throw new TypeError("Company onboarding decision kind is invalid");
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error && signal.reason.message.length > 0
    ? signal.reason.message.slice(0, 2_000)
    : "Onboarding was cancelled.";
}

function isCancelled(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || error instanceof Error && error.name === "AbortError";
}

function validUsage(value: {
  readonly requestsUsed: number;
  readonly reportedCostUsd: number;
}): boolean {
  return Number.isSafeInteger(value.requestsUsed) && value.requestsUsed >= 1 &&
    Number.isFinite(value.reportedCostUsd) && value.reportedCostUsd >= 0;
}

function sameIds(
  left: readonly { readonly id: string }[],
  right: readonly { readonly id: string }[],
): boolean {
  const leftIds = left.map((item) => item.id).sort();
  const rightIds = right.map((item) => item.id).sort();
  return leftIds.length === rightIds.length &&
    leftIds.every((id, index) => id === rightIds[index]);
}

function assertProposalRevision(
  previous: CompanyBlueprintV2,
  next: CompanyBlueprintV2,
): void {
  if (next.state !== "proposed" || next.approvedAt !== null ||
    next.id !== previous.id || next.companyId !== previous.companyId ||
    next.version !== previous.version || next.revision !== previous.revision ||
    next.previousBlueprintId !== previous.previousBlueprintId ||
    next.createdAt !== previous.createdAt || next.designMode !== previous.designMode ||
    JSON.stringify(next.authority) !== JSON.stringify(previous.authority) ||
    JSON.stringify(next.provenance) !== JSON.stringify(previous.provenance) ||
    !sameIds(previous.departments, next.departments) ||
    !sameIds(previous.roles, next.roles)) {
    throw new TypeError(
      "Proposal identity, authority, provenance, and stable role ids are immutable",
    );
  }
}

export class CompanyOnboardingCoordinator {
  readonly #now: () => string;
  readonly #newId: NonNullable<Dependencies["newId"]>;

  constructor(readonly dependencies: Dependencies) {
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#newId = dependencies.newId ?? (() => randomUUID());
  }

  async start(
    input: CompanyOnboardingStartInput,
  ): Promise<SequencedCompanyState<CompanyOnboardingRunV1>> {
    input.signal?.throwIfAborted();
    const at = this.#now();
    const mode = getOperatingModePolicy(input.operatingModeId);
    const run = parseCompanyOnboardingRun({
      id: this.#newId("onboarding"),
      companyId: this.#newId("company"),
      version: 1,
      projectRoot: input.projectRoot,
      status: "interviewing",
      createdAt: at,
      updatedAt: at,
      depth: input.depth,
      designMode: input.designMode,
      authority: {
        permissionMode: input.permissionMode,
        operatingModeId: input.operatingModeId,
        operatingModeVersion: mode.version,
      },
      backend: { fingerprint: input.backendFingerprint },
      repositoryAccess: input.repositoryConsent
        ? { scope: "project_read", grantedAt: at }
        : { scope: "none", grantedAt: null },
      interview: { complete: false, pendingQuestion: null, answers: [] },
      research: [],
      usage: { modelRequests: 0, reportedCostUsd: 0 },
      proposal: null,
      approvedBlueprintId: null,
      terminalReason: null,
    });
    return await this.dependencies.runs.create(run, input.signal);
  }

  async resume(
    input: CompanyOnboardingStartInput,
  ): Promise<SequencedCompanyState<CompanyOnboardingRunV1> | null> {
    input.signal?.throwIfAborted();
    const candidates = (await this.dependencies.runs.list(input.signal))
      .filter((entry) => entry.state.projectRoot === input.projectRoot &&
        !terminalStatuses.has(entry.state.status))
      .sort((left, right) =>
        right.state.updatedAt.localeCompare(left.state.updatedAt) ||
        right.state.id.localeCompare(left.state.id)
      );
    const candidate = candidates[0];
    if (candidate === undefined) return null;
    const run = candidate.state;
    if (run.depth !== input.depth || run.designMode !== input.designMode ||
      run.authority.permissionMode !== input.permissionMode ||
      run.authority.operatingModeId !== input.operatingModeId ||
      run.backend.fingerprint !== input.backendFingerprint ||
      (run.repositoryAccess.scope === "project_read") !== input.repositoryConsent) {
      throw new CompanyOnboardingCoordinatorError(
        "resume_mismatch",
        "The unfinished onboarding run is bound to different authority or backend settings",
      );
    }
    return candidate;
  }

  save(id: string, signal?: AbortSignal) {
    return this.dependencies.runs.load(id, signal);
  }

  approvedBlueprint(id: string, signal?: AbortSignal) {
    return this.dependencies.blueprints.load(id, signal);
  }

  async answer(
    runId: string,
    expectedSequence: number,
    answer: string,
    signal?: AbortSignal,
  ): Promise<SequencedCompanyState<CompanyOnboardingRunV1>> {
    signal?.throwIfAborted();
    const loaded = await this.dependencies.runs.load(runId, signal);
    if (loaded.sequence !== expectedSequence ||
      loaded.state.status !== "interviewing" ||
      loaded.state.interview.pendingQuestion === null) {
      throw new CompanyOnboardingCoordinatorError(
        "invalid_state",
        "Company onboarding is not waiting for this answer",
      );
    }
    const pending = loaded.state.interview.pendingQuestion;
    const next = parseCompanyOnboardingRun({
      ...loaded.state,
      updatedAt: this.#now(),
      interview: {
        ...loaded.state.interview,
        pendingQuestion: null,
        answers: [...loaded.state.interview.answers, {
          id: pending.id,
          question: pending.question,
          answer,
          at: this.#now(),
        }],
      },
    });
    return await this.dependencies.runs.append(
      runId,
      expectedSequence,
      next,
      signal,
    );
  }

  async advance(
    runId: string,
    signal = new AbortController().signal,
  ): Promise<CompanyOnboardingAdvanceResult> {
    if (signal.aborted) {
      await this.#cancelLoaded(await this.dependencies.runs.load(runId), abortReason(signal));
      throw new CompanyOnboardingCoordinatorError("cancelled", "Onboarding cancelled");
    }
    let loaded = await this.dependencies.runs.load(runId, signal);
    if (loaded.state.status === "interviewing" &&
      loaded.state.interview.pendingQuestion !== null) {
      return {
        kind: "question",
        question: loaded.state.interview.pendingQuestion,
        run: loaded,
      };
    }
    if (loaded.state.status !== "interviewing") {
      throw new CompanyOnboardingCoordinatorError(
        "invalid_state",
        "Company onboarding cannot advance from its current state",
      );
    }
    const policy = getCompanyOnboardingDepthPolicy(
      loaded.state.depth,
      loaded.state.authority.operatingModeId,
    );
    const remaining = policy.maxModelRequests - loaded.state.usage.modelRequests;
    if (remaining < 1) {
      await this.#fail(loaded, "Onboarding model request budget was exhausted.", signal);
      throw new CompanyOnboardingCoordinatorError(
        "policy_violation",
        "Onboarding model request budget was exhausted",
      );
    }

    let result: CompanyOnboardingModelResult;
    try {
      result = await this.dependencies.model.decide({
        run: loaded.state,
        allowedTools: COMPANY_ONBOARDING_TOOL_NAMES,
        maxRequests: remaining,
      }, signal);
    } catch (error) {
      if (isCancelled(error, signal)) {
        await this.#cancelLoaded(loaded, abortReason(signal));
        throw new CompanyOnboardingCoordinatorError("cancelled", "Onboarding cancelled");
      }
      await this.#fail(loaded, "The onboarding model failed safely.", signal);
      throw new CompanyOnboardingCoordinatorError(
        "invalid_model_output",
        "The onboarding model failed safely",
        { cause: error },
      );
    }
    if (!validUsage(result) || result.requestsUsed > remaining) {
      await this.#fail(loaded, "The onboarding model reported invalid usage.", signal);
      throw new CompanyOnboardingCoordinatorError(
        "invalid_model_output",
        "The onboarding model reported invalid usage",
      );
    }
    const maximumCost = getOperatingModePolicy(
      loaded.state.authority.operatingModeId,
    ).company!.maxReportedCostUsd;
    const reportedCostUsd = loaded.state.usage.reportedCostUsd +
      result.reportedCostUsd;
    if (reportedCostUsd > maximumCost) {
      await this.#fail(loaded, "The onboarding reported-cost ceiling was exceeded.", signal);
      throw new CompanyOnboardingCoordinatorError(
        "policy_violation",
        "The onboarding reported-cost ceiling was exceeded",
      );
    }

    let decision: CompanyOnboardingDecisionV1;
    try {
      decision = parseCompanyOnboardingDecision(result.decision);
    } catch (error) {
      const accounted = await this.#append(loaded, {
        ...loaded.state,
        updatedAt: this.#now(),
        usage: {
          modelRequests: loaded.state.usage.modelRequests + result.requestsUsed,
          reportedCostUsd,
        },
      }, signal);
      await this.#fail(accounted, "The onboarding model returned an invalid decision.", signal);
      throw new CompanyOnboardingCoordinatorError(
        "invalid_model_output",
        "The onboarding model returned an invalid decision",
        { cause: error },
      );
    }
    loaded = await this.#append(loaded, {
      ...loaded.state,
      updatedAt: this.#now(),
      usage: {
        modelRequests: loaded.state.usage.modelRequests + result.requestsUsed,
        reportedCostUsd,
      },
    }, signal);

    if (decision.kind === "question") {
      if (loaded.state.interview.answers.length >= policy.maxInterviewRounds ||
        loaded.state.interview.answers.some((answer) => answer.id === decision.id)) {
        await this.#fail(loaded, "The interview question limit was exceeded.", signal);
        throw new CompanyOnboardingCoordinatorError(
          "policy_violation",
          "The interview question limit was exceeded",
        );
      }
      const run = await this.#append(loaded, {
        ...loaded.state,
        updatedAt: this.#now(),
        interview: {
          ...loaded.state.interview,
          pendingQuestion: { id: decision.id, question: decision.question },
        },
      }, signal);
      return { kind: "question", question: run.state.interview.pendingQuestion!, run };
    }
    if (decision.kind === "research") {
      return await this.#research(loaded, decision.assignments, policy, signal);
    }

    let blueprint;
    try {
      blueprint = compileCompanyBlueprintV2({
        id: this.#newId("blueprint"),
        companyId: loaded.state.companyId,
        revision: 1,
        previousBlueprintId: null,
        createdAt: this.#now(),
        onboardingRunId: loaded.state.id,
        onboardingDepth: loaded.state.depth,
        generatedBy: "model_assisted",
        designMode: loaded.state.designMode,
        project: decision.project,
        permissionMode: loaded.state.authority.permissionMode,
        operatingModeId: loaded.state.authority.operatingModeId,
        ...(decision.organization === undefined
          ? {}
          : { organization: decision.organization }),
        initialGoal: decision.initialGoal,
        roadmap: decision.roadmap,
      });
    } catch (error) {
      await this.#fail(loaded, "The proposed company violated its approved policy.", signal);
      throw new CompanyOnboardingCoordinatorError(
        "invalid_model_output",
        "The proposed company violated its approved policy",
        { cause: error },
      );
    }
    const run = await this.#append(loaded, {
      ...loaded.state,
      status: "proposed",
      updatedAt: this.#now(),
      interview: {
        ...loaded.state.interview,
        complete: true,
        pendingQuestion: null,
      },
      proposal: {
        revision: 1,
        source: "initial",
        createdAt: this.#now(),
        blueprint,
      },
    }, signal);
    return { kind: "proposal", blueprint, run };
  }

  async approve(
    runId: string,
    expectedSequence: number,
    signal?: AbortSignal,
  ): Promise<SequencedCompanyState<CompanyOnboardingRunV1>> {
    signal?.throwIfAborted();
    const loaded = await this.dependencies.runs.load(runId, signal);
    if (loaded.sequence !== expectedSequence || loaded.state.status !== "proposed" ||
      loaded.state.proposal === null) {
      throw new CompanyOnboardingCoordinatorError(
        "invalid_state",
        "Company onboarding has no current proposal to approve",
      );
    }
    const approved = approveCompanyBlueprintV2(
      loaded.state.proposal.blueprint,
      this.#now(),
    );
    await this.dependencies.blueprints.create(approved, signal);
    return await this.#append(loaded, {
      ...loaded.state,
      status: "approved",
      updatedAt: this.#now(),
      approvedBlueprintId: approved.id,
    }, signal);
  }

  async reviseProposal(
    runId: string,
    expectedSequence: number,
    input: CompanyProposalRevisionInput,
    signal?: AbortSignal,
  ): Promise<CompanyProposalRevisionResult> {
    signal?.throwIfAborted();
    let loaded = await this.dependencies.runs.load(runId, signal);
    if (loaded.sequence !== expectedSequence || loaded.state.status !== "proposed" ||
      loaded.state.proposal === null) {
      throw new CompanyOnboardingCoordinatorError(
        "invalid_state",
        "Company onboarding has no current proposal to revise",
      );
    }
    const previousProposal = loaded.state.proposal;
    const chat = input.source === "chat";
    if (!Number.isSafeInteger(input.requestsUsed) ||
      (chat ? input.requestsUsed < 1 : input.requestsUsed !== 0) ||
      !Number.isFinite(input.reportedCostUsd) || input.reportedCostUsd < 0 ||
      (!chat && input.reportedCostUsd !== 0)) {
      throw new CompanyOnboardingCoordinatorError(
        "invalid_model_output",
        "Company proposal revision reported invalid usage",
      );
    }
    const depthPolicy = getCompanyOnboardingDepthPolicy(
      loaded.state.depth,
      loaded.state.authority.operatingModeId,
    );
    const maximumCost = getOperatingModePolicy(
      loaded.state.authority.operatingModeId,
    ).company!.maxReportedCostUsd;
    const usage = {
      modelRequests: loaded.state.usage.modelRequests + input.requestsUsed,
      reportedCostUsd: loaded.state.usage.reportedCostUsd + input.reportedCostUsd,
    };
    if (usage.modelRequests > depthPolicy.maxModelRequests ||
      usage.reportedCostUsd > maximumCost) {
      throw new CompanyOnboardingCoordinatorError(
        "policy_violation",
        "Company proposal revision exceeded the onboarding budget",
      );
    }
    if (chat) {
      loaded = await this.#append(loaded, {
        ...loaded.state,
        updatedAt: this.#now(),
        usage,
      }, signal);
    }

    let candidate: CompanyBlueprintV2;
    try {
      candidate = parseCompanyBlueprintV2(input.blueprint);
      assertProposalRevision(previousProposal.blueprint, candidate);
    } catch (error) {
      throw new CompanyOnboardingCoordinatorError(
        "invalid_model_output",
        "Company proposal revision is invalid",
        { cause: error },
      );
    }
    if (JSON.stringify(candidate) ===
      JSON.stringify(previousProposal.blueprint)) {
      return { changed: false, run: loaded };
    }
    const run = await this.#append(loaded, {
      ...loaded.state,
      updatedAt: this.#now(),
      ...(chat ? {} : { usage }),
      proposal: {
        revision: previousProposal.revision + 1,
        source: input.source,
        createdAt: this.#now(),
        blueprint: candidate,
      },
    }, signal);
    return { changed: true, run };
  }

  async cancel(
    runId: string,
    expectedSequence: number,
    reason: string,
    signal?: AbortSignal,
  ): Promise<SequencedCompanyState<CompanyOnboardingRunV1>> {
    const loaded = await this.dependencies.runs.load(runId, signal);
    if (loaded.sequence !== expectedSequence) {
      throw new CompanyOnboardingCoordinatorError(
        "invalid_state",
        "Company onboarding changed before cancellation",
      );
    }
    return await this.#cancelLoaded(loaded, reason, signal);
  }

  async abandon(
    runId: string,
    expectedSequence: number,
    reason: string,
    signal?: AbortSignal,
  ): Promise<SequencedCompanyState<CompanyOnboardingRunV1>> {
    const loaded = await this.dependencies.runs.load(runId, signal);
    if (loaded.sequence !== expectedSequence || terminalStatuses.has(loaded.state.status)) {
      throw new CompanyOnboardingCoordinatorError(
        "invalid_state",
        "Company onboarding cannot be abandoned from its current state",
      );
    }
    return await this.#append(loaded, {
      ...loaded.state,
      status: "abandoned",
      updatedAt: this.#now(),
      research: this.#cancelResearch(loaded.state.research, reason),
      terminalReason: reason,
    }, signal);
  }

  async #research(
    loaded: SequencedCompanyState<CompanyOnboardingRunV1>,
    drafts: readonly CompanyOnboardingResearchDraftV1[],
    policy: ReturnType<typeof getCompanyOnboardingDepthPolicy>,
    signal: AbortSignal,
  ): Promise<Extract<CompanyOnboardingAdvanceResult, { kind: "researched" }>> {
    if (loaded.state.repositoryAccess.scope !== "project_read" ||
      loaded.state.research.length + drafts.length > policy.maxResearchChildren ||
      policy.maxConcurrentResearch < 1) {
      await this.#fail(loaded, "The requested research exceeded onboarding policy.", signal);
      throw new CompanyOnboardingCoordinatorError(
        "policy_violation",
        "The requested research exceeded onboarding policy",
      );
    }
    const existingPrompts = new Set(loaded.state.research.map((item) => item.prompt));
    if (drafts.some((draft) => existingPrompts.has(draft.prompt))) {
      await this.#fail(loaded, "The requested research duplicated durable work.", signal);
      throw new CompanyOnboardingCoordinatorError(
        "policy_violation",
        "The requested research duplicated durable work",
      );
    }
    const queued = drafts.map((draft) => ({
      id: this.#newId("research"),
      description: draft.description,
      prompt: draft.prompt,
      status: "queued" as const,
      evidence: [] as string[],
      failure: null,
    }));
    loaded = await this.#append(loaded, {
      ...loaded.state,
      status: "researching",
      updatedAt: this.#now(),
      research: [...loaded.state.research, ...queued],
    }, signal);
    loaded = await this.#append(loaded, {
      ...loaded.state,
      updatedAt: this.#now(),
      research: loaded.state.research.map((item) =>
        queued.some((queuedItem) => queuedItem.id === item.id)
          ? { ...item, status: "running" as const }
          : item
      ),
    }, signal);
    const remainingRequests = policy.maxModelRequests -
      loaded.state.usage.modelRequests;
    if (remainingRequests < queued.length) {
      await this.#fail(loaded, "Research request budget was exhausted.", signal);
      throw new CompanyOnboardingCoordinatorError(
        "policy_violation",
        "Research request budget was exhausted",
      );
    }
    const allowance = Math.max(1, Math.floor(remainingRequests / queued.length));
    const results = new Map<string, {
      evidence: readonly string[];
      requestsUsed: number;
      reportedCostUsd: number;
      failure: string | null;
    }>();
    for (let offset = 0; offset < queued.length; offset += policy.maxConcurrentResearch) {
      const batch = queued.slice(offset, offset + policy.maxConcurrentResearch);
      await Promise.all(batch.map(async (assignment) => {
        try {
          const result = await this.dependencies.research.run({
            run: loaded.state,
            assignment,
            profile: "explore_v1",
            allowedTools: COMPANY_ONBOARDING_TOOL_NAMES,
            maxRequests: allowance,
          }, signal);
          if (!validUsage(result) || result.requestsUsed > allowance ||
            !Array.isArray(result.evidence) || result.evidence.length === 0) {
            throw new TypeError("Invalid research result");
          }
          results.set(assignment.id, { ...result, failure: null });
        } catch (error) {
          if (isCancelled(error, signal)) throw error;
          results.set(assignment.id, {
            evidence: [],
            requestsUsed: 0,
            reportedCostUsd: 0,
            failure: "Research assignment failed safely.",
          });
        }
      })).catch(async (error) => {
        if (isCancelled(error, signal)) {
          loaded = await this.#cancelLoaded(loaded, abortReason(signal));
          throw new CompanyOnboardingCoordinatorError(
            "cancelled",
            "Onboarding research was cancelled",
          );
        }
        throw error;
      });
    }
    const requestsUsed = [...results.values()].reduce(
      (sum, result) => sum + result.requestsUsed,
      0,
    );
    const addedCost = [...results.values()].reduce(
      (sum, result) => sum + result.reportedCostUsd,
      0,
    );
    const maximumCost = getOperatingModePolicy(
      loaded.state.authority.operatingModeId,
    ).company!.maxReportedCostUsd;
    if (loaded.state.usage.modelRequests + requestsUsed > policy.maxModelRequests ||
      loaded.state.usage.reportedCostUsd + addedCost > maximumCost) {
      await this.#fail(loaded, "Research exceeded the shared onboarding budget.", signal);
      throw new CompanyOnboardingCoordinatorError(
        "policy_violation",
        "Research exceeded the shared onboarding budget",
      );
    }
    const run = await this.#append(loaded, {
      ...loaded.state,
      status: "interviewing",
      updatedAt: this.#now(),
      usage: {
        modelRequests: loaded.state.usage.modelRequests + requestsUsed,
        reportedCostUsd: loaded.state.usage.reportedCostUsd + addedCost,
      },
      research: loaded.state.research.map((assignment) => {
        const result = results.get(assignment.id);
        if (result === undefined) return assignment;
        return result.failure === null
          ? {
              ...assignment,
              status: "completed" as const,
              evidence: [...result.evidence],
              failure: null,
            }
          : {
              ...assignment,
              status: "failed" as const,
              evidence: [],
              failure: result.failure,
            };
      }),
    }, signal);
    return { kind: "researched", run };
  }

  async #append(
    previous: SequencedCompanyState<CompanyOnboardingRunV1>,
    value: CompanyOnboardingRunV1,
    signal?: AbortSignal,
  ): Promise<SequencedCompanyState<CompanyOnboardingRunV1>> {
    const next = parseCompanyOnboardingRun(value);
    return await this.dependencies.runs.append(
      previous.state.id,
      previous.sequence,
      next,
      signal,
    );
  }

  async #fail(
    loaded: SequencedCompanyState<CompanyOnboardingRunV1>,
    reason: string,
    signal?: AbortSignal,
  ) {
    return await this.#append(loaded, {
      ...loaded.state,
      status: "failed",
      updatedAt: this.#now(),
      research: this.#cancelResearch(loaded.state.research, reason),
      terminalReason: reason,
    }, signal);
  }

  #cancelResearch(
    research: CompanyOnboardingRunV1["research"],
    reason: string,
  ): CompanyOnboardingRunV1["research"] {
    return research.map((assignment) =>
      assignment.status === "queued" || assignment.status === "running"
        ? { ...assignment, status: "cancelled", evidence: [], failure: reason }
        : assignment
    );
  }

  async #cancelLoaded(
    loaded: SequencedCompanyState<CompanyOnboardingRunV1>,
    reason: string,
    signal?: AbortSignal,
  ) {
    if (terminalStatuses.has(loaded.state.status)) return loaded;
    return await this.#append(loaded, {
      ...loaded.state,
      status: "cancelled",
      updatedAt: this.#now(),
      research: this.#cancelResearch(loaded.state.research, reason),
      terminalReason: reason,
    }, signal);
  }
}
