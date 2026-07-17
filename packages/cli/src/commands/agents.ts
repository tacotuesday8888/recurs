import {
  getOperatingModePolicy,
  parseOperatingModeId,
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
    `Limits: depth ${policy.orchestration.maxDepth}, concurrency ${policy.orchestration.maxConcurrentChildren}, retries ${policy.orchestration.maxRetries}, requests ${policy.orchestration.maxRequests}`,
    `Reported cost ceiling: $${policy.orchestration.maxReportedCostUsd.toFixed(2)} (flagged after telemetry; request limits are the pre-run bound)`,
  ].join("\n");
}

export function createAgentsCommand(): Command {
  return {
    name: "agents",
    aliases: ["agent"],
    description: "Inspect or change the bounded child-agent operating mode",
    usage: "/agents [mode economy|standard|balanced|performance|max]",
    async execute(args, context) {
      if (!isPinnedSessionState(context.session)) {
        return message("Agent modes become available after a model connection creates a session", "warning");
      }
      const trimmed = args.trim();
      if (trimmed.length === 0) {
        return message(summary(context.session.agent.operatingMode.id));
      }
      const match = /^mode\s+(\S+)$/iu.exec(trimmed);
      const id = match?.[1] === undefined ? null : parseOperatingModeId(match[1]);
      if (id === null) {
        return message(
          "Choose /agents mode economy, standard, balanced, performance, or max",
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
