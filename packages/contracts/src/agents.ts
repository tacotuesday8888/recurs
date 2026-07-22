import type { IntegrationFailure } from "./failures.js";
import type { ProviderUsage } from "./model.js";
import type { BillingSource } from "./connections.js";
import type { CompanyBlueprintBinding } from "./company.js";

export type AgentPermissionMode =
  | "ask_always"
  | "approved_for_me"
  | "full_access";

export type AgentExecutionMode = "act" | "plan";

export type AgentProfileId =
  | "explore_v1"
  | "implement_v1"
  | "review_v1"
  | "implement_v2"
  | "review_v2"
  | "repair_v1";

export type AgentProfileVersion = 1 | 2;

export type AgentToolPermissionCategory =
  | "read"
  | "write"
  | "shell"
  | "network"
  | "external_path"
  | "sensitive"
  | "credential"
  | "deploy";

export type AgentToolPermissionRisk = "normal" | "elevated" | "destructive";

export interface AgentProfilePolicy {
  readonly id: AgentProfileId;
  readonly version: AgentProfileVersion;
  readonly displayName: string;
  readonly executionMode: AgentExecutionMode;
  readonly tools: {
    readonly readOnly: boolean;
    readonly evidenceFromSources: boolean;
    readonly allowedNames: readonly string[];
    readonly allowedCategories: readonly AgentToolPermissionCategory[];
    readonly maxRisk: AgentToolPermissionRisk;
  };
}

function profile(
  id: AgentProfileId,
  version: AgentProfileVersion,
  displayName: string,
  executionMode: AgentExecutionMode,
  readOnly: boolean,
  allowedNames: readonly string[],
  allowedCategories: readonly AgentToolPermissionCategory[],
  maxRisk: AgentToolPermissionRisk,
): AgentProfilePolicy {
  return Object.freeze({
    id,
    version,
    displayName,
    executionMode,
    tools: Object.freeze({
      readOnly,
      evidenceFromSources: true,
      allowedNames: Object.freeze([...allowedNames]),
      allowedCategories: Object.freeze([...allowedCategories]),
      maxRisk,
    }),
  });
}

export const agentProfilePolicies: readonly AgentProfilePolicy[] = Object.freeze([
  profile(
    "explore_v1",
    1,
    "Explore",
    "plan",
    true,
    [
      "read_file", "list_files", "search_text", "code_outline", "git_status",
      "git_history", "git_show", "git_diff",
    ],
    ["read"],
    "normal",
  ),
  profile(
    "implement_v1",
    1,
    "Implement",
    "act",
    false,
    [
      "read_file", "list_files", "search_text", "code_outline", "apply_patch",
      "run_command", "process_session", "run_verification",
      "git_status", "git_diff",
    ],
    ["read", "write", "shell"],
    "elevated",
  ),
  profile(
    "review_v1",
    1,
    "Review",
    "act",
    true,
    ["read_file", "list_files", "search_text", "code_outline", "git_status", "git_diff"],
    ["read"],
    "normal",
  ),
  profile(
    "implement_v2",
    2,
    "Implement",
    "act",
    false,
    [
      "read_file", "list_files", "search_text", "code_outline", "apply_patch",
      "git_status", "git_diff",
    ],
    ["read", "write"],
    "normal",
  ),
  profile(
    "review_v2",
    2,
    "Review",
    "act",
    true,
    ["read_file", "list_files", "search_text", "code_outline", "git_status", "git_diff"],
    ["read"],
    "normal",
  ),
  profile(
    "repair_v1",
    1,
    "Repair",
    "act",
    false,
    [
      "read_file", "list_files", "search_text", "code_outline", "apply_patch",
      "git_status", "git_diff",
    ],
    ["read", "write"],
    "normal",
  ),
]);

const profilesById = new Map(
  agentProfilePolicies.map((profile) => [profile.id, profile] as const),
);

export function getAgentProfilePolicy(id: AgentProfileId): AgentProfilePolicy {
  const found = profilesById.get(id);
  if (found === undefined) {
    throw new TypeError(`Unknown agent profile: ${String(id)}`);
  }
  return found;
}

