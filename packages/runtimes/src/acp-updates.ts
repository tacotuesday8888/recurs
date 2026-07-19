import { createHash } from "node:crypto";
import path from "node:path";

import type {
  SessionConfigOption,
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { AgentRuntimeEvent, RuntimeActivity } from "@recurs/contracts";

import { containsSecretCanary } from "./acp-profile.js";

export interface AcpConfigSelection {
  readonly configId: string;
  readonly value: string | boolean;
}

export interface AcpUpdateTranslationState {
  readonly sessionId: string;
  readonly cwd: string;
  readonly expectedModeId: string | null;
  readonly expectedConfigOptions: readonly AcpConfigSelection[];
  readonly emitFileEvents: boolean;
  readonly activities: Map<string, { kind: ToolKind; name: string }>;
}

export class AcpUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpUpdateError";
  }
}

function safeActivityId(toolCallId: string): string {
  return `acp-${createHash("sha256").update(toolCallId).digest("hex").slice(0, 20)}`;
}

function activityKind(kind: ToolKind): RuntimeActivity["kind"] {
  switch (kind) {
    case "execute":
      return "command";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    default:
      return "tool";
  }
}

function activityStatus(
  status: "pending" | "in_progress" | "completed" | "failed" | null | undefined,
): RuntimeActivity["status"] {
  switch (status) {
    case "pending":
      return "started";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "in_progress":
    case null:
    case undefined:
      return "running";
  }
}

function safeActivityName(kind: ToolKind): string {
  switch (kind) {
    case "read":
      return "ACP read";
    case "edit":
      return "ACP edit";
    case "delete":
      return "ACP delete";
    case "move":
      return "ACP move";
    case "search":
      return "ACP search";
    case "execute":
      return "ACP command";
    case "think":
      return "ACP reasoning";
    case "fetch":
      return "ACP network request";
    case "switch_mode":
      return "ACP mode change";
    case "other":
      return "ACP tool";
  }
}

function inWorkspacePath(cwd: string, candidate: string): string | null {
  if (
    !path.isAbsolute(candidate) ||
    candidate.includes("\0") ||
    containsSecretCanary(candidate)
  ) {
    return null;
  }
  const resolvedCwd = path.resolve(cwd);
  const resolved = path.resolve(candidate);
  const relative = path.relative(resolvedCwd, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return relative.split(path.sep).join("/");
}

function collectPaths(
  cwd: string,
  kind: ToolKind,
  content: readonly ToolCallContent[] | null | undefined,
  locations: readonly ToolCallLocation[] | null | undefined,
): string[] {
  const candidates: string[] = [];
  for (const item of content ?? []) {
    if (item.type === "diff") candidates.push(item.path);
  }
  if (["edit", "delete", "move"].includes(kind)) {
    for (const location of locations ?? []) candidates.push(location.path);
  }
  const normalized = candidates
    .map((candidate) => inWorkspacePath(cwd, candidate))
    .filter((candidate): candidate is string => candidate !== null);
  return [...new Set(normalized)].sort();
}

function currentConfigValue(option: SessionConfigOption): string | boolean {
  return option.type === "boolean" ? option.currentValue : option.currentValue;
}

export function configSelectionsMatch(
  options: readonly SessionConfigOption[] | null | undefined,
  expected: readonly AcpConfigSelection[],
): boolean {
  if (expected.length === 0) return true;
  if (!options) return false;
  return expected.every((selection) => {
    const option = options.find((candidate) => candidate.id === selection.configId);
    return option !== undefined && currentConfigValue(option) === selection.value;
  });
}

export function translateAcpUpdate(
  notification: SessionNotification,
  state: AcpUpdateTranslationState,
): readonly AgentRuntimeEvent[] {
  if (notification.sessionId !== state.sessionId) {
    throw new AcpUpdateError("ACP update targeted the wrong session");
  }
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return update.content.type === "text"
        ? [{ type: "text_delta", text: update.content.text }]
        : [];
    case "agent_thought_chunk":
      return update.content.type === "text"
        ? [{ type: "reasoning_delta", text: update.content.text }]
        : [];
    case "tool_call": {
      const kind = update.kind ?? "other";
      const name = safeActivityName(kind);
      state.activities.set(update.toolCallId, { kind, name });
      const events: AgentRuntimeEvent[] = [{
        type: "activity",
        activity: {
          id: safeActivityId(update.toolCallId),
          kind: activityKind(kind),
          name,
          status: activityStatus(update.status),
        },
      }];
      const paths = collectPaths(state.cwd, kind, update.content, update.locations);
      if (state.emitFileEvents && paths.length > 0) {
        events.push({ type: "files_changed", paths });
      }
      return events;
    }
    case "tool_call_update": {
      const previous = state.activities.get(update.toolCallId);
      const kind = update.kind ?? previous?.kind ?? "other";
      const name = previous?.name ?? safeActivityName(kind);
      state.activities.set(update.toolCallId, { kind, name });
      const events: AgentRuntimeEvent[] = [{
        type: "activity",
        activity: {
          id: safeActivityId(update.toolCallId),
          kind: activityKind(kind),
          name,
          status: activityStatus(update.status),
        },
      }];
      const paths = collectPaths(state.cwd, kind, update.content, update.locations);
      if (state.emitFileEvents && paths.length > 0) {
        events.push({ type: "files_changed", paths });
      }
      return events;
    }
    case "current_mode_update":
      if (
        state.expectedModeId !== null &&
        update.currentModeId !== state.expectedModeId
      ) {
        throw new AcpUpdateError("ACP agent drifted from the reviewed mode");
      }
      return [];
    case "config_option_update":
      if (!configSelectionsMatch(update.configOptions, state.expectedConfigOptions)) {
        throw new AcpUpdateError("ACP agent drifted from reviewed configuration");
      }
      return [];
    case "user_message_chunk":
    case "plan":
    case "plan_update":
    case "plan_removed":
    case "available_commands_update":
    case "session_info_update":
    case "usage_update":
      return [];
  }
}
