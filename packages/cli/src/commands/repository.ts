import {
  createGitDiffTool,
  type GitDiffInput,
  type ToolContext,
} from "@recurs/tools";

import {
  message,
  type Command,
  type CommandContext,
  type CommandDependencies,
} from "./types.js";

function signal(dependencies: CommandDependencies): AbortSignal {
  return dependencies.signal?.() ?? new AbortController().signal;
}

function toolContext(
  context: CommandContext,
  dependencies: CommandDependencies,
): ToolContext {
  return {
    sessionId: context.session.id,
    cwd: context.session.cwd,
    signal: signal(dependencies),
    executionMode: context.session.executionMode,
    readRevisions: new Map(),
  };
}

function parseDiffArguments(args: string): GitDiffInput {
  const trimmed = args.trim();
  if (trimmed === "--staged") {
    return { staged: true };
  }
  if (trimmed.startsWith("--staged ")) {
    return { staged: true, path: trimmed.slice("--staged ".length).trim() };
  }
  return trimmed.length === 0
    ? { staged: false }
    : { staged: false, path: trimmed };
}

async function gitDiff(
  context: CommandContext,
  dependencies: CommandDependencies,
  input: GitDiffInput,
): Promise<string> {
  const tool = createGitDiffTool();
  return (await tool.execute(input, toolContext(context, dependencies))).output;
}

function createDiffCommand(dependencies: CommandDependencies): Command {
  return {
    name: "diff",
    description: "Show the current Git diff",
    usage: "/diff [--staged] [path]",
    async execute(args, context) {
      const output = await gitDiff(
        context,
        dependencies,
        parseDiffArguments(args),
      );
      return output.length === 0
        ? message("No matching Git diff")
        : message(output);
    },
  };
}

function createReviewCommand(dependencies: CommandDependencies): Command {
  return {
    name: "review",
    description: "Review current staged and unstaged changes without mutating files",
    usage: "/review",
    async execute(args, context) {
      if (args.trim().length > 0) {
        return message("/review does not accept arguments", "error");
      }
      const [unstaged, staged] = await Promise.all([
        gitDiff(context, dependencies, { staged: false }),
        gitDiff(context, dependencies, { staged: true }),
      ]);
      const diff = [
        unstaged.length === 0 ? "" : `Unstaged changes:\n${unstaged}`,
        staged.length === 0 ? "" : `Staged changes:\n${staged}`,
      ]
        .filter((item) => item.length > 0)
        .join("\n");
      return {
        type: "submit_prompt",
        executionMode: "plan",
        prompt: [
          "Review the following Git changes. Stay read-only. Prioritize correctness, regressions, security, and missing tests. Cite file paths and explain actionable findings.",
          diff.length === 0 ? "There is no Git diff." : diff,
        ].join("\n\n"),
      };
    },
  };
}

function createUndoCommand(dependencies: CommandDependencies): Command {
  return {
    name: "undo",
    description: "Safely restore the latest agent checkpoint",
    usage: "/undo",
    async execute(args, context) {
      if (args.trim().length > 0) {
        return message("/undo does not accept arguments", "error");
      }
      if (context.session.executionMode === "plan") {
        return message("Exit Plan mode before undoing workspace changes", "error");
      }
      if (dependencies.checkpoints === undefined) {
        return message("Checkpoint storage is unavailable", "error");
      }
      const result = await dependencies.checkpoints.undoLatest(
        context.session.id,
        context.session.cwd,
      );
      const parts = [
        result.restored.length === 0
          ? ""
          : `Restored: ${result.restored.join(", ")}`,
        result.deleted.length === 0
          ? ""
          : `Deleted: ${result.deleted.join(", ")}`,
      ].filter((item) => item.length > 0);
      return message(parts.length === 0 ? "Checkpoint had no file changes" : parts.join("\n"));
    },
  };
}

export function createRepositoryCommands(
  dependencies: CommandDependencies,
): Command[] {
  return [
    createDiffCommand(dependencies),
    createReviewCommand(dependencies),
    createUndoCommand(dependencies),
  ];
}
