import { getOperatingModePolicy } from "@recurs/contracts";
import { isPinnedSessionState } from "@recurs/core";

import { permissionLabel } from "./permissions.js";
import type { Command } from "./types.js";
import { message } from "./types.js";

const helpText = [
  "/help                         Show this command list",
  "/provider [search]            Discover, detect, and connect providers",
  "/connect                      Alias for /provider",
  "/model [connection-id]        Choose a model",
  "/effort [level]               Choose thinking effort (F4)",
  "/files [glob]                 Find and open a file",
  "/goal [objective|action]      Manage or launch the durable goal",
  "/company status               Inspect the approved company status",
  "/company operations           Inspect durable company goal operations",
  "/company run <run-id>         Inspect one exact company goal run",
  "/company resume <run-id>      Resume one exact interrupted company goal",
  "/plan [prompt|exit]           Enter read-only Plan mode or return to Act",
  "/permissions [mode]           Set Ask Always, Approved for Me, or Full Access",
  "/agents [profiles|mode name]  Inspect profiles or set bounded child-agent policy",
  "/skills [action]              Inspect Agent Skills or trust project skills",
  "/mcp                          Inspect MCP servers and project trust",
  "/status, /usage               Show session, context, and reported usage",
  "/workspace                    Branch, changes, worktrees, and Git actions",
  "/source <path>                Read a source file with syntax coloring",
  "/chats [archived|all]          Find saved chats",
  "/rename <title>               Name the current chat",
  "/pin, /unpin [session-id]      Pin or unpin a chat",
  "/archive, /unarchive [id]      Archive or restore a chat",
  "/copy [session-id]            Copy completed conversation context",
  "/init                         Create AGENTS.md without overwriting it",
  "/new                          Start a new durable session",
  "/fork                         Fork completed context into a new session",
  "/resume [session-id]          List sessions or resume an exact id",
  "/compact                      Summarize earlier context safely",
  "/export [path]                Save the conversation as Markdown",
  "/diff [scope] [path]           Review changes; /diff opens views",
  "/review                       Review changes with read-only tools",
  "/undo                         Restore the latest safe checkpoint",
  "/cancel                       Cancel the active agent run",
  "/queue [prompt|resume|clear]  Queue or recover separate follow-up turns",
  "/process [id [action]]        Inspect, attach, or control an owned process",
  "/quit, /exit, /q              Exit Recurs",
].join("\n");

function createHelpCommand(): Command {
  return {
    name: "help",
    description: "List available commands",
    usage: "/help",
    async execute() {
      return message(helpText);
    },
  };
}

function createStatusCommand(): Command {
  return {
    name: "status",
    aliases: ["usage"],
    description: "Show current session state",
    usage: "/status",
    async execute(_args, context) {
      const goal = context.session.goal === null
        ? "None"
        : `${context.session.goal.status}: ${context.session.goal.objective}`;
      const backend = context.session.backend.type === "pinned" &&
          context.session.backend.pin.kind === "agent_runtime"
        ? `Runtime: ${context.session.backend.pin.adapterId === "codex-acp"
          ? "Codex (Plan-only)"
          : context.session.backend.pin.adapterId === "codex-app-server"
            ? "Codex (Recurs tools)"
            : "Delegated agent"}`
        : null;
      const agentMode = isPinnedSessionState(context.session)
        ? getOperatingModePolicy(context.session.agent.operatingMode.id).displayName
        : "Unavailable";
      const modelLimits = context.session.backend.type === "pinned"
        ? context.session.backend.pin.modelLimitsAtCreation
        : undefined;
      const usageDetail = [
        context.session.usage.cachedInputTokens === undefined
          ? null
          : `${context.session.usage.cachedInputTokens} cached input`,
        context.session.usage.cacheWriteInputTokens === undefined
          ? null
          : `${context.session.usage.cacheWriteInputTokens} cache-write input`,
        context.session.usage.reasoningTokens === undefined
          ? null
          : `${context.session.usage.reasoningTokens} reasoning`,
      ].filter((value): value is string => value !== null);
      return message(
        [
          "SESSION",
          `Session: ${context.session.id}`,
          ...(context.session.forkedFrom === null ? [] : [
            `Forked from: ${context.session.forkedFrom.sessionId} at sequence ${context.session.forkedFrom.sequence}`,
          ]),
          `Workspace: ${context.session.cwd}`,
          `Model: ${context.session.model}`,
          `Reasoning effort: ${context.session.backend.type === "pinned"
            ? context.session.backend.pin.reasoningEffortAtCreation ??
              "provider default"
            : "provider default"}`,
          "",
          "AGENT",
          `Execution: ${context.session.executionMode === "plan" ? "Plan" : "Act"}`,
          `Permissions: ${permissionLabel(context.session.permissionMode)}`,
          `Agent mode: ${agentMode}`,
          `Goal: ${goal}`,
          "",
          "USAGE",
          `Usage: ${context.session.usage.inputTokens} input / ${context.session.usage.outputTokens} output tokens (recorded totals; unreported usage excluded)`,
          ...(usageDetail.length === 0
            ? []
            : [`Usage detail: ${usageDetail.join(" / ")} tokens (provider-reported)`]),
          `Context limits: ${modelLimits === undefined
            ? "unknown"
            : `${modelLimits.maxInputTokens} input / ${modelLimits.maxOutputTokens ?? "unknown"} output tokens (provider verified)`}`,
          `Reported cost: ${context.session.usage.costUsd === undefined ? "unavailable" : `$${context.session.usage.costUsd.toFixed(4)}`}`,
          "Account rate limits: not exposed by this connection; check your provider account.",
          `Pending tools: ${context.session.pendingToolCalls.length}`,
          ...(isPinnedSessionState(context.session)
            ? [`Queued turns: ${context.session.queuedTurns.length}`]
            : []),
          ...(backend === null ? [] : [backend]),
        ].join("\n"),
      );
    },
  };
}

function createCancelCommand(): Command {
  return {
    name: "cancel",
    description: "Cancel the active agent run",
    usage: "/cancel",
    async execute(_args, context) {
      const cancelled = await context.cancelActiveRun();
      return cancelled
        ? message("Cancellation requested")
        : message("No agent run is active", "warning");
    },
  };
}

function createQuitCommand(): Command {
  return {
    name: "quit",
    aliases: ["exit", "q"],
    description: "Exit Recurs",
    usage: "/quit",
    async execute() {
      return { type: "quit" };
    },
  };
}

function createQueueCommand(): Command {
  return {
    name: "queue",
    description: "Manage durable separate follow-up turns",
    usage: "/queue [prompt|resume|clear]",
    async execute(args, context) {
      return context.manageQueuedTurns(args);
    },
  };
}

export function createFoundationCommands(): Command[] {
  return [
    createHelpCommand(),
    createStatusCommand(),
    createCancelCommand(),
    createQueueCommand(),
    createQuitCommand(),
  ];
}
