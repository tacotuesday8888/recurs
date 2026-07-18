import type { IntegrationFailure } from "./failures.js";
import type { ProviderUsage } from "./model.js";

export type AgentPermissionMode =
  | "ask_always"
  | "approved_for_me"
  | "full_access";

export type AgentExecutionMode = "act" | "plan";

export type AgentProfileId =
  | "explore_v1"
  | "implement_v1"
  | "review_v1";

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
  readonly version: 1;
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
  displayName: string,
  executionMode: AgentExecutionMode,
  readOnly: boolean,
  allowedNames: readonly string[],
  allowedCategories: readonly AgentToolPermissionCategory[],
  maxRisk: AgentToolPermissionRisk,
): AgentProfilePolicy {
  return Object.freeze({
    id,
    version: 1 as const,
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
    "Explore",
    "plan",
    true,
    ["read_file", "list_files", "search_text", "git_status", "git_diff"],
    ["read"],
    "normal",
  ),
  profile(
    "implement_v1",
    "Implement",
    "act",
    false,
    [
      "read_file", "list_files", "search_text", "apply_patch",
      "run_command", "run_verification", "git_status", "git_diff",
    ],
    ["read", "write", "shell"],
    "elevated",
  ),
  profile(
    "review_v1",
    "Review",
    "act",
    true,
    ["read_file", "list_files", "search_text", "git_status", "git_diff"],
    ["read"],
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
  for (const item of agentProfilePolicies) {
    if (
      normalized === item.id ||
      normalized === item.displayName.toLowerCase()
    ) {
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
  | "max_v3";

export type OperatingModeVersion = 1 | 2 | 3;

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
  readonly approvalRule: "unanimous";
}

export interface AgentLimits {
  readonly maxDepth: number;
  readonly maxConcurrentChildren: number;
  readonly maxRetries: number;
  readonly maxRequests: number;
  readonly maxReportedCostUsd: number;
}

export interface OperatingModePolicy {
  readonly id: OperatingModeId;
  readonly version: OperatingModeVersion;
  readonly displayName: string;
  readonly model: {
    readonly selection: "inherit_parent";
  };
  readonly orchestration: AgentLimits;
  readonly workflow: {
    readonly maxChildrenPerRun: number;
    readonly maxRequestsPerRun: number;
    readonly team: AgentTeamPolicy | null;
  };
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
  ]);

export const LEGACY_OPERATING_MODE_ID: OperatingModeId = "balanced_v1";
export const DEFAULT_OPERATING_MODE_ID: OperatingModeId = "balanced_v3";

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
  const newestFirst = [...operatingModePolicies].reverse();
  for (const item of newestFirst) {
    if (normalized === item.displayName.toLowerCase()) {
      return item.id;
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

export interface AgentBackendSelection {
  readonly strategy: "session_pin" | "inherit_parent";
  readonly adapterId: string;
  readonly connectionId: string;
  readonly modelId: string;
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
    readonly version: 1;
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
  readonly workspace?: AgentGitWorktreeWorkspace;
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
  readonly evidence: readonly string[];
}
