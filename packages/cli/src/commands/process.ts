import {
  ToolError,
  type OwnedProcessSnapshot,
  type OwnedProcessSummary,
} from "@recurs/tools";

import type { Command, CommandDependencies, CommandResult } from "./types.js";
import { message } from "./types.js";

function safeProcessOutput(output: string): string {
  let safe = "";
  for (const character of output) {
    const codePoint = character.codePointAt(0)!;
    safe += codePoint <= 8 || (codePoint >= 11 && codePoint <= 31) ||
        (codePoint >= 127 && codePoint <= 159)
      ? `\\u${codePoint.toString(16).padStart(4, "0")}`
      : character;
  }
  return safe;
}

function renderSummary(summary: OwnedProcessSummary): string {
  const status = summary.status === "running"
    ? "running"
    : summary.status === "failed"
    ? `failed (${summary.failureCode ?? "process_failed"})`
    : `exited ${summary.exitCode ?? -1}`;
  const buffered = summary.bufferedOutputBytes === 0
    ? ""
    : ` · ${summary.bufferedOutputBytes} buffered byte${summary.bufferedOutputBytes === 1 ? "" : "s"}`;
  return `${summary.sessionId} · ${status} · ${summary.terminal ? "terminal" : "piped"}${buffered}`;
}

function renderSnapshot(snapshot: OwnedProcessSnapshot): CommandResult {
  if (snapshot.status === "failed") {
    throw new ToolError(
      snapshot.failure?.code ?? "process_failed",
      snapshot.failure?.message ?? "The process session failed",
    );
  }
  const terminal = snapshot.status === "running"
    ? `Process session ${snapshot.sessionId} is running.`
    : `Process exited with code ${snapshot.exitCode ?? -1}.`;
  const output = safeProcessOutput(snapshot.output);
  const text = output.length === 0
    ? terminal
    : `${output}${output.endsWith("\n") ? "" : "\n"}${terminal}`;
  return message(
    text,
    snapshot.status === "exited" && snapshot.exitCode !== 0
      ? "warning"
      : "info",
  );
}

export function createProcessCommand(
  dependencies: CommandDependencies,
): Command {
  return {
    name: "process",
    aliases: ["processes"],
    description: "List, poll, or stop owned command sessions",
    usage: "/process [session-id [poll|stop]]",
    async execute(args, context) {
      const processes = dependencies.processes;
      if (processes === undefined) {
        return message("Process session controls are unavailable", "error");
      }
      const parts = args.trim().length === 0 ? [] : args.trim().split(/\s+/u);
      if (parts.length === 0 || (parts.length === 1 && parts[0] === "list")) {
        const summaries = processes.list(context.session.id);
        return summaries.length === 0
          ? message("No process sessions are owned by this conversation")
          : message(summaries.map(renderSummary).join("\n"));
      }
      if (parts.length > 2 || parts[0] === undefined ||
        (parts[1] !== undefined && parts[1] !== "poll" && parts[1] !== "stop")) {
        return message("Usage: /process [session-id [poll|stop]]", "error");
      }
      return renderSnapshot(await processes.interact({
        ownerId: context.session.id,
        sessionId: parts[0],
        stop: parts[1] === "stop",
        yieldTimeMs: 0,
      }));
    },
  };
}
