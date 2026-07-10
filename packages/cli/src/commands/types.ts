import type {
  JsonlSessionStore,
  SessionRecord,
  SessionState,
} from "@recurs/core";
import type { ModelProvider } from "@recurs/providers";
import type { CheckpointStore, ExecutionMode } from "@recurs/tools";

export interface ParsedCommand {
  name: string;
  args: string;
}

export type CommandResult =
  | { type: "message"; level: "info" | "warning" | "error"; text: string }
  | { type: "submit_prompt"; prompt: string; executionMode?: ExecutionMode }
  | { type: "quit" };

export interface CommandContext {
  session: SessionState;
  now(): string;
  confirm(message: string): Promise<boolean>;
  cancelActiveRun(): Promise<boolean>;
  applyRecord(record: SessionRecord): Promise<void>;
}

export interface CommandDependencies {
  sessions?: JsonlSessionStore;
  provider?: ModelProvider;
  checkpoints?: CheckpointStore;
  signal?(): AbortSignal;
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
