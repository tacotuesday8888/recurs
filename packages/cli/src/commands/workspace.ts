import path from "node:path";
import { createReadFileTool, createListFilesTool } from "@recurs/tools";
import { workspaceGitStatus, workspaceWorktrees } from "../workspace-context.js";
import { message, type Command, type CommandContext, type CommandDependencies } from "./types.js";

export function createWorkspaceCommands(dependencies: CommandDependencies): Command[] {
  const signal = () => dependencies.signal?.() ?? new AbortController().signal;
  const toolContext = (context: CommandContext) => ({ cwd: context.session.cwd, sessionId: context.session.id, signal: signal(), executionMode: context.session.executionMode, readRevisions: new Map<string, string>() });
  return [{
    name: "source", description: "Read a workspace source file", usage: "/source [--lines start:end] <path>",
    async execute(args, context) {
      const range = /^--lines (\d+):(\d+) ([\s\S]+)$/u.exec(args.trim());
      if (!args.trim() || args.trim().startsWith("--lines ") && range === null) return message("Use /source [--lines start:end] <path>", "error");
      const filename = range?.[3]?.trim() ?? args.trim();
      const tool = createReadFileTool();
      const result = await tool.execute(tool.parse({ path: filename, ...(range === null ? {} : { startLine: Number(range[1]), endLine: Number(range[2]) }) }), toolContext(context));
      const fence = "`".repeat([...result.output.matchAll(/`+/gu)].reduce((longest, match) => Math.max(longest, match[0].length + 1), 3));
      const language = path.extname(filename).slice(1).replace(/[^a-z0-9]/giu, "");
      const location = result.output.length === 0 ? `no lines in requested range · ${result.metadata?.totalLines} total` : `lines ${result.metadata?.startLine}–${result.metadata?.endLine} of ${result.metadata?.totalLines}`;
      return message(`${filename} · source snapshot · ${location}\n\n${fence}${language}\n${result.output}\n${fence}`);
    },
  }, {
    name: "workspace", aliases: ["git"], description: "Inspect the local environment or choose a Git workflow", usage: "/workspace [status|files|worktrees|commit|push|pr|branch]",
    async execute(args, context) {
      let action = args.trim();
      if (!action && context.selectChoice) {
        action = await context.selectChoice("Workspace · choose an action", [
          { id: "status", label: "Branch and changes" }, { id: "files", label: "Source files", detail: "Read files with /source <path>." },
          { id: "worktrees", label: "Local worktrees" }, { id: "branch", label: "Change branch or environment", detail: "Ask the agent to inspect and prepare the change." },
          { id: "commit", label: "Review and commit", detail: "Agent-assisted; inspect the diff and confirm the files first." },
          { id: "push", label: "Push branch", detail: "Agent-assisted; verify the remote and get confirmation." },
          { id: "pr", label: "Pull request", detail: "Agent-assisted; inspect the current PR or prepare a draft." },
        ]) ?? "cancel";
      }
      if (action === "cancel") return message("Workspace selection cancelled");
      if (action === "files") {
        const tool = createListFilesTool();
        const result = await tool.execute(tool.parse({ path: ".", limit: 200 }), toolContext(context));
        const files = result.output.trim().split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { path: string }).path);
        return message(["Source files · /source <path> to read", ...files, ...(result.metadata?.truncated ? ["… partial list (up to 200 files)"] : [])].join("\n"));
      }
      if (action === "worktrees") return message(`Local worktrees\n\n${await workspaceWorktrees(context.session.cwd, signal())}\nTo create or move to a worktree, use /workspace branch.`);
      if (["commit", "push", "pr", "branch"].includes(action)) {
        if (context.session.executionMode === "plan") return message("Exit Plan mode before starting a Git workflow that may change the workspace", "error");
        const prompts: Record<string, string> = {
          commit: "Inspect the current Git status and diff. Help me prepare a commit. Show the exact files and proposed commit message, check for secrets, and ask for confirmation before staging or committing. Preserve unrelated edits.",
          push: "Inspect this branch, its upstream, and pending commits. Help me push it. Show the exact remote and branch and ask for confirmation before pushing. Do not force-push.",
          pr: "Inspect the current branch and its GitHub pull request if available. If no PR exists, prepare a title and description from the actual diff. Ask before publishing a new PR or changing an existing one.",
          branch: "Inspect the current branch, uncommitted changes, and local worktrees. Help me choose a branch or isolated worktree for my next task. Ask which environment I want before switching or creating anything, and preserve all existing work.",
        };
        return { type: "submit_prompt", prompt: prompts[action]! };
      }
      if (action !== "" && action !== "status") return message("Use /workspace [status|files|worktrees|commit|push|pr|branch]", "error");
      const { metadata, records } = await workspaceGitStatus(context.session.cwd, signal());
      const changes = records.filter((entry) => entry.type === "change");
      return message([
        "WORKSPACE", `Environment: local · ${context.session.cwd}`, `Branch: ${metadata.branch ?? "detached HEAD"}`,
        `Revision: ${metadata.oid ?? "no commits yet"}`, `Upstream: ${metadata.upstream ?? "not configured"}`,
        `Ahead: ${metadata.ahead ?? "unknown"} · behind: ${metadata.behind ?? "unknown"} (local refs)`,
        `Changed files: ${metadata.totalChanges ?? changes.length}`, "",
        ...changes.slice(0, 100).map((entry) => `${entry.index}${entry.worktree}  ${entry.path}`),
        ...(metadata.truncated || changes.length > 100 ? ["… partial file list"] : []),
        "", "/diff changes · /diff --staged staged · /source <path> code", "/workspace worktrees · /workspace commit · /workspace push · /workspace pr",
      ].join("\n"));
    },
  }];
}
