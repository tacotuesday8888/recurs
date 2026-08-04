import { createHash } from "node:crypto";
import path from "node:path";

import {
  type PermissionCategory,
  type PermissionDecision,
  type PermissionRisk,
  type PermissionRule,
} from "@recurs/tools";

import {
  PrivateUserConfigurationError,
  readPrivateUserConfiguration,
} from "./private-user-config.js";

const CONFIG_FILE = "permissions.json";
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_WORKSPACES = 32;
const MAX_RULES_PER_WORKSPACE = 128;
const MAX_TEXT_BYTES = 8 * 1024;
const RULE_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const DECISIONS = new Set<PermissionDecision>(["allow", "ask", "deny"]);
const CATEGORIES = new Set<PermissionCategory>([
  "read",
  "write",
  "shell",
  "network",
  "external_path",
  "sensitive",
  "deploy",
]);
const RISKS = new Set<PermissionRisk>(["normal", "elevated", "destructive"]);

interface WorkspacePermissionRules {
  readonly workspace: string;
  readonly rules: readonly PermissionRule[];
}

interface PermissionRuleConfiguration {
  readonly version: 1;
  readonly workspaces: readonly WorkspacePermissionRules[];
}

export interface PermissionRuleStatus {
  readonly version: 1;
  readonly type: "permission_rules";
  readonly configured: boolean;
  readonly configFile: "$RECURS_HOME/config/permissions.json";
  readonly rules: readonly {
    readonly id: string;
    readonly decision: PermissionDecision;
    readonly category: PermissionCategory;
    readonly risk: PermissionRisk;
    readonly resourceSha256: string;
  }[];
}

export class PermissionRuleConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermissionRuleConfigurationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    !value.includes("\0") && Buffer.byteLength(value, "utf8") <= MAX_TEXT_BYTES;
}

function parseRule(value: unknown): PermissionRule {
  if (!isRecord(value) || !exactKeys(value, [
    "id",
    "decision",
    "category",
    "resource",
    "risk",
  ])) {
    throw new PermissionRuleConfigurationError("Each permission rule must use the supported fields");
  }
  if (typeof value.id !== "string" || !RULE_ID.test(value.id)) {
    throw new PermissionRuleConfigurationError("Each permission rule needs a stable lowercase id");
  }
  if (typeof value.decision !== "string" || !DECISIONS.has(value.decision as PermissionDecision)) {
    throw new PermissionRuleConfigurationError("Each permission rule needs a supported decision");
  }
  if (typeof value.category !== "string" || !CATEGORIES.has(value.category as PermissionCategory)) {
    throw new PermissionRuleConfigurationError("Credential rules are forbidden and every rule needs a supported category");
  }
  if (typeof value.risk !== "string" || !RISKS.has(value.risk as PermissionRisk)) {
    throw new PermissionRuleConfigurationError("Each permission rule needs a supported risk");
  }
  if (!boundedText(value.resource)) {
    throw new PermissionRuleConfigurationError("Each permission rule needs one bounded exact resource");
  }
  if (value.decision === "allow" && value.risk === "destructive") {
    throw new PermissionRuleConfigurationError(
      "Destructive permission intents cannot be persistently allowed",
    );
  }
  return Object.freeze({
    id: value.id,
    decision: value.decision as PermissionDecision,
    intent: Object.freeze({
      category: value.category as PermissionCategory,
      resource: value.resource,
      risk: value.risk as PermissionRisk,
    }),
  });
}