export function parseAgentProfileId(input: string): AgentProfileId | null {
  const normalized = input.trim().toLowerCase();
  const exact = profilesById.get(normalized as AgentProfileId);
  if (exact !== undefined) return exact.id;
  for (const item of agentProfilePolicies) {
    if (normalized === item.displayName.toLowerCase()) {
      return item.id;
    }
  }
  return null;
}

export type OperatingModeId =
  | "economy_v1"
  | "standard_v1"
  | "balanced_v1"
  | "performance_v1"
  | "max_v1"
  | "economy_v2"
  | "standard_v2"
  | "balanced_v2"
  | "performance_v2"
  | "max_v2"
  | "economy_v3"
  | "standard_v3"
  | "balanced_v3"
  | "performance_v3"
  | "max_v3"
  | "economy_v4"
  | "standard_v4"
  | "balanced_v4"
  | "performance_v4"
  | "max_v4"
  | "economy_v5"
  | "standard_v5"
  | "balanced_v5"
  | "performance_v5"
  | "max_v5"
  | "economy_v6"
  | "standard_v6"
  | "balanced_v6"
  | "performance_v6"
  | "max_v6";

export type OperatingModeVersion = 1 | 2 | 3 | 4 | 5 | 6;

export type AgentTeamQualityStandard =
  | "essential"
  | "standard"
  | "balanced"
  | "thorough"
  | "maximum";

export interface AgentTeamPolicy {
  readonly qualityStandard: AgentTeamQualityStandard;
  readonly maxImplementers: number;
  readonly initialReviewers: number;
  readonly maxReviewers: number;
  readonly maxRepairRounds?: number;
  readonly approvalRule: "unanimous";
}

export interface AgentLimits {
  readonly maxDepth: number;
  readonly maxConcurrentChildren: number;
  readonly maxRetries: number;
  readonly maxRequests: number;
  readonly maxReportedCostUsd: number;
}

export interface CompanyModePolicy {
  readonly maxDepartments: number;
  readonly maxRoles: number;
  readonly maxActiveRoles: number;
  readonly maxDepth: number;
  readonly maxConcurrentAssignments: number;
  readonly maxGoalRequests: number;
  readonly maxResearchChildren: number;
  readonly maxReportedCostUsd: number;
}

export interface OperatingModePolicy {
  readonly id: OperatingModeId;
  readonly version: OperatingModeVersion;
  readonly displayName: string;
  readonly model:
    | { readonly selection: "inherit_parent" }
    | {
        readonly selection: "configured_role_candidate";
        readonly fallback: "inherit_parent";
        readonly eligibleBillingSources: readonly BillingSource[];
      };
  readonly orchestration: AgentLimits;
  readonly workflow: {
    readonly maxChildrenPerRun: number;
    readonly maxRequestsPerRun: number;
    readonly team: AgentTeamPolicy | null;
  };
  readonly company?: CompanyModePolicy;
}

function routedPolicy(
  id: OperatingModeId,
  displayName: string,
  maxConcurrentChildren: number,
  maxRequests: number,
  maxReportedCostUsd: number,
  maxChildrenPerRun: number,
  teamPolicy: AgentTeamPolicy,
  eligibleBillingSources: readonly BillingSource[],
): OperatingModePolicy {
  return Object.freeze({
    ...policy(
      id,
      5,
      displayName,
      maxConcurrentChildren,
      maxRequests,
      maxReportedCostUsd,
      maxChildrenPerRun,
      teamPolicy,
    ),
    model: Object.freeze({
      selection: "configured_role_candidate" as const,
      fallback: "inherit_parent" as const,
      eligibleBillingSources: Object.freeze([...eligibleBillingSources]),
    }),
  });
}

