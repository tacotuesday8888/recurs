import type {
  JsonlSessionStore,
  PinnedSessionState,
  SessionRecord,
  SessionState,
  TeamRunCancelResult,
  TeamRunResult,
  TeamRunResumeResult,
  TeamRunSnapshot,
} from "@recurs/core";
import type { BillingSource, HostInvocation } from "@recurs/contracts";
import type { ModelProvider } from "@recurs/providers";
import type { CheckpointStore, ExecutionMode, ToolContext } from "@recurs/tools";
import type { AgentSkillCatalog } from "../agent-skills.js";
import type { McpServerCatalog } from "../mcp-client.js";

export interface ParsedCommand {
  name: string;
  args: string;
}

export type CommandResult =
  | { type: "message"; level: "info" | "warning" | "error"; text: string }
  | { type: "submit_prompt"; prompt: string; executionMode?: ExecutionMode }
  | { type: "submit_queued_prompt"; queuedInputId: string; prompt: string }
  | { type: "quit" };

export interface CommandContext {
  session: SessionState;
  invocation: HostInvocation;
  now(): string;
  confirm(message: string): Promise<boolean>;
  cancelActiveRun(): Promise<boolean>;
  manageQueuedTurns(args: string): Promise<CommandResult>;
  applyRecord(record: SessionRecord): Promise<void>;
}

export interface CommandDependencies {
  sessions?: JsonlSessionStore;
  provider?: ModelProvider;
  resolveProvider?(
    session: SessionState,
    signal: AbortSignal,
  ): Promise<ModelProvider | null>;
  checkpoints?: CheckpointStore;
  signal?(): AbortSignal;
  teamRuns?: {
    list(parentSessionId: string): Promise<readonly TeamRunSnapshot[]>;
    status(parentSessionId: string, runId: string): Promise<TeamRunSnapshot>;
    wait(
      parentSessionId: string,
      runId: string,
      timeoutMs: number,
      signal: AbortSignal,
    ): Promise<{ readonly snapshot: TeamRunSnapshot; readonly timedOut: boolean }>;
    cancel(
      parentSessionId: string,
      runId: string,
      reason: string,
    ): Promise<TeamRunCancelResult>;
    resume(
      parentSessionId: string,
      runId: string,
      context: ToolContext,
    ): Promise<TeamRunResumeResult>;
    apply(
      parentSessionId: string,
      runId: string,
      context: ToolContext,
    ): Promise<TeamRunResult>;
  };
  skills?: AgentSkillCatalog;
  mcp?: McpServerCatalog;
  models?: ModelSessionService;
}

export interface ModelSelectionOption {
  readonly connectionId: string;
  readonly label: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly primary: boolean;
  readonly execution: "Plan-only" | "Act + Plan";
  readonly billingSources: readonly BillingSource[];
}

export type ModelSessionCreation =
  | { readonly status: "created"; readonly session: PinnedSessionState }
  | {
      readonly status:
        | "cancelled"
        | "changed"
        | "failed"
        | "not_found"
        | "unavailable"
        | "unchanged";
    };

export interface ModelSessionService {
  list(signal: AbortSignal): Promise<readonly ModelSelectionOption[]>;
  create(input: {
    readonly expected: ModelSelectionOption;
    readonly current: SessionState;
    readonly at: string;
    readonly signal: AbortSignal;
  }): Promise<ModelSessionCreation>;
}

export interface Command {
  name: string;
  aliases?: readonly string[];
  description: string;
  usage: string;
  execute(args: string, context: CommandContext): Promise<CommandResult>;
}

export function message(
  text: string,
  level: "info" | "warning" | "error" = "info",
): CommandResult {
  return { type: "message", level, text };
}
