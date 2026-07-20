import {
  MAX_PROCESS_SESSION_COLUMNS,
  MAX_PROCESS_SESSION_INPUT_BYTES,
  MAX_PROCESS_SESSION_ROWS,
  MAX_PROCESS_SESSION_YIELD_TIME_MS,
  MIN_PROCESS_SESSION_COLUMNS,
  MIN_PROCESS_SESSION_ROWS,
  ToolError,
  type OwnedProcessSnapshot,
  type OwnedProcessSummary,
} from "@recurs/tools";

import type { Command, CommandDependencies, CommandResult } from "./types.js";
import { message } from "./types.js";

const usage =
  "/process [session-id [poll|wait [ms]|write <text>|enter [text]|close|resize <columns>x<rows>|stop]]";

function splitFirst(value: string): readonly [string, string] {
  const match = /^(\S+)(?:\s+(.*))?$/u.exec(value);
  return [match?.[1] ?? "", match?.[2] ?? ""];
}

function usageError(): CommandResult {
  return message(`Usage: ${usage}`, "error");
}

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
    description: "Inspect or control owned command sessions",
    usage,
    async execute(args, context) {
      const processes = dependencies.processes;
      if (processes === undefined) {
        return message("Process session controls are unavailable", "error");
      }
      const trimmed = args.trim();
      if (trimmed.length === 0 || trimmed === "list") {
        const summaries = processes.list(context.session.id);
        return summaries.length === 0
          ? message("No process sessions are owned by this conversation")
          : message(summaries.map(renderSummary).join("\n"));
      }
      const [sessionId, actionInput] = splitFirst(trimmed);
      if (sessionId.length === 0 || sessionId.length > 128 || sessionId === "list") {
        return usageError();
      }
      const [action, value] = splitFirst(actionInput);
      const base = { ownerId: context.session.id, sessionId };
      if (action.length === 0 || action === "poll") {
        return value.length === 0
          ? renderSnapshot(await processes.interact({ ...base, yieldTimeMs: 0 }))
          : usageError();
      }
      if (action === "wait") {
        const yieldTimeMs = value.length === 0 ? 1_000 : Number(value);
        if (
          !/^\d+$/u.test(value.length === 0 ? "1000" : value) ||
          !Number.isSafeInteger(yieldTimeMs) ||
          yieldTimeMs < 0 ||
          yieldTimeMs > MAX_PROCESS_SESSION_YIELD_TIME_MS
        ) {
          return usageError();
        }
        return renderSnapshot(await processes.interact({
          ...base,
          yieldTimeMs,
        }));
      }
      if (action === "write" || action === "enter") {
        if (
          (action === "write" && value.length === 0) ||
          Buffer.byteLength(
              action === "enter" ? `${value}\n` : value,
              "utf8",
            ) > MAX_PROCESS_SESSION_INPUT_BYTES
        ) {
          return usageError();
        }
        return renderSnapshot(await processes.interact({
          ...base,
          input: action === "enter" ? `${value}\n` : value,
          yieldTimeMs: 250,
        }));
      }
      if (action === "close") {
        return value.length === 0
          ? renderSnapshot(await processes.interact({
              ...base,
              closeStdin: true,
              yieldTimeMs: 1_000,
            }))
          : usageError();
      }
      if (action === "resize") {
        const size = /^(\d+)x(\d+)$/u.exec(value);
        const columns = Number(size?.[1]);
        const rows = Number(size?.[2]);
        if (
          size === null ||
          !Number.isSafeInteger(columns) ||
          columns < MIN_PROCESS_SESSION_COLUMNS ||
          columns > MAX_PROCESS_SESSION_COLUMNS ||
          !Number.isSafeInteger(rows) ||
          rows < MIN_PROCESS_SESSION_ROWS ||
          rows > MAX_PROCESS_SESSION_ROWS
        ) {
          return usageError();
        }
        return renderSnapshot(await processes.interact({
          ...base,
          resize: { columns, rows },
          yieldTimeMs: 0,
        }));
      }
      if (action === "stop") {
        return value.length === 0
          ? renderSnapshot(await processes.interact({
              ...base,
              stop: true,
              yieldTimeMs: 0,
            }))
          : usageError();
      }
      return usageError();
    },
  };
}