function routedCompanyPolicy(
  id: OperatingModeId,
  displayName: string,
  maxConcurrentChildren: number,
  maxRequests: number,
  maxReportedCostUsd: number,
  maxChildrenPerRun: number,
  teamPolicy: AgentTeamPolicy,
  eligibleBillingSources: readonly BillingSource[],
  companyPolicy: CompanyModePolicy,
): OperatingModePolicy {
  return Object.freeze({
    ...policy(
      id,
      6,
      displayName,
      maxConcurrentChildren,
      maxRequests,
      maxReportedCostUsd,
      maxChildrenPerRun,
      teamPolicy,
    ),
    model: Object.freeze({
      selection: "configured_role_candidate" as const,
      fallback: "inherit_parent" as const,
      eligibleBillingSources: Object.freeze([...eligibleBillingSources]),
    }),
    company: Object.freeze({ ...companyPolicy }),
  });
}

function policy(
  id: OperatingModeId,
  version: OperatingModeVersion,
  displayName: string,
  maxConcurrentChildren: number,
  maxRequests: number,
  maxReportedCostUsd: number,
  maxChildrenPerRun: number,
  team: AgentTeamPolicy | null = null,
): OperatingModePolicy {
  return Object.freeze({
    id,
    version,
    displayName,
    model: Object.freeze({ selection: "inherit_parent" as const }),
    orchestration: Object.freeze({
      maxDepth: 1,
      maxConcurrentChildren,
      maxRetries: 0,
      maxRequests,
      maxReportedCostUsd,
    }),
    workflow: Object.freeze({
      maxChildrenPerRun,
      maxRequestsPerRun: version === 1
        ? maxRequests * maxChildrenPerRun
        : maxRequests,
      team: team === null ? null : Object.freeze({ ...team }),
    }),
  });
}

function team(
  qualityStandard: AgentTeamQualityStandard,
  maxImplementers: number,
  initialReviewers: number,
  maxReviewers: number,
): AgentTeamPolicy {
  return {
    qualityStandard,
    maxImplementers,
    initialReviewers,
    maxReviewers,
    approvalRule: "unanimous",
  };
}

function teamV4(
  qualityStandard: AgentTeamQualityStandard,
  maxImplementers: number,
  initialReviewers: number,
  maxReviewers: number,
  maxRepairRounds: number,
): AgentTeamPolicy {
  return {
    qualityStandard,
    maxImplementers,
    initialReviewers,
    maxReviewers,
    maxRepairRounds,
    approvalRule: "unanimous",
  };
}

