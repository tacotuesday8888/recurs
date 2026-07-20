import { randomUUID } from "node:crypto";

import {
  compactPinnedSession,
  createRootAgentDescriptor,
  isPinnedSessionState,
} from "@recurs/core";

import {
  createProjectInstructions,
  hasWorkspaceProjectInstructions,
} from "../project-instructions.js";
import {
  message,
  type Command,
  type CommandDependencies,
} from "./types.js";

function requireNoArguments(command: string, args: string): ReturnType<typeof message> | null {
  return args.trim().length === 0
    ? null
    : message(`${command} does not accept arguments`, "error");
}

function createInitCommand(): Command {
  return {
    name: "init",
    description: "Create a starter AGENTS.md without overwriting existing instructions",
    usage: "/init",
    async execute(args, context) {
      const invalid = requireNoArguments("/init", args);
      if (invalid !== null) {
        return invalid;
      }
      if (context.session.executionMode === "plan") {
        return message("Exit Plan mode before creating AGENTS.md", "error");
      }
      if (await hasWorkspaceProjectInstructions(context.session.cwd)) {
        return message(
          "Project instructions already exist; Recurs did not overwrite them",
          "warning",
        );
      }
      if (!(await context.confirm("Create AGENTS.md in this workspace?"))) {
        return message("AGENTS.md was not created", "warning");
      }
      return await createProjectInstructions(context.session.cwd) === "created"
        ? message("Created AGENTS.md")
        : message(
            "Project instructions appeared concurrently; Recurs did not overwrite them",
            "warning",
          );
    },
  };
}

function createNewCommand(dependencies: CommandDependencies): Command {
  return {
    name: "new",
    description: "Start a new durable session in the current workspace",
    usage: "/new",
    async execute(args, context) {
      const invalid = requireNoArguments("/new", args);
      if (invalid !== null) {
        return invalid;
      }
      if (dependencies.sessions === undefined) {
        return message("Session storage is unavailable", "error");
      }
      const id = randomUUID();
      if (!isPinnedSessionState(context.session)) {
        return message(
          "Legacy sessions are read-only; connect a provider before starting a new session",
          "error",
        );
      }
      let next = await dependencies.sessions.createPinnedSession({
        id,
        cwd: context.session.cwd,
        backend: context.session.backend.pin,
        agent: createRootAgentDescriptor(
          id,
          context.session.backend.pin,
          context.session.agent.operatingMode.id,
          context.session.permissionMode,
        ),
        at: context.now(),
      });
      if (
        next.executionMode !== context.session.executionMode ||
        next.permissionMode !== context.session.permissionMode
      ) {
        await dependencies.sessions.withSessionMutation(
          id,
          next.lastSequence,
          async (mutation) => {
            await mutation.append({
              type: "mode_updated",
              source: "command",
              at: context.now(),
              executionMode: context.session.executionMode,
              permissionMode: context.session.permissionMode,
              ...(context.session.prePlanPermissionMode === undefined
                ? {}
                : {
                    prePlanPermissionMode:
                      context.session.prePlanPermissionMode,
                  }),
            });
          },
        );
        const loaded = await dependencies.sessions.loadState(id);
        if (!isPinnedSessionState(loaded)) {
          return message("The new pinned session could not be loaded", "error");
        }
        next = loaded;
      }
      context.session = next;
      return message(`Started session ${id}`);
    },
  };
}

function createResumeCommand(dependencies: CommandDependencies): Command {
  return {
    name: "resume",
    description: "List durable sessions or resume one exact session id",
    usage: "/resume [session-id]",
    async execute(args, context) {
      if (dependencies.sessions === undefined) {
        return message("Session storage is unavailable", "error");
      }
      const sessions = await dependencies.sessions.list();
      const id = args.trim();
      if (id.length === 0) {
        if (sessions.length === 0) {
          return message("No durable sessions found", "warning");
        }
        return message(
          sessions
            .map((session) => `${session.id}  ${session.updatedAt}  ${session.cwd}`)
            .join("\n"),
        );
      }
      if (!sessions.some((session) => session.id === id)) {
        return message(`Session not found: ${id}`, "error");
      }
      context.session = await dependencies.sessions.loadState(id);
      return message(`Resumed session ${id}`);
    },
  };
}

function createForkCommand(dependencies: CommandDependencies): Command {
  return {
    name: "fork",
    description: "Fork the completed conversation into a new durable session",
    usage: "/fork",
    async execute(args, context) {
      const invalid = requireNoArguments("/fork", args);
      if (invalid !== null) return invalid;
      if (dependencies.sessions === undefined) {
        return message("Session storage is unavailable", "error");
      }
      if (!isPinnedSessionState(context.session)) {
        return message("Legacy sessions cannot be forked", "error");
      }
      if (context.session.backend.pin.kind === "agent_runtime") {
        return message(
          "Delegated runtime continuations cannot be forked safely",
          "error",
        );
      }
      const sourceId = context.session.id;
      const next = await dependencies.sessions.forkPinnedSession({
        sourceId,
        expectedSourceSequence: context.session.lastSequence,
        id: randomUUID(),
        at: context.now(),
      });
      context.session = next;
      return message(`Forked session ${sourceId} as ${next.id}`);
    },
  };
}

function createCompactCommand(dependencies: CommandDependencies): Command {
  return {
    name: "compact",
    description: "Summarize earlier context and retain recent complete tool groups",
    usage: "/compact",
    async execute(args, context) {
      const invalid = requireNoArguments("/compact", args);
      if (invalid !== null) {
        return invalid;
      }
      if (isPinnedSessionState(context.session) &&
        context.session.backend.pin.kind === "agent_runtime") {
        return message(
          "Delegated sessions cannot be compacted in this release",
          "error",
        );
      }
      if (!isPinnedSessionState(context.session)) {
        return message("Legacy sessions are read-only and cannot be compacted", "error");
      }
      if (dependencies.sessions === undefined) {
        return message("Session storage is unavailable for compaction", "error");
      }
      const signal = dependencies.signal?.() ?? new AbortController().signal;
      const provider = dependencies.resolveProvider === undefined
        ? dependencies.provider
        : await dependencies.resolveProvider(context.session, signal);
      if (provider === undefined || provider === null) {
        return message("No provider is available for compaction", "error");
      }
      context.session = await compactPinnedSession({
        sessions: dependencies.sessions,
        state: context.session,
        provider,
        signal,
        at: context.now(),
      });
      return message("Session context compacted");
    },
  };
}

export function createSessionCommands(
  dependencies: CommandDependencies,
): Command[] {
  return [
    createInitCommand(),
    createNewCommand(dependencies),
    createForkCommand(dependencies),
    createResumeCommand(dependencies),
    createCompactCommand(dependencies),
  ];
}
