import { createGitStatusTool, runProcess, safeGitArguments } from "@recurs/tools";

export async function workspaceGitStatus(cwd: string, signal: AbortSignal) {
  const result = await createGitStatusTool().execute({}, { cwd, sessionId: "workspace-view", signal, executionMode: "plan", readRevisions: new Map() });
  return { metadata: result.metadata ?? {}, records: result.output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) };
}
export async function workspaceWorktrees(cwd: string, signal: AbortSignal): Promise<string> {
  const args = await safeGitArguments(cwd, ["worktree", "list", "--porcelain"], signal);
  const result = await runProcess("git", args, { cwd, signal, timeoutMs: 5000, maxOutputBytes: 65536 });
  return result.stdout;
}
