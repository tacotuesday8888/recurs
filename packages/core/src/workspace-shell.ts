import type { PermissionMode } from "@recurs/tools";

export interface WorkspaceShellState {
  type: "workspace";
  cwd: string;
  permissionMode: PermissionMode;
}

export function createWorkspaceShell(
  cwd: string,
  permissionMode: PermissionMode = "ask_always",
): WorkspaceShellState {
  return Object.freeze({ type: "workspace", cwd, permissionMode });
}