export const operatingModePolicies: readonly OperatingModePolicy[] =
  Object.freeze([
    policy("economy_v1", 1, "Economy", 1, 8, 0.25, 2),
    policy("standard_v1", 1, "Standard", 1, 16, 1, 3),
    policy("balanced_v1", 1, "Balanced", 1, 24, 3, 4),
    policy("performance_v1", 1, "Performance", 1, 32, 10, 6),
    policy("max_v1", 1, "Max", 1, 40, 25, 8),
    policy("economy_v2", 2, "Economy", 1, 8, 0.25, 2),
    policy("standard_v2", 2, "Standard", 2, 16, 1, 3),
    policy("balanced_v2", 2, "Balanced", 3, 24, 3, 4),
    policy("performance_v2", 2, "Performance", 4, 32, 10, 6),
    policy("max_v2", 2, "Max", 6, 40, 25, 8),
    policy("economy_v3", 3, "Economy", 1, 8, 0.25, 2,
      team("essential", 1, 1, 1)),
    policy("standard_v3", 3, "Standard", 2, 18, 1, 3,
      team("standard", 1, 1, 2)),
    policy("balanced_v3", 3, "Balanced", 3, 32, 3, 4,
      team("balanced", 2, 1, 2)),
    policy("performance_v3", 3, "Performance", 4, 60, 10, 6,
      team("thorough", 3, 2, 3)),
    policy("max_v3", 3, "Max", 6, 96, 25, 8,
      team("maximum", 4, 2, 4)),
    policy("economy_v4", 4, "Economy", 1, 8, 0.25, 2,
      teamV4("essential", 1, 1, 1, 0)),
    policy("standard_v4", 4, "Standard", 2, 36, 1, 6,
      teamV4("standard", 1, 1, 2, 1)),
    policy("balanced_v4", 4, "Balanced", 3, 56, 3, 7,
      teamV4("balanced", 2, 1, 2, 1)),
    policy("performance_v4", 4, "Performance", 4, 100, 10, 10,
      teamV4("thorough", 3, 2, 3, 1)),
    policy("max_v4", 4, "Max", 6, 216, 25, 18,
      teamV4("maximum", 4, 2, 4, 2)),
    routedPolicy("economy_v5", "Economy", 1, 8, 0.25, 2,
      teamV4("essential", 1, 1, 1, 0), ["local_compute"]),
    routedPolicy("standard_v5", "Standard", 2, 36, 1, 6,
      teamV4("standard", 1, 1, 2, 1), ["local_compute", "included_subscription"]),
    routedPolicy("balanced_v5", "Balanced", 3, 56, 3, 7,
      teamV4("balanced", 2, 1, 2, 1),
      ["local_compute", "included_subscription", "metered_api"]),
    routedPolicy("performance_v5", "Performance", 4, 100, 10, 10,
      teamV4("thorough", 3, 2, 3, 1),
      ["local_compute", "included_subscription", "metered_api"]),
    routedPolicy("max_v5", "Max", 6, 216, 25, 18,
      teamV4("maximum", 4, 2, 4, 2),
      ["local_compute", "included_subscription", "metered_api"]),
    routedCompanyPolicy("economy_v6", "Economy", 1, 8, 0.25, 2,
      teamV4("essential", 1, 1, 1, 0), ["local_compute"], {
        maxDepartments: 6,
        maxRoles: 8,
        maxActiveRoles: 3,
        maxDepth: 1,
        maxConcurrentAssignments: 1,
        maxGoalRequests: 12,
        maxResearchChildren: 1,
        maxReportedCostUsd: 0.25,
      }),
    routedCompanyPolicy("standard_v6", "Standard", 2, 36, 1, 6,
      teamV4("standard", 1, 1, 2, 1),
      ["local_compute", "included_subscription"], {
        maxDepartments: 8,
        maxRoles: 12,
        maxActiveRoles: 5,
        maxDepth: 2,
        maxConcurrentAssignments: 2,
        maxGoalRequests: 48,
        maxResearchChildren: 3,
        maxReportedCostUsd: 1,
      }),
    routedCompanyPolicy("balanced_v6", "Balanced", 3, 56, 3, 7,
      teamV4("balanced", 2, 1, 2, 1),
      ["local_compute", "included_subscription", "metered_api"], {
        maxDepartments: 10,
        maxRoles: 16,
        maxActiveRoles: 8,
        maxDepth: 2,
        maxConcurrentAssignments: 3,
        maxGoalRequests: 80,
        maxResearchChildren: 3,
        maxReportedCostUsd: 3,
      }),
    routedCompanyPolicy("performance_v6", "Performance", 4, 100, 10, 10,
      teamV4("thorough", 3, 2, 3, 1),
      ["local_compute", "included_subscription", "metered_api"], {
        maxDepartments: 12,
        maxRoles: 20,
        maxActiveRoles: 12,
        maxDepth: 3,
        maxConcurrentAssignments: 4,
        maxGoalRequests: 140,
        maxResearchChildren: 6,
        maxReportedCostUsd: 10,
      }),
    routedCompanyPolicy("max_v6", "Max", 6, 216, 25, 18,
      teamV4("maximum", 4, 2, 4, 2),
      ["local_compute", "included_subscription", "metered_api"], {
        maxDepartments: 16,
        maxRoles: 24,
        maxActiveRoles: 16,
        maxDepth: 3,
        maxConcurrentAssignments: 6,
        maxGoalRequests: 260,
        maxResearchChildren: 8,
        maxReportedCostUsd: 25,
      }),
  ]);

export const LEGACY_OPERATING_MODE_ID: OperatingModeId = "balanced_v1";
export const DEFAULT_OPERATING_MODE_ID: OperatingModeId = "balanced_v6";

const policiesById = new Map(
  operatingModePolicies.map((item) => [item.id, item] as const),
);

export function getOperatingModePolicy(id: OperatingModeId): OperatingModePolicy {
  const found = policiesById.get(id);
  if (found === undefined) {
    throw new TypeError(`Unknown operating mode: ${String(id)}`);
  }
  return found;
}

