import type {
  SessionBackendPin,
} from "./connections.js";
import type {
  AgentExecutionMode,
  AgentPermissionMode,
  AgentProfileId,
  AgentTeamPolicy,
  OperatingModeId,
  OperatingModePolicy,
  OperatingModeVersion,
} from "./agents.js";
import type {
  CompanyModelRoute,
  CompanyToolBundleId,
} from "./company.js";
import type { TrustedRunContext } from "./runtime.js";

export type TeamRunExecution = "foreground" | "background";
export type TeamRunRole = "implement" | "review" | "repair";
export type TeamRunStatus =
  | "created"
  | "running"
  | "ready_to_apply"
  | "applying"
  | "approved"
  | "changes_requested"
  | "unverified"
  | "failed"
  | "cancelled"
  | "interrupted";
export type TeamRunTerminalStatus = Extract<
  TeamRunStatus,
  "approved" | "changes_requested" | "unverified" | "failed" | "cancelled"
>;
export type TeamRunNonApprovedTerminalStatus = Exclude<
  TeamRunTerminalStatus,
  "approved"
>;
export type TeamRunPhase = "implement" | "stage" | "review" | "repair" | "apply";

export interface TeamReviewFinding {
  readonly path: string | "*";
  readonly problem: string;
  readonly acceptance: string;
  readonly evidence: readonly string[];
}

export interface TeamRunImplementationTask {
  readonly description: string;
  readonly prompt: string;
}

export interface TeamRunRequest {
  readonly description: string;
  readonly tasks: readonly TeamRunImplementationTask[];
  readonly review: { readonly instructions: string };
}

export type TeamRunPolicySnapshot = Omit<
  OperatingModePolicy,
  "workflow"
> & {
  readonly workflow: {
    readonly maxChildrenPerRun: number;
    readonly maxRequestsPerRun: number;
    readonly team: AgentTeamPolicy & { readonly maxRepairRounds: number };
  };
};

export interface TeamRunAllocation {
  readonly maxChildren: number;
  readonly maxRequests: number;
  readonly requestAllowance: number;
  readonly maxReportedCostUsd: number;
}

export interface TeamRunBackendRoute {
  readonly role: TeamRunRole;
  readonly profileId: AgentProfileId;
  readonly executionMode: AgentExecutionMode;
  readonly permissionMode: AgentPermissionMode;
  readonly strategy: "inherit_parent" | "role_candidate";
  readonly candidateId: string;
  readonly reason: "parent_fallback" | "eligible_role_candidate";
  readonly pin: SessionBackendPin;
}

export interface TeamRunCompanyRoleBinding {
  readonly assignmentId: string;
  readonly parentAssignmentId: string | null;
  readonly roleId: string;
  readonly departmentId: string;
  readonly permissionMode: AgentPermissionMode;
  readonly modelRoute: CompanyModelRoute;
  readonly toolBundles: readonly CompanyToolBundleId[];
}

export interface TeamRunCompanyGoalCorrelation {
  readonly version: 1;
  readonly runId: string;
  readonly goalId: string;
  readonly blueprintId: string;
  readonly blueprintRevision: number;
  readonly implementations: readonly TeamRunCompanyRoleBinding[];
  readonly reviews: readonly TeamRunCompanyRoleBinding[];
  readonly repair: TeamRunCompanyRoleBinding | null;
}

export interface TeamRunDescriptor {
  readonly id: string;
  readonly version: 1;
  readonly parentSessionId: string;
  readonly parentAgentId: string;
  readonly execution: TeamRunExecution;
  readonly parentExecutionMode: AgentExecutionMode;
  readonly parentPermissionMode: AgentPermissionMode;
  readonly invocation: Readonly<TrustedRunContext>;
  readonly operatingModeId: OperatingModeId;
  readonly operatingModeVersion: OperatingModeVersion;
  readonly policy: TeamRunPolicySnapshot;
  readonly allocation: TeamRunAllocation;
  readonly routes: readonly TeamRunBackendRoute[];
  readonly backend: SessionBackendPin;
  readonly repositoryRoot: string;
  readonly baseRevision: string;
  readonly request: TeamRunRequest;
  readonly companyGoal?: TeamRunCompanyGoalCorrelation;
}
