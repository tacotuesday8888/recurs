import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ModelMessage, ToolCall } from "@recurs/contracts";
import { durableSessionMessages, type SessionState } from "@recurs/core";

import { permissionLabel } from "./permissions.js";
import { message, type Command, type CommandDependencies } from "./types.js";

/** Tool output is already bounded by the tools layer; keep exports readable anyway. */
const MAX_TOOL_OUTPUT_CHARACTERS = 4_000;
const MAX_TOOL_ARGUMENT_CHARACTERS = 1_000;

function truncate(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n… (${text.length - limit} more characters omitted)`;
}

function fence(text: string, language = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}${language}\n${text}\n${marks}`;
}

function formatToolCall(call: ToolCall): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(call.arguments, null, 2) ?? "null";
  } catch {
    serialized = "(arguments could not be serialized)";
  }
  return `- \`${call.name}\`\n\n${fence(truncate(serialized, MAX_TOOL_ARGUMENT_CHARACTERS), "json")}`;
}

/** Render one durable conversation as portable Markdown. */
export function renderSessionMarkdown(input: {
  readonly session: SessionState;
  readonly messages: readonly ModelMessage[];
  readonly exportedAt: string;
}): string {
  const { session, messages } = input;
  const toolNames = new Map<string, string>();
  for (const entry of messages) {
    for (const call of entry.toolCalls ?? []) toolNames.set(call.id, call.name);
  }
  const lines: string[] = [
    `# Recurs session ${session.id}`,
    "",
    `- Workspace: \`${session.cwd}\``,
    `- Model: ${session.model}`,
    `- Execution: ${session.executionMode === "plan" ? "Plan (read-only)" : "Act"}`,
    `- Permissions: ${permissionLabel(session.permissionMode)}`,
    ...(session.forkedFrom === null
      ? []
      : [`- Forked from: ${session.forkedFrom.sessionId} at sequence ${session.forkedFrom.sequence}`]),
    `- Usage: ${session.usage.inputTokens} input / ${session.usage.outputTokens} output tokens`,
    `- Exported: ${input.exportedAt}`,
    `- Messages: ${messages.length}`,
    "",
    "Tool results are shown as recorded, bounded to keep the export readable.",
    "",
  ];
  for (const entry of messages) {
    switch (entry.role) {
      case "user":
        lines.push("## User", "", entry.content, "");
        if (entry.images !== undefined && entry.images.length > 0) {
          lines.push(`_${entry.images.length} attached image(s) not included._`, "");
        }
        break;
      case "assistant": {
        lines.push("## Assistant", "");
        if (entry.content.length > 0) lines.push(entry.content, "");
        const calls = entry.toolCalls ?? [];
        if (calls.length > 0) {
          lines.push("Tool calls:", "", ...calls.map(formatToolCall), "");
        }
        break;
      }
      case "tool": {
        const name = entry.toolCallId === undefined ? undefined : toolNames.get(entry.toolCallId);
        lines.push(`## Tool result${name === undefined ? "" : ` (\`${name}\`)`}`, "");
        lines.push(fence(truncate(entry.content, MAX_TOOL_OUTPUT_CHARACTERS)), "");
        break;
      }
      case "system":
        lines.push("## System", "", entry.content, "");
        break;
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function defaultExportName(sessionId: string, at: string): string {
  const stamp = at.replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
  return `recurs-${sessionId}-${stamp}.md`;
}

/** Resolve an explicit export path that must stay inside the canonical workspace. */
async function workspaceExportPath(cwd: string, requested: string): Promise<string> {
  if (requested.includes("\0") || requested.endsWith("/") || requested.endsWith(path.sep)) {
    throw new Error("Export path must name a file");
  }
  const resolved = path.resolve(cwd, requested);
  let parent: string;
  try {
    parent = await realpath(path.dirname(resolved));
  } catch {
    throw new Error("Export directory does not exist inside the workspace");
  }
  const workspace = await realpath(cwd);
  const relative = path.relative(workspace, parent);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Export path must stay inside the workspace");
  }
  return path.join(parent, path.basename(resolved));
}

export function createExportCommand(dependencies: CommandDependencies): Command {
  return {
    name: "export",
    description: "Save the durable conversation as a Markdown file",
    usage: "/export [workspace-relative path]",
    async execute(args, context) {
      if (dependencies.sessions === undefined) {
        return message("Session storage is unavailable for export", "error");
      }
      const requested = args.trim();
      const exportedAt = context.now();
      let target: string;
      if (requested.length === 0) {
        if (dependencies.exportDirectory === undefined) {
          return message(
            "No private export directory is configured; give /export a workspace-relative path",
            "error",
          );
        }
        await mkdir(dependencies.exportDirectory, { recursive: true, mode: 0o700 });
        target = path.join(
          dependencies.exportDirectory,
          defaultExportName(context.session.id, exportedAt),
        );
      } else {
        if (context.session.executionMode === "plan") {
          return message(
            "Plan mode is read-only; omit the path to export into the private Recurs data directory",
            "error",
          );
        }
        try {
          target = await workspaceExportPath(context.session.cwd, requested);
        } catch (error) {
          return message(error instanceof Error ? error.message : "Invalid export path", "error");
        }
      }
      const { records } = await dependencies.sessions.loadReadOnly(context.session.id);
      const durable = durableSessionMessages(records);
      const rendered = renderSessionMarkdown({
        session: context.session,
        messages: durable.length > 0 ? durable : context.session.messages,
        exportedAt,
      });
      try {
        await writeFile(target, rendered, { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return message(
          code === "EEXIST"
            ? `Export target already exists: ${target}`
            : `Export could not be written: ${target}`,
          "error",
        );
      }
      return message(`Exported conversation to ${target}`);
    },
  };
}