export function parseOperatingModeId(input: string): OperatingModeId | null {
  const normalized = input.trim().toLowerCase();
  const exact = policiesById.get(normalized as OperatingModeId);
  if (exact !== undefined) {
    return exact.id;
  }
  const defaultVersion = getOperatingModePolicy(DEFAULT_OPERATING_MODE_ID).version;
  for (const item of operatingModePolicies) {
    if (normalized === item.displayName.toLowerCase()) {
      if (item.version === defaultVersion) return item.id;
    }
  }
  return null;
}

const permissionRank: Readonly<Record<AgentPermissionMode, number>> = {
  ask_always: 0,
  approved_for_me: 1,
  full_access: 2,
};

export function narrowAgentPermissionMode(
  parent: AgentPermissionMode,
  requested: AgentPermissionMode,
): AgentPermissionMode {
  return permissionRank[requested] <= permissionRank[parent]
    ? requested
    : parent;
}

export interface AgentTask {
  readonly id: string;
  readonly description: string;
  readonly prompt: string;
}

export type AgentBackendSelection =
  | {
      readonly strategy: "session_pin";
      readonly adapterId: string;
      readonly connectionId: string;
      readonly modelId: string;
    }
  | {
      readonly strategy: "inherit_parent";
      readonly adapterId: string;
      readonly connectionId: string;
      readonly modelId: string;
    }
  | {
      readonly strategy: "policy_route";
      readonly candidateId: string;
      readonly reason: "eligible_role_candidate" | "parent_fallback";
      readonly adapterId: string;
      readonly connectionId: string;
      readonly modelId: string;
    };

export interface AgentTeamCorrelation {
  readonly runId: string;
  readonly role: "implement" | "review" | "repair";
  readonly taskIndex: number;
  readonly round: number;
  readonly attemptId: string;
}

export interface AgentGitWorktreeWorkspace {
  readonly kind: "git_worktree";
  readonly version: 1;
  readonly leaseId: string;
  readonly repositoryRoot: string;
  readonly worktreeRoot: string;
  readonly revision: string;
}

export interface AgentSessionDescriptor {
  readonly id: string;
  readonly role: "parent" | "child";
  readonly profile: {
    readonly id: AgentProfileId;
    readonly version: AgentProfileVersion;
  } | null;
  readonly parentAgentId: string | null;
  readonly parentSessionId: string | null;
  readonly depth: number;
  readonly task: AgentTask | null;
  readonly operatingMode: {
    readonly id: OperatingModeId;
    readonly version: OperatingModeVersion;
  };
  readonly backend: AgentBackendSelection;
  readonly permissions: {
    readonly parentExecutionMode: AgentExecutionMode;
    readonly executionMode: AgentExecutionMode;
    readonly parentPermissionMode: AgentPermissionMode;
    readonly permissionMode: AgentPermissionMode;
  };
  readonly limits: AgentLimits;
  readonly company?: CompanyBlueprintBinding;
  readonly workspace?: AgentGitWorktreeWorkspace;
  readonly team?: AgentTeamCorrelation;
}

export type AgentLifecycle =
  | { readonly status: "ready" }
  | { readonly status: "running"; readonly turnId: string }
  | { readonly status: "completed"; readonly turnId: string }
  | { readonly status: "failed"; readonly turnId: string | null; readonly failure: IntegrationFailure }
  | { readonly status: "cancelled"; readonly turnId: string | null; readonly reason: string };

export interface AgentResult {
  readonly finalText: string;
  readonly usage: ProviderUsage | null;
  readonly usageSource: "provider" | "runtime" | "unavailable";
  readonly steps: number | null;
  readonly changedFiles: readonly string[];
  readonly changedFilesSource:
    | "host_tools"
    | "runtime"
    | "mixed"
    | "workspace_diff"
    | "none";
  readonly evidence: readonly string[];
  readonly evidenceSource:
    | "host_tools"
    | "runtime"
    | "mixed"
    | "independent_verification"
    | "none";
}
