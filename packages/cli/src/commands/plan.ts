import {
  enterPlanMode,
  exitPlanMode,
  type SessionRecord,
  type SessionState,
} from "@recurs/core";

import { message, type Command, type CommandContext } from "./types.js";

function modeRecord(
  context: CommandContext,
  state: SessionState,
): SessionRecord {
  return {
    version: 1,
    type: "mode_updated",
    sessionId: context.session.id,
    at: context.now(),
    executionMode: state.executionMode,
    permissionMode: state.permissionMode,
    ...(state.prePlanPermissionMode === undefined
      ? {}
      : { prePlanPermissionMode: state.prePlanPermissionMode }),
  };
}

export function createPlanCommand(): Command {
  return {
    name: "plan",
    description: "Enter enforced read-only planning or return to Act mode",
    usage: "/plan [prompt|exit]",
    async execute(args, context) {
      const prompt = args.trim();
      if (prompt.toLowerCase() === "exit") {
        if (context.session.executionMode === "act") {
          return message("Already in Act mode");
        }
        const next = exitPlanMode(context.session);
        await context.applyRecord(modeRecord(context, next));
        return message("Returned to Act mode");
      }

      if (context.session.executionMode !== "plan") {
        const next = enterPlanMode(context.session);
        await context.applyRecord(modeRecord(context, next));
      }
      if (prompt.length > 0) {
        return { type: "submit_prompt", prompt };
      }
      return message("Plan mode enabled; mutating tools are unavailable");
    },
  };
}
