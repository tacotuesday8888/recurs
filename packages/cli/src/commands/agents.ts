import {
  agentProfilePolicies,
  getAgentProfilePolicy,
  getOperatingModePolicy,
  parseOperatingModeId,
  deriveTrustedRunContext,
  type AgentProfilePolicy,
  type CompanyBlueprintV2,
  type TeamControlPolicyV1,
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
import type { TeamControlChanges, TeamControlSnapshot } from "../team-control-service.js";

function summary(id: Parameters<typeof getOperatingModePolicy>[0]): string {
  const policy = getOperatingModePolicy(id);
  const childRequests = Math.floor(
    policy.workflow.maxRequestsPerRun / policy.workflow.maxChildrenPerRun,
  );
  const concurrency = policy.orchestration.maxConcurrentChildren;
  const modelSummary = policy.model.selection === "inherit_parent"
    ? "Model policy: inherit the session's pinned backend"
    : `Model policy: explicit saved role candidates (${policy.model.eligibleBillingSources.join(", ")}); inherit the parent when ineligible or unavailable`;
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
    modelSummary,
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
    "Team workflow: legacy execution uses version-3 policies; version-4-or-newer policies use the durable team supervisor.",
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

function controlValues(policy: TeamControlPolicyV1): string {
  return [
    policy.topology,
    `${policy.maxActiveAgents} active`,
    `${policy.maxConcurrentAgents} concurrent`,
    `depth ${policy.maxDelegationDepth}`,
    policy.escalation.replace("_", " "),
    `independent review ${policy.independentReview.replace("_", " ")}`,
    `${policy.maxRepairRounds} repair round${policy.maxRepairRounds === 1 ? "" : "s"}`,
    `${policy.maxRequests} requests`,
    `$${policy.maxReportedCostUsd.toFixed(2)} reported cost`,
  ].join(" · ");
}

function renderControls(snapshot: TeamControlSnapshot): string {
  const lines = [
    `Team controls: ${snapshot.source}${
      snapshot.compatible ? "" : " (incompatible with the current mode)"
    }`,
    `Selected: ${controlValues(snapshot.selected)}`,
    `Hard ceiling: ${controlValues(snapshot.hardCeiling)}`,
  ];
  if (snapshot.effective !== null) {
    lines.push(`Effective: ${controlValues({
      ...snapshot.selected,
      ...snapshot.effective,
      revision: snapshot.effective.sourceRevision,
    })}`);
  } else {
    lines.push(snapshot.compatible
      ? "Effective: available after an approved company is active"
      : "Effective: blocked until controls are reset or explicitly reconfigured");
  }
  return lines.join("\n");
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return Number(value);
}

function parseNonNegativeInteger(value: string, label: string): number {
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function parseControlChanges(value: string): TeamControlChanges {
  const tokens = value.trim().split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) {
    throw new TypeError(
      "Use /agents configure key=value with topology, active, concurrent, depth, escalation, review, repair, requests, or cost",
    );
  }
  const changes: Record<string, unknown> = {};
  for (const token of tokens) {
    const match = /^([a-z]+)=(\S+)$/u.exec(token);
    if (match === null || Object.hasOwn(changes, match[1]!)) {
      throw new TypeError(`Invalid or repeated team-control setting: ${oneLine(token)}`);
    }
    const key = match[1]!;
    const raw = match[2]!;
    switch (key) {
      case "topology":
        if (!new Set([
          "recommended", "focused", "parallel", "hierarchical",
          "research_heavy", "review_heavy",
        ]).has(raw)) throw new TypeError("Unknown team topology");
        changes.topology = raw;
        break;
      case "active":
        changes.maxActiveAgents = parsePositiveInteger(raw, "Active agents");
        break;
      case "concurrent":
        changes.maxConcurrentAgents = parsePositiveInteger(raw, "Concurrency");
        break;
      case "depth":
        changes.maxDelegationDepth = parsePositiveInteger(raw, "Delegation depth");
        break;
      case "escalation":
        if (raw !== "manager_only" && raw !== "root_allowed") {
          throw new TypeError("Escalation must be manager_only or root_allowed");
        }
        changes.escalation = raw;
        break;
      case "review":
        if (raw !== "required" && raw !== "when_planned") {
          throw new TypeError("Review must be required or when_planned");
        }
        changes.independentReview = raw;
        break;
      case "repair":
        changes.maxRepairRounds = parseNonNegativeInteger(raw, "Repair rounds");
        break;
      case "requests":
        changes.maxRequests = parsePositiveInteger(raw, "Requests");
        break;
      case "cost": {
        const cost = Number(raw);
        if (!Number.isFinite(cost) || cost <= 0) {
          throw new TypeError("Reported cost must be a positive number");
        }
        changes.maxReportedCostUsd = cost;
        break;
      }
      default:
        throw new TypeError(`Unknown team-control setting: ${key}`);
    }
  }
  return changes as TeamControlChanges;
}

function localManual(context: CommandContext): boolean {
  const invocation = deriveTrustedRunContext(context.invocation);
  return invocation.invocation === "repl" && invocation.presence === "present" &&
    invocation.location === "local" && invocation.automation === "manual" &&
    invocation.embedding === "cli";
}

async function activeBlueprint(
  dependencies: CommandDependencies,
  context: CommandContext,
  signal: AbortSignal,
): Promise<CompanyBlueprintV2 | null> {
  const binding = isPinnedSessionState(context.session)
    ? context.session.agent.company
    : undefined;
  if (binding?.blueprintVersion !== 2 || dependencies.company === undefined) {
    return null;
  }
  const blueprint = await dependencies.company.blueprints.load(
    binding.blueprintId,
    signal,
  );
  return blueprint.state === "approved" &&
      blueprint.revision === binding.blueprintRevision
    ? blueprint
    : null;
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
    usage: "/agents [profiles|controls|configure key=value...|reset|activity [exact-id]|teams|team <id>|wait <id>|cancel <id>|resume <id>|apply <id>|mode economy|standard|balanced|performance|max]",
    async execute(args, context) {
      const trimmed = args.trim();
      if (trimmed.toLowerCase() === "profiles") {
        return message(profilesSummary());
      }
      if (!isPinnedSessionState(context.session)) {
        return message("Agent modes become available after a model connection creates a session", "warning");
      }
      if (trimmed.toLowerCase() === "controls" ||
        trimmed.toLowerCase() === "reset" ||
        /^configure(?:\s|$)/iu.test(trimmed)) {
        const service = dependencies.teamControls;
        if (service === undefined) {
          return message("Project team controls are unavailable", "error");
        }
        const signal = dependencies.signal?.() ?? new AbortController().signal;
        try {
          if (trimmed.toLowerCase() === "controls") {
            return message(renderControls(await service.inspect({
              workspace: context.session.cwd,
              operatingModeId: context.session.agent.operatingMode.id,
              blueprint: await activeBlueprint(dependencies, context, signal),
              signal,
            })));
          }
          if (!localManual(context)) {
            return message(
              "Changing team controls requires a local, user-present, manual terminal",
              "error",
            );
          }
          if (trimmed.toLowerCase() === "reset") {
            if (!await context.confirm(
              "Reset this project to the recommended team controls for the current mode?",
            )) {
              return message("Team-control reset was not approved", "warning");
            }
            const policy = await service.reset(
              context.session.cwd,
              context.session.agent.operatingMode.id,
              signal,
            );
            return message(
              `Saved recommended team controls at revision ${policy.revision}\nSelected: ${controlValues(policy)}`,
            );
          }
          const changes = parseControlChanges(
            trimmed.replace(/^configure(?:\s+|$)/iu, ""),
          );
          if (!await context.confirm(
            `Save project team controls: ${JSON.stringify(changes)}?`,
          )) {
            return message("Team-control changes were not approved", "warning");
          }
          const policy = await service.configure({
            workspace: context.session.cwd,
            operatingModeId: context.session.agent.operatingMode.id,
            changes,
            signal,
          });
          return message(
            `Saved team controls at revision ${policy.revision}\nSelected: ${controlValues(policy)}`,
          );
        } catch (error) {
          return message(
            error instanceof Error
              ? oneLine(error.message, 500)
              : "Team controls could not be updated",
            "error",
          );
        }
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
          "Choose /agents mode economy, standard, balanced, performance, or max; use /agents profiles, /agents controls, /agents activity, or /agents teams",
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
