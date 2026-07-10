import { randomUUID } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import { compactSession, type SessionRecord } from "@recurs/core";

import {
  message,
  type Command,
  type CommandDependencies,
} from "./types.js";

const agentsTemplate = `# Recurs project instructions

Add project-specific build, test, architecture, and safety instructions here.
Keep this file concise and safe to share with every coding-agent session.
`;

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
      const file = path.join(context.session.cwd, "AGENTS.md");
      try {
        await lstat(file);
        return message("AGENTS.md already exists; Recurs did not overwrite it", "warning");
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
      if (!(await context.confirm("Create AGENTS.md in this workspace?"))) {
        return message("AGENTS.md was not created", "warning");
      }
      const handle = await open(file, "wx", 0o644);
      try {
        await handle.writeFile(agentsTemplate, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return message("Created AGENTS.md");
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
      await dependencies.sessions.append(id, {
        version: 1,
        type: "session_created",
        sessionId: id,
        at: context.now(),
        cwd: context.session.cwd,
        model: context.session.model,
      });
      context.session = await dependencies.sessions.loadState(id);
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
      if (dependencies.provider === undefined) {
        return message("No provider is available for compaction", "error");
      }
      const compacted = await compactSession(
        context.session,
        dependencies.provider,
        dependencies.signal?.() ?? new AbortController().signal,
      );
      const record: SessionRecord = {
        version: 1,
        type: "session_compacted",
        sessionId: context.session.id,
        at: context.now(),
        summary: compacted.summary,
        retainedMessages: compacted.retainedMessages,
      };
      await context.applyRecord(record);
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
    createResumeCommand(dependencies),
    createCompactCommand(dependencies),
  ];
}
