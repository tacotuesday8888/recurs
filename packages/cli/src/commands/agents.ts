import {
  agentProfilePolicies,
  getOperatingModePolicy,
  parseOperatingModeId,
  type AgentProfilePolicy,
} from "@recurs/contracts";
import {
  isPinnedSessionState,
  type SessionRecord,
} from "@recurs/core";

import { message, type Command } from "./types.js";

function summary(id: Parameters<typeof getOperatingModePolicy>[0]): string {
  const policy = getOperatingModePolicy(id);
  return [
    `Agent mode: ${policy.displayName} (${policy.id})`,
    "Model policy: inherit the session's pinned backend",
    `Limits: depth ${policy.orchestration.maxDepth}, concurrency ${policy.orchestration.maxConcurrentChildren}, retries ${policy.orchestration.maxRetries}, child requests ${policy.orchestration.maxRequests}`,
    `Children per parent run: ${policy.workflow.maxChildrenPerRun} (foreground, sequential)`,
    `Reported cost ceiling: $${policy.orchestration.maxReportedCostUsd.toFixed(2)} (flagged after telemetry; child requests are the pre-run bound)`,
  ].join("\n");
}

function workspaceEffects(profile: AgentProfilePolicy): string {
  switch (profile.id) {
    case "explore_v1":
      return "read-only inspection";
    case "implement_v1":
      return "scoped edits and verification";
    case "review_v1":
      return "no source edits; verification may create artifacts";
  }
}

function profilesSummary(): string {
  return [
    "Agent profiles (stable IDs; display names may change):",
    ...agentProfilePolicies.flatMap((profile) => [
      `${profile.displayName} (${profile.id}, v${profile.version})`,
      `  Execution: ${profile.executionMode === "act" ? "Act parent required" : "Plan or Act parent"}; ${workspaceEffects(profile)}`,
      `  Host tools: ${profile.tools.allowedNames.join(", ")}`,
      `  Intent ceiling: ${profile.tools.allowedCategories.join("/")} at ${profile.tools.maxRisk} risk`,
    ]),
  ].join("\n");
}

export function createAgentsCommand(): Command {
  return {
    name: "agents",
    aliases: ["agent"],
    description: "Inspect or change the bounded child-agent operating mode",
    usage: "/agents [profiles|mode economy|standard|balanced|performance|max]",
    async execute(args, context) {
      const trimmed = args.trim();
      if (trimmed.toLowerCase() === "profiles") {
        return message(profilesSummary());
      }
      if (!isPinnedSessionState(context.session)) {
        return message("Agent modes become available after a model connection creates a session", "warning");
      }
      if (trimmed.length === 0) {
        return message(summary(context.session.agent.operatingMode.id));
      }
      const match = /^mode\s+(\S+)$/iu.exec(trimmed);
      const id = match?.[1] === undefined ? null : parseOperatingModeId(match[1]);
      if (id === null) {
        return message(
          "Choose /agents mode economy, standard, balanced, performance, or max; or use /agents profiles",
          "error",
        );
      }
      const policy = getOperatingModePolicy(id);
      const record: SessionRecord = {
        version: 1,
        type: "agent_policy_updated",
        sessionId: context.session.id,
        at: context.now(),
        operatingModeId: policy.id,
        operatingModeVersion: policy.version,
      };
      await context.applyRecord(record);
      return message(summary(policy.id));
    },
  };
}
