import {
  agentProfilePolicies,
  getAgentProfilePolicy,
  getOperatingModePolicy,
  parseOperatingModeId,
  type AgentProfilePolicy,
} from "@recurs/contracts";
import {
  AgentActivityService,
  isPinnedSessionState,
  type AgentActivity,
  type JsonlSessionStore,
  type SessionRecord,
} from "@recurs/core";

import { message, type Command } from "./types.js";

function summary(id: Parameters<typeof getOperatingModePolicy>[0]): string {
  const policy = getOperatingModePolicy(id);
  const childRequests = Math.floor(
    policy.workflow.maxRequestsPerRun / policy.workflow.maxChildrenPerRun,
  );
  const concurrency = policy.orchestration.maxConcurrentChildren;
  const team = policy.workflow.team;
  const teamSummary = team === null
    ? [
        "Team workflow: unavailable for this historical policy",
        "Implement remains single-child only through delegate_task",
      ]
    : [
        `Team: up to ${team.maxImplementers} Implement worker${team.maxImplementers === 1 ? "" : "s"}, ${team.initialReviewers} initial and ${team.maxReviewers} maximum Review worker${team.maxReviewers === 1 ? "" : "s"}`,
        `Review rule: ${team.approvalRule}, ${team.qualityStandard} quality standard`,
      ];
  return [
    `Agent mode: ${policy.displayName} (${policy.id})`,
    `Policy version: ${policy.version}`,
    "Model policy: inherit the session's pinned backend",
    `Orchestration: depth ${policy.orchestration.maxDepth}, concurrency ${concurrency}${concurrency === 1 ? " (sequential fallback)" : ""}, retries ${policy.orchestration.maxRetries}`,
    `Workflow: ${policy.workflow.maxChildrenPerRun} children, ${policy.workflow.maxRequestsPerRun} total requests, ${childRequests} reserved per child`,
    "Batch profiles: Explore and Review in isolated clean Git worktrees",
    ...teamSummary,
    `Reported cost ceiling: $${policy.orchestration.maxReportedCostUsd.toFixed(2)} (enforced for new work after provider telemetry is known)`,
  ].join("\n");
}

function workspaceEffects(profile: AgentProfilePolicy): string {
  switch (profile.id) {
    case "explore_v1":
      return "read-only inspection";
    case "implement_v1":
      return "scoped edits and verification";
    case "review_v1":
      return "read-only diff/file and Implement-evidence inspection; no repository execution or verification artifacts";
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
    "Batch eligibility: Explore and Review through delegate_tasks.",
    "Team workflow: Implement workers in isolated worktrees under version-3 policies.",
  ].join("\n");
}

function oneLine(value: string, maxLength = 160): string {
  const printable = [...value].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)
      ? " "
      : character;
  }).join("");
  const normalized = printable
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`;
}

function activityList(items: readonly AgentActivity[]): string {
  if (items.length === 0) {
    return "No child agents belong to this session";
  }
  return [
    `${items.length} child agent${items.length === 1 ? "" : "s"}:`,
    ...items.map((item) => {
      const profile = getAgentProfilePolicy(item.profileId);
      return [
        item.status,
        profile.displayName,
        oneLine(item.description),
        item.childSessionId,
      ].join(" | ");
    }),
  ].join("\n");
}

function usageLine(activity: AgentActivity): string {
  const usage = activity.usage;
  if (usage === null) return "Usage: unavailable";
  const cost = usage.costUsd === undefined
    ? ""
    : `, $${usage.costUsd.toFixed(4)}`;
  return `Usage: ${usage.inputTokens} input, ${usage.outputTokens} output tokens${cost}`;
}

function activityDetail(activity: AgentActivity): string {
  const profile = getAgentProfilePolicy(activity.profileId);
  const files = activity.changedFiles.length === 0
    ? "none"
    : activity.changedFiles.map((file) => oneLine(file)).join(", ");
  const evidence = activity.evidence.length === 0
    ? "none"
    : activity.evidence.map((item) => oneLine(item)).join("; ");
  return [
    `Agent: ${oneLine(activity.description)}`,
    `Status: ${activity.status}`,
    `Profile: ${profile.displayName} (${activity.profileId})`,
    `Child agent ID: ${activity.childAgentId}`,
    `Child session ID: ${activity.childSessionId}`,
    `Updated: ${activity.updatedAt}`,
    usageLine(activity),
    `Changed files: ${files}`,
    `Evidence: ${evidence}`,
    activity.failure === null
      ? "Failure: none"
      : `Failure: ${oneLine(activity.failure.code)} — ${oneLine(activity.failure.message)}`,
    activity.isolation === null
      ? "Isolation: parent workspace"
      : `Isolation: Git worktree at ${activity.isolation.revision.slice(0, 12)}`,
  ].join("\n");
}

export function createAgentsCommand(sessions?: JsonlSessionStore): Command {
  const activity = sessions === undefined
    ? null
    : new AgentActivityService(sessions);
  return {
    name: "agents",
    aliases: ["agent"],
    description: "Inspect or change the bounded child-agent operating mode",
    usage: "/agents [profiles|activity [exact-id]|mode economy|standard|balanced|performance|max]",
    async execute(args, context) {
      const trimmed = args.trim();
      if (trimmed.toLowerCase() === "profiles") {
        return message(profilesSummary());
      }
      if (!isPinnedSessionState(context.session)) {
        return message("Agent modes become available after a model connection creates a session", "warning");
      }
      const activityMatch = /^activity(?:\s+(\S+))?$/iu.exec(trimmed);
      if (activityMatch !== null) {
        if (activity === null) {
          return message("Durable agent activity is unavailable", "error");
        }
        const exactId = activityMatch[1];
        if (exactId === undefined) {
          return message(activityList(await activity.list(context.session.id)));
        }
        const found = await activity.find(context.session.id, exactId);
        return found === null
          ? message(`Child agent not found: ${oneLine(exactId)}`, "error")
          : message(activityDetail(found));
      }
      if (trimmed.length === 0) {
        return message(summary(context.session.agent.operatingMode.id));
      }
      const match = /^mode\s+(\S+)$/iu.exec(trimmed);
      const id = match?.[1] === undefined ? null : parseOperatingModeId(match[1]);
      if (id === null) {
        return message(
          "Choose /agents mode economy, standard, balanced, performance, or max; use /agents profiles; or use /agents activity",
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