function parseWorkspace(value: unknown): WorkspacePermissionRules {
  if (
    !isRecord(value) || !exactKeys(value, ["workspace", "rules"]) ||
    !boundedText(value.workspace) || !path.isAbsolute(value.workspace) ||
    path.resolve(value.workspace) !== value.workspace ||
    !Array.isArray(value.rules) || value.rules.length > MAX_RULES_PER_WORKSPACE
  ) {
    throw new PermissionRuleConfigurationError(
      `Each workspace needs one canonical absolute path and at most ${MAX_RULES_PER_WORKSPACE} rules`,
    );
  }
  const rules = value.rules.map(parseRule);
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) {
    throw new PermissionRuleConfigurationError("Permission rule ids must be unique per workspace");
  }
  const exactIntents = rules.map((rule) =>
    `${rule.intent.category}\0${rule.intent.resource}\0${rule.intent.risk}`
  );
  if (new Set(exactIntents).size !== exactIntents.length) {
    throw new PermissionRuleConfigurationError(
      "Only one decision may exist for an exact permission intent",
    );
  }
  return Object.freeze({
    workspace: value.workspace,
    rules: Object.freeze(rules),
  });
}

function parseConfiguration(value: unknown): PermissionRuleConfiguration {
  if (
    !isRecord(value) || !exactKeys(value, ["version", "workspaces"]) ||
    value.version !== 1 || !Array.isArray(value.workspaces) ||
    value.workspaces.length > MAX_WORKSPACES
  ) {
    throw new PermissionRuleConfigurationError(
      `Permission rule configuration must be version 1 with at most ${MAX_WORKSPACES} workspaces`,
    );
  }
  const workspaces = value.workspaces.map(parseWorkspace);
  if (new Set(workspaces.map((entry) => entry.workspace)).size !== workspaces.length) {
    throw new PermissionRuleConfigurationError("Configured workspace paths must be unique");
  }
  return Object.freeze({ version: 1, workspaces: Object.freeze(workspaces) });
}

async function loadConfiguration(dataDirectory: string): Promise<PermissionRuleConfiguration> {
  let contents: string | null;
  try {
    contents = await readPrivateUserConfiguration({
      dataDirectory,
      filename: CONFIG_FILE,
      label: "Permission rule configuration",
      maximumBytes: MAX_CONFIG_BYTES,
    });
  } catch (error) {
    if (error instanceof PrivateUserConfigurationError) {
      throw new PermissionRuleConfigurationError(error.message, { cause: error });
    }
    throw error;
  }
  if (contents === null) {
    return Object.freeze({ version: 1, workspaces: Object.freeze([]) });
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new PermissionRuleConfigurationError(
      "Permission rule configuration is not valid JSON",
      { cause: error },
    );
  }
  return parseConfiguration(value);
}

export async function loadWorkspacePermissionRules(
  dataDirectory: string,
  workspace: string,
): Promise<readonly PermissionRule[]> {
  const configuration = await loadConfiguration(dataDirectory);
  return configuration.workspaces.find((entry) => entry.workspace === workspace)?.rules ??
    Object.freeze([]);
}

export async function inspectPermissionRules(
  dataDirectory: string,
  workspace: string,
): Promise<PermissionRuleStatus> {
  const rules = await loadWorkspacePermissionRules(dataDirectory, workspace);
  return Object.freeze({
    version: 1,
    type: "permission_rules",
    configured: rules.length > 0,
    configFile: "$RECURS_HOME/config/permissions.json",
    rules: Object.freeze(rules.map((rule) => Object.freeze({
      id: rule.id,
      decision: rule.decision,
      category: rule.intent.category,
      risk: rule.intent.risk,
      resourceSha256: createHash("sha256")
        .update(rule.intent.resource)
        .digest("hex"),
    }))),
  });
}

export function renderPermissionRuleStatus(status: PermissionRuleStatus): string {
  if (!status.configured) {
    return `Workspace permission rules: none\nConfig: ${status.configFile}`;
  }
  return [
    `Workspace permission rules: ${status.rules.length}`,
    ...status.rules.map((rule) =>
      `${rule.id} · ${rule.decision} · ${rule.category} · ${rule.risk} · sha256:${rule.resourceSha256.slice(0, 12)}`
    ),
    `Config: ${status.configFile}`,
    "Matching: exact workspace + category + resource + risk",
  ].join("\n");
}
