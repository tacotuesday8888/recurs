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
      let operatingModeId = context.session.agent.operatingMode.id;
      let permissionMode = context.session.permissionMode;
      let company = context.session.agent.company?.blueprintVersion === 2
        ? context.session.agent.company
        : undefined;
      if (company !== undefined) {
        if (dependencies.company?.decisions === undefined) {
          return message(
            "Company revision storage is unavailable; the current session was not changed",
            "error",
          );
        }
        const latest = await dependencies.company.decisions.latest({
          company,
          signal: dependencies.signal?.() ?? new AbortController().signal,
        });
        operatingModeId = latest.authority.operatingModeId;
        permissionMode = latest.authority.permissionMode;
        company = {
          blueprintId: latest.id,
          blueprintVersion: 2,
          blueprintRevision: latest.revision,
          roleId: latest.authorityAnchors.rootRoleId,
          roleVersion: 1,
        };
      }
      let next = await dependencies.sessions.createPinnedSession({
        id,
        cwd: context.session.cwd,
        backend: context.session.backend.pin,
        agent: createRootAgentDescriptor(
          id,
          context.session.backend.pin,
          operatingModeId,
          permissionMode,
          "act",
          company,
        ),
        at: context.now(),
      });
      if (
        next.executionMode !== context.session.executionMode ||
        next.permissionMode !== permissionMode
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
              permissionMode,
              ...(context.session.executionMode !== "plan"
                ? {}
                : { prePlanPermissionMode: permissionMode }),
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
      return message(company?.blueprintVersion === 2
        ? `Started session ${id} with company revision ${company.blueprintRevision}`
        : `Started session ${id}`);
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
    aliases: ["copy"],
    description: "Fork the completed conversation into a new durable session",
    usage: "/fork [session-id]",
    async execute(args, context) {
      if (dependencies.sessions === undefined) {
        return message("Session storage is unavailable", "error");
      }
      const source = args.trim() ? await dependencies.sessions.loadState(args.trim()) : context.session;
      if (source.cwd !== context.session.cwd) return message("Copy a chat from the current workspace", "error");
      if (!isPinnedSessionState(source)) {
        return message("Legacy sessions cannot be forked", "error");
      }
      if (source.backend.pin.kind === "agent_runtime") {
        return message(
          "Delegated runtime continuations cannot be forked safely",
          "error",
        );
      }
      const sourceId = source.id;
      const next = await dependencies.sessions.forkPinnedSession({
        sourceId,
        expectedSourceSequence: source.lastSequence,
        id: randomUUID(),
        at: context.now(),
      });
      context.session = next;
      return message(`Forked session ${sourceId} as ${next.id}`);
    },
  };
}

function createChatCommands(dependencies: CommandDependencies): Command[] {
  const actions = ["rename", "pin", "unpin", "archive", "unarchive"] as const;
  return [{
    name: "chats", description: "Find active or archived chats", usage: "/chats [archived|all]",
    async execute(args, context) {
      if (!dependencies.sessions) return message("Session storage is unavailable", "error");
      if (!["", "archived", "all"].includes(args.trim())) return message("Use /chats [archived|all]", "error");
      const entries = (await dependencies.sessions.list()).filter((entry) => entry.cwd === context.session.cwd && (args.trim() === "all" || Boolean(entry.archived) === (args.trim() === "archived")));
      if (entries.length === 0) return message("No matching chats. Use /chats all to include archived chats.");
      if (!context.selectChoice) return message(entries.map((entry) => `${entry.id}  ${entry.pinned ? "[pinned] " : ""}${entry.title ?? entry.model}${entry.archived ? " [archived]" : ""}`).join("\n"));
      const id = await context.selectChoice("Chats · select to open", entries.map((entry) => ({ id: entry.id, label: `${entry.pinned ? "★ " : ""}${entry.title ?? entry.model}${entry.archived ? " · archived" : ""}`, detail: `${entry.updatedAt} · ${entry.cwd}`, current: entry.id === context.session.id })));
      if (id === null) return message("Chat selection cancelled");
      if (!entries.some((entry) => entry.id === id)) return message("Chat selection is unavailable", "error");
      context.session = await dependencies.sessions.loadState(id);
      return message(`Resumed session ${id}`);
    },
  }, ...actions.map((name): Command => ({
    name, description: `${name[0]!.toUpperCase()}${name.slice(1)} a saved chat`, usage: name === "rename" ? "/rename <title>" : `/${name} [session-id]`,
    async execute(args, context) {
      if (!dependencies.sessions) return message("Session storage is unavailable", "error");
      const renameTarget = name === "rename" ? /^--id ([^ ]+) ([\s\S]+)$/u.exec(args.trim()) : null;
      const id = name === "rename" ? renameTarget?.[1] ?? context.session.id : args.trim() || context.session.id;
      const entries = await dependencies.sessions.list();
      if (!entries.some((entry) => entry.id === id && entry.cwd === context.session.cwd)) return message("Chat not found in this workspace", "error");
      const patch = name === "rename" ? { title: renameTarget?.[2]?.trim() ?? args.trim() } : name === "pin" || name === "unpin" ? { pinned: name === "pin" } : { archived: name === "archive" };
      const updated = await dependencies.sessions.updateMetadata(id, patch);
      return message(`${name === "rename" ? "Renamed" : name === "pin" ? "Pinned" : name === "unpin" ? "Unpinned" : name === "archive" ? "Archived" : "Unarchived"} chat: ${updated.title ?? id}${name === "archive" ? " · /chats archived to reopen" : ""}`);
    },
  }))];
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
        : await dependencies.resolveProvider(
            context.session,
            signal,
            context.invocation,
          );
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
    ...createChatCommands(dependencies),
    createInitCommand(),
    createNewCommand(dependencies),
    createForkCommand(dependencies),
    createResumeCommand(dependencies),
    createCompactCommand(dependencies),
  ];
}
