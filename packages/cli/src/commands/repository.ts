import { workspaceGitStatus, workspaceBranches } from "../workspace-context.js";
import {
  createGitDiffTool,
  createGitShowTool,
  safeGitArguments,
  runProcess,
  WorkspacePathPolicy,
  assertNonCredentialPath,
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
  const flag = /^(--staged|--unstaged|--all)(?:\s+([\s\S]+))?$/u.exec(trimmed);
  if (flag) return { staged: flag[1] === "--staged", ...(flag[1] === "--all" ? { base: "HEAD" } : {}), ...(flag[2] ? { path: flag[2] } : {}) };
  const base = /^--base\s+(\S+)(?:\s+([\s\S]+))?$/u.exec(trimmed);
  if (base) return { staged: false, base: base[1]!, ...(base[2] ? { path: base[2] } : {}) };
  if (trimmed.startsWith("--")) throw new Error("Use /diff [--staged|--unstaged|--all|--last-turn|--committed|--base <ref>] [path]");
  return { staged: false, ...(trimmed ? { path: trimmed } : {}) };
}

async function gitDiff(
  context: CommandContext,
  dependencies: CommandDependencies,
  input: GitDiffInput,
): Promise<string> {
  const tool = createGitDiffTool();
  return (await tool.execute(input, toolContext(context, dependencies))).output;
}

async function allChanges(context: CommandContext, dependencies: CommandDependencies, filename?: string): Promise<ReturnType<typeof message>> {
  const currentSignal = signal(dependencies);
  const cwd = context.session.cwd;
  const policy = new WorkspacePathPolicy(cwd);
  const target = filename === undefined ? "." : (await policy.resolveWritable(filename)).relative;
  assertNonCredentialPath(target);
  const status = await workspaceGitStatus(cwd, currentSignal);
  const hasHead = typeof status.metadata.oid === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(status.metadata.oid);
  const tracked = hasHead ? await gitDiff(context, dependencies, { staged: false, base: "HEAD", ...(filename ? { path: filename } : {}) }) : "";
  const parts = [tracked];
  let size = tracked.length;
  let omitted = status.metadata.truncated === true;
  const files = status.records.filter((record) => record.type === "change" && (!hasHead || record.kind === "untracked") && typeof record.path === "string");
  const prefix = await safeGitArguments(cwd, [], currentSignal);
  for (const record of files) {
    const file = record.path as string;
    if (target !== "." && file !== target && !file.startsWith(`${target}/`)) continue;
    if (size >= 256 * 1024) { omitted = true; break; }
    try {
      const resolved = await policy.resolveReadable(file);
      assertNonCredentialPath(resolved.relative);
      const result = await runProcess("git", [...prefix, "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", "/dev/null", resolved.relative], { cwd, signal: currentSignal, maxOutputBytes: Math.max(1, 256 * 1024 - size), acceptableExitCodes: [0, 1] });
      parts.push(result.stdout); size += result.stdout.length;
    } catch {
      currentSignal.throwIfAborted();
      omitted = true;
    }
  }
  const text = parts.filter(Boolean).join("\n");
  return text ? { type: "message", level: "info", text, review: { title: `Uncommitted${omitted ? " · partial" : ""}` } } : message(omitted ? "Some files could not be previewed. Use /files to inspect them." : "No uncommitted changes");
}

