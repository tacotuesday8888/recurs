import type { ToolDefinition } from "@recurs/contracts";

export type PermissionMode =
  | "ask_always"
  | "approved_for_me"
  | "full_access";

export type ExecutionMode = "act" | "plan";
export type PermissionDecision = "allow" | "ask" | "deny";
export type ToolExecutionClass =
  | "in_process"
  | "fixed_process"
  | "arbitrary_process";
export type ToolSecurityProfile = "local_guarded" | "tools_disabled";

export type PermissionCategory =
  | "read"
  | "write"
  | "shell"
  | "network"
  | "external_path"
  | "sensitive"
  | "credential"
  | "deploy";

export type PermissionRisk = "normal" | "elevated" | "destructive";

export interface PermissionIntent {
  category: PermissionCategory;
  resource: string;
  risk: PermissionRisk;
}

export type ApprovalResponse = "allow_once" | "allow_session" | "deny";

export interface ApprovalHandler {
  request(intent: PermissionIntent): Promise<ApprovalResponse>;
}

export interface ToolContext {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  executionMode: ExecutionMode;
  readRevisions: Map<string, string>;
  approvedIntents?: Set<string>;
}

export interface ToolResult {
  output: string;
  metadata?: Record<string, unknown>;
}

export interface Tool<Input = unknown> {
  readonly definition: ToolDefinition;
  readonly executionClass: ToolExecutionClass;
  readonly mutating: boolean;
  parse(input: unknown): Input;
  permissions(input: Input, context: ToolContext): PermissionIntent[];
  /** Validate without mutating workspace or external state. */
  preflight?(input: Input, context: ToolContext): Promise<void>;
  execute(input: Input, context: ToolContext): Promise<ToolResult>;
}

export type ToolErrorCode =
  | "unknown_tool"
  | "tool_unavailable"
  | "duplicate_tool"
  | "invalid_input"
  | "permission_denied"
  | "plan_mode_denied"
  | "cancelled"
  | "execution_failed"
  | "external_path"
  | "sensitive_file"
  | "not_found"
  | "not_a_directory"
  | "output_limit"
  | "process_failed"
  | "unsupported_platform"
  | "unsupported_git_version"
  | "command_timeout"
  | "unread_file"
  | "stale_file"
  | "patch_files_mismatch"
  | "patch_failed"
  | "checkpoint_storage"
  | "checkpoint_migration_required"
  | "checkpoint_not_found"
  | "checkpoint_conflict"
  | "checkpoint_corrupt";

export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ToolError";
  }
}
