import type { PermissionMode } from "@recurs/tools";
import type { SessionRecord } from "@recurs/core";

import { message, type Command, type CommandContext } from "./types.js";

const labels: Record<PermissionMode, string> = {
  ask_always: "Ask Always",
  approved_for_me: "Approved for Me",
  full_access: "Full Access",
};

function parseMode(input: string): PermissionMode | null {
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

export function createPermissionsCommand(): Command {
  return {
    name: "permissions",
    aliases: ["permission"],
    description: "Inspect or change the active permission preset",
    usage: "/permissions [ask|approved|full]",
    async execute(args, context) {
      if (args.trim().length === 0) {
        return message(`Permission mode: ${permissionLabel(context.session.permissionMode)}`);
      }
      const mode = parseMode(args);
      if (mode === null) {
        return message(
          "Choose Ask Always, Approved for Me, or Full Access",
          "error",
        );
      }
      if (mode === "full_access" && context.session.permissionMode !== mode) {
        const confirmed = await context.confirm(
          "Full Access skips routine prompts for workspace changes, commands, network access, and deployment. Direct credential requests remain blocked, and sensitive or external paths still ask. Full Access is not credential-safe because shell commands are not isolated from host files or the network. Enable it?",
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