function createDiffCommand(dependencies: CommandDependencies): Command {
  return {
    name: "diff",
    aliases: ["changes"],
    description: "Review workspace or committed changes",
    usage: "/diff [--staged|--unstaged|--all|--last-turn|--committed|--base <ref>] [path]",
    async execute(args, context) {
      let requested = args.trim();
      if (!requested && context.selectChoice) {
        const choice = await context.selectChoice("Changes", [
          { id: "--unstaged", label: "Unstaged", detail: "Index → working tree" },
          { id: "--staged", label: "Staged", detail: "HEAD → index" },
          { id: "--all", label: "All uncommitted", detail: "HEAD → working tree, including new files" },
          { id: "--branch", label: "Compare with branch", detail: "Choose a local or remote-tracking ref" },
          { id: "--last-turn", label: "Last turn", detail: "Applied patches from the latest turn" },
          { id: "--committed", label: "Last commit", detail: "Changes introduced by HEAD" },
        ]);
        if (choice === null) return message("Review closed");
        if (!["--unstaged", "--staged", "--all", "--last-turn", "--committed", "--branch"].includes(choice)) return message("Unknown review scope", "error");
        requested = choice;
        if (choice === "--branch") {
          const refs = await workspaceBranches(context.session.cwd, signal(dependencies));
          if (!refs.length) return message("No branches available");
          const ref = await context.selectChoice("Compare with branch", refs.map((id) => ({ id, label: id.replace(/^refs\/heads\//u, "").replace(/^refs\/remotes\//u, "") })));
          if (ref === null) return message("Review closed");
          if (!refs.includes(ref)) return message("Branch no longer available", "error");
          requested = `--base ${ref}`;
        }
      }
      if (requested === "--all" || requested.startsWith("--all ")) return allChanges(context, dependencies, requested.slice("--all".length).trim() || undefined);
      if (requested === "--last-turn") {
        if (!dependencies.sessions) return message("Turn history is unavailable", "warning");
        const { records } = await dependencies.sessions.loadReadOnly(context.session.id);
        const start = records.findLastIndex((record) => record.type === "turn_started");
        const calls = new Map<string, string>();
        const patches: string[] = [];
        let length = 0;
        let partial = false;
        for (const record of records.slice(start < 0 ? records.length : start)) {
          if (record.type === "tool_started" && record.call.name === "apply_patch") {
            const input = record.call.arguments as { patch?: unknown } | null;
            if (typeof input?.patch === "string") calls.set(record.call.id, input.patch);
          }
          if (record.type === "tool_completed") {
            const patch = calls.get(record.callId);
            calls.delete(record.callId);
            if (patch) {
              if (length + patch.length > 256 * 1024) { partial = true; break; }
              patches.push(patch); length += patch.length;
            }
          }
        }
        return patches.length ? { type: "message", level: "info", text: patches.join("\n"), review: { title: `Last turn · applied patches${partial ? " · partial" : ""}` } } : message("No applied patches recorded for the last turn");
      }
      let output: string;
      if (requested === "--committed" || requested.startsWith("--committed ")) {
        const cwd = context.session.cwd;
        const currentSignal = signal(dependencies);
        const prefix = await safeGitArguments(cwd, [], currentSignal);
        const head = await runProcess("git", [...prefix, "--no-replace-objects", "rev-parse", "--verify", "HEAD^{commit}"], { cwd, signal: currentSignal, maxOutputBytes: 4096 });
        const tool = createGitShowTool();
        const filename = requested.slice("--committed".length).trim();
        output = (await tool.execute(tool.parse({ commit: head.stdout.trim(), ...(filename ? { path: filename } : {}) }), toolContext(context, dependencies))).output;
        if (output.startsWith("{")) output = output.slice(output.indexOf("\n") + 1);
      } else {
        if (requested.startsWith("--") && !/^(?:--staged|--unstaged|--all)(?:$| )|^--base \S+/u.test(requested)) return message("Use /diff [--staged|--unstaged|--all|--last-turn|--committed|--base <ref>] [path]", "error");
        const input = parseDiffArguments(requested);
        output = await gitDiff(context, dependencies, createGitDiffTool().parse(input));
      }
      const title = requested.startsWith("--committed") ? "Last commit" : requested.startsWith("--staged") ? "Staged" : requested.startsWith("--all") ? "Uncommitted" : requested.startsWith("--base") ? `Changes from ${requested.split(/\s+/u)[1]}` : "Changes";
      return output.length === 0 ? message("No changes in this view") : { type: "message", level: "info", text: output, review: { title } };
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
