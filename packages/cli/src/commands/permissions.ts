import type { PermissionMode } from "@recurs/tools";
import type { SessionRecord } from "@recurs/core";

import { message, type Command, type CommandContext } from "./types.js";

const labels: Record<PermissionMode, string> = {
  ask_always: "Ask Always",
  approved_for_me: "Approved for Me",
  full_access: "Full Access",
};

export function parsePermissionMode(input: string): PermissionMode | null {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, "_");
  if (normalized === "ask" || normalized === "ask_always") {
    return "ask_always";
  }
  if (
    normalized === "approved" ||
    normalized === "approved_for_me" ||
    normalized === "auto"
  ) {
    return "approved_for_me";
  }
  if (normalized === "full" || normalized === "full_access") {
    return "full_access";
  }
  return null;
}

function modeRecord(
  context: CommandContext,
  permissionMode: PermissionMode,
): SessionRecord {
  const prePlanPermissionMode = context.session.executionMode === "plan"
    ? permissionMode
    : context.session.prePlanPermissionMode;
  return {
    version: 1,
    type: "mode_updated",
    sessionId: context.session.id,
    at: context.now(),
    executionMode: context.session.executionMode,
    permissionMode,
    ...(prePlanPermissionMode === undefined ? {} : { prePlanPermissionMode }),
  };
}

export function permissionLabel(mode: PermissionMode): string {
  return labels[mode];
}

function permissionSummary(mode: PermissionMode): string {
  const boundary = "Child agents inherit a ceiling from the parent, their profile, Plan mode, and OS containment; they cannot widen it.";
  switch (mode) {
    case "ask_always":
      return [
        "Ask Always: Recurs asks before workspace changes, commands, network access, and deployment.",
        boundary,
      ].join("\n");
    case "approved_for_me":
      return [
        "Approved for Me: routine workspace work is approved; consequential, sensitive, external, and credential-related actions still ask.",
        boundary,
      ].join("\n");
    case "full_access":
      return [
        "Full Access: routine prompts are skipped inside Recurs's active execution boundary; direct credential access and protected paths remain blocked.",
        boundary,
      ].join("\n");
  }
}

export function createPermissionsCommand(): Command {
  return {
    name: "permissions",
    aliases: ["permission"],
    description: "Inspect or change the active permission preset",
    usage: "/permissions [ask|approved|full]",
    async execute(args, context) {
      if (args.trim().length === 0) {
        const mode = context.session.permissionMode;
        return message([
          `Permission mode: ${permissionLabel(mode)}`,
          permissionSummary(mode),
          "Use /permissions ask, /permissions approved, or /permissions full to change this session.",
        ].join("\n"));
      }
      const mode = parsePermissionMode(args);
      if (mode === null) {
        return message(
          "Choose Ask Always, Approved for Me, or Full Access",
          "error",
        );
      }
      if (mode === "full_access" && context.session.permissionMode !== mode) {
        const confirmed = await context.confirm(
          "Full Access skips routine prompts for workspace changes, commands, network access, and deployment inside Recurs's active execution boundary. Direct credential requests remain blocked, and sensitive or external paths still ask. Commands may access anything exposed by the current platform sandbox; Windows does not yet have Recurs-owned OS containment. Enable it?",
        );
        if (!confirmed) {
          return message("Full Access was not enabled", "warning");
        }
      }
      await context.applyRecord(modeRecord(context, mode));
      return message(`Permission mode: ${permissionLabel(mode)}`);
    },
  };
}
