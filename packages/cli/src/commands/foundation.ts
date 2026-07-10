import type { Command } from "./types.js";
import { message } from "./types.js";
import { permissionLabel } from "./permissions.js";

const helpText = [
  "/help                         Show this command list",
  "/goal [objective|action]      Manage the durable goal",
  "/plan [prompt|exit]           Enter read-only Plan mode or return to Act",
  "/permissions [mode]           Set Ask Always, Approved for Me, or Full Access",
  "/status                       Show session, goal, mode, and usage",
  "/init                         Create AGENTS.md without overwriting it",
  "/new                          Start a new durable session",
  "/resume [session-id]          List sessions or resume an exact id",
  "/compact                      Summarize earlier context safely",
  "/diff [--staged] [path]       Show the current Git diff",
  "/review                       Review changes with read-only tools",
  "/undo                         Restore the latest safe checkpoint",
  "/cancel                       Cancel the active agent run",
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
    description: "Show current session state",
    usage: "/status",
    async execute(_args, context) {
      const goal = context.session.goal === null
        ? "None"
        : `${context.session.goal.status}: ${context.session.goal.objective}`;
      return message(
        [
          `Session: ${context.session.id}`,
          `Workspace: ${context.session.cwd}`,
          `Model: ${context.session.model}`,
          `Execution: ${context.session.executionMode === "plan" ? "Plan" : "Act"}`,
          `Permissions: ${permissionLabel(context.session.permissionMode)}`,
          `Goal: ${goal}`,
          `Usage: ${context.session.usage.inputTokens} input / ${context.session.usage.outputTokens} output tokens`,
          `Pending tools: ${context.session.pendingToolCalls.length}`,
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

export function createFoundationCommands(): Command[] {
  return [
    createHelpCommand(),
    createStatusCommand(),
    createCancelCommand(),
    createQuitCommand(),
  ];
}
