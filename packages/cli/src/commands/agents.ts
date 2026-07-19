import {
  agentProfilePolicies,
  getAgentProfilePolicy,
  getOperatingModePolicy,
  parseOperatingModeId,
  deriveTrustedRunContext,
  type AgentProfilePolicy,
} from "@recurs/contracts";
import {
  AgentActivityService,
  TEAM_APPLY_PERMISSION,
  createDelegationBudget,
  isPinnedSessionState,
  type AgentActivity,
  type SessionRecord,
  type TeamRunSnapshot,
} from "@recurs/core";
import { permissionIntentKey, ToolError, type ToolContext } from "@recurs/tools";

import {
  message,
  type Command,
  type CommandContext,
  type CommandDependencies,
  type CommandResult,
} from "./types.js";

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
        ...(team.maxRepairRounds === undefined
          ? []
          : [`Repair rounds: ${team.maxRepairRounds}`]),
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
    case "implement_v2":
      return "staged scoped edits; no repository process execution";
    case "review_v2":
      return "staged read-only review; no repository process execution";
    case "repair_v1":
      return "staged finding-only repairs; no repository process execution";
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
    "Team workflow: legacy execution uses version-3 policies; version-4 profiles are reserved for the durable team supervisor.",
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

function teamCost(snapshot: TeamRunSnapshot): string {
  if (snapshot.reportedCostUsd === null) {
    return `Cost: unavailable (${snapshot.costCoverage} coverage)`;
  }
  return `Cost: $${snapshot.reportedCostUsd.toFixed(4)} (${snapshot.costCoverage} coverage)`;
}

function teamLine(snapshot: TeamRunSnapshot): string {
  return [
    snapshot.status,
    snapshot.phase ?? "none",
    `round ${snapshot.round}`,
    `${snapshot.childrenFinished}/${snapshot.childrenReserved} children`,
    snapshot.id,
  ].join(" | ");
}

function teamDetail(snapshot: TeamRunSnapshot): string {
  const usage = snapshot.usage === null
    ? "Usage: unavailable"
    : `Usage: ${snapshot.usage.inputTokens} input, ${snapshot.usage.outputTokens} output tokens`;
  return [
    `Team run: ${snapshot.id}`,
    `Status: ${snapshot.status}`,
    `Execution: ${snapshot.execution}`,
    `Mode: ${snapshot.operatingModeId}`,
    `Phase: ${snapshot.phase ?? "none"}`,
    `Round: ${snapshot.round}`,
    `Children: ${snapshot.childrenFinished}/${snapshot.childrenReserved} finished`,
    usage,
    teamCost(snapshot),
    `Updated: ${snapshot.updatedAt}`,
    `Manual attention: ${snapshot.manualAttentionRequired ? "required" : "no"}`,
  ].join("\n");
}

function teamToolContext(
  context: CommandContext,
  signal: AbortSignal,
  explicitlyApproved: boolean,
): ToolContext {
  if (!isPinnedSessionState(context.session)) {
    throw new ToolError("tool_unavailable", "Team controls require a pinned session");
  }
  return {
    sessionId: context.session.id,
    cwd: context.session.cwd,
    signal,
    executionMode: context.session.executionMode,
    readRevisions: new Map(),
    runContext: deriveTrustedRunContext(context.invocation),
    delegationBudget: createDelegationBudget(context.session.agent),
    ...(explicitlyApproved
      ? { approvedIntents: new Set([permissionIntentKey(TEAM_APPLY_PERMISSION)]) }
      : {}),
  };
}

function controlError(error: unknown): CommandResult {
  if (error instanceof ToolError) {
    return error.code === "not_found"
      ? message("Team run not found", "error")
      : message(oneLine(error.message), "error");
  }
  throw error;
}

export function createAgentsCommand(
  dependencies: CommandDependencies = {},
): Command {
  const activity = dependencies.sessions === undefined
    ? null
    : new AgentActivityService(dependencies.sessions);
  return {
    name: "agents",
    aliases: ["agent"],
    description: "Inspect child-agent modes, activity, and durable team runs",
    usage: "/agents [profiles|activity [exact-id]|teams|team <id>|wait <id>|cancel <id>|resume <id>|apply <id>|mode economy|standard|balanced|performance|max]",
    async execute(args, context) {
      const trimmed = args.trim();
      if (trimmed.toLowerCase() === "profiles") {
        return message(profilesSummary());
      }
      if (!isPinnedSessionState(context.session)) {
        return message("Agent modes become available after a model connection creates a session", "warning");
      }
      const teamMatch = /^(teams|team|wait|cancel|resume|apply)(?:\s+(\S+))?$/iu
        .exec(trimmed);
      if (teamMatch !== null) {
        const controls = dependencies.teamRuns;
        if (controls === undefined) {
          return message("Durable team controls are unavailable", "error");
        }
        const action = teamMatch[1]!.toLowerCase();
        const exactId = teamMatch[2];
        if ((action === "teams") !== (exactId === undefined)) {
          return message(
            action === "teams"
              ? "Use /agents teams without an ID"
              : `Use /agents ${action} <exact-id>`,
            "error",
          );
        }
        try {
          if (action === "teams") {
            const runs = await controls.list(context.session.id);
            return runs.length === 0
              ? message("No durable team runs belong to this session")
              : message([
                  `${runs.length} durable team run${runs.length === 1 ? "" : "s"}:`,
                  ...runs.map(teamLine),
                ].join("\n"));
          }
          const id = exactId!;
          if (action === "team") {
            return message(teamDetail(await controls.status(context.session.id, id)));
          }
          if (action === "wait") {
            const waited = await controls.wait(
              context.session.id,
              id,
              30_000,
              dependencies.signal?.() ?? new AbortController().signal,
            );
            return message([
              teamDetail(waited.snapshot),
              `Timed out: ${waited.timedOut ? "yes" : "no"}`,
            ].join("\n"));
          }
          if (action === "cancel") {
            const cancelled = await controls.cancel(
              context.session.id,
              id,
              "Cancelled from the Recurs CLI",
            );
            return message([
              `Cancellation: ${cancelled.result}`,
              teamDetail(cancelled.snapshot),
            ].join("\n"));
          }
          const signal = dependencies.signal?.() ?? new AbortController().signal;
          if (action === "resume") {
            if (context.session.permissionMode !== "full_access") {
              return message("Resuming a background team requires Full Access", "error");
            }
            const resumed = await controls.resume(
              context.session.id,
              id,
              teamToolContext(context, signal, false),
            );
            return message([
              `Resume: ${resumed.result}`,
              teamDetail(resumed.snapshot),
            ].join("\n"));
          }
          const explicitlyApproved = context.session.permissionMode !== "full_access";
          if (explicitlyApproved && !await context.confirm(
            `Apply reviewed team candidate ${oneLine(id)} to the current workspace?`,
          )) {
            return message("Team apply was not approved", "warning");
          }
          const applied = await controls.apply(
            context.session.id,
            id,
            teamToolContext(context, signal, explicitlyApproved),
          );
          return message(applied.output);
        } catch (error) {
          return controlError(error);
        }
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
          "Choose /agents mode economy, standard, balanced, performance, or max; use /agents profiles, /agents activity, or /agents teams",
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
