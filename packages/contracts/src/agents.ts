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
    false,
    [
      "read_file", "list_files", "search_text", "run_verification",
      "git_status", "git_diff",
    ],
    ["read", "shell"],
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
  | "max_v1";

export interface AgentLimits {
  readonly maxDepth: number;
  readonly maxConcurrentChildren: number;
  readonly maxRetries: number;
  readonly maxRequests: number;
  readonly maxReportedCostUsd: number;
}

export interface OperatingModePolicy {
  readonly id: OperatingModeId;
  readonly version: 1;
  readonly displayName: string;
  readonly model: {
    readonly selection: "inherit_parent";
  };
  readonly orchestration: AgentLimits;
  readonly workflow: {
    readonly maxChildrenPerRun: number;
  };
}

function policy(
  id: OperatingModeId,
  displayName: string,
  maxRequests: number,
  maxReportedCostUsd: number,
  maxChildrenPerRun: number,
): OperatingModePolicy {
  return Object.freeze({
    id,
    version: 1 as const,
    displayName,
    model: Object.freeze({ selection: "inherit_parent" as const }),
    orchestration: Object.freeze({
      maxDepth: 1,
      maxConcurrentChildren: 1,
      maxRetries: 0,
      maxRequests,
      maxReportedCostUsd,
    }),
    workflow: Object.freeze({ maxChildrenPerRun }),
  });
}

export const operatingModePolicies: readonly OperatingModePolicy[] =
  Object.freeze([
    policy("economy_v1", "Economy", 8, 0.25, 2),
    policy("standard_v1", "Standard", 16, 1, 3),
    policy("balanced_v1", "Balanced", 24, 3, 4),
    policy("performance_v1", "Performance", 32, 10, 6),
    policy("max_v1", "Max", 40, 25, 8),
  ]);

export const DEFAULT_OPERATING_MODE_ID: OperatingModeId = "balanced_v1";

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
  for (const item of operatingModePolicies) {
    if (
      normalized === item.id ||
      normalized === item.displayName.toLowerCase()
    ) {
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
    readonly version: 1;
  };
  readonly backend: AgentBackendSelection;
  readonly permissions: {
    readonly parentExecutionMode: AgentExecutionMode;
    readonly executionMode: AgentExecutionMode;
    readonly parentPermissionMode: AgentPermissionMode;
    readonly permissionMode: AgentPermissionMode;
  };
  readonly limits: AgentLimits;
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
