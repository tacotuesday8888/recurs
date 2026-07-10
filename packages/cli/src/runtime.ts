import {
  AgentLoopError,
  reduceSessionRecord,
  type AgentLoop,
  type JsonlSessionStore,
  type RunResult,
  type SessionState,
} from "@recurs/core";

import { parseCommand } from "./commands/parser.js";
import type { CommandRegistry } from "./commands/registry.js";
import type {
  CommandContext,
  CommandResult,
} from "./commands/types.js";

export type RuntimeErrorCode =
  | "busy"
  | "invalid_input"
  | "provider_not_configured";

export class RuntimeError extends Error {
  constructor(
    public readonly code: RuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

export interface RuntimeDependencies {
  commands: CommandRegistry;
  loop: AgentLoop;
  sessions: JsonlSessionStore;
  confirm(message: string): Promise<boolean>;
  now?: () => string;
  promptUnavailableMessage?: string;
}

export class RecursRuntime {
  #activeController: AbortController | null = null;
  #confirm: (message: string) => Promise<boolean>;

  constructor(
    private readonly dependencies: RuntimeDependencies,
    public session: SessionState,
  ) {
    this.#confirm = dependencies.confirm;
  }

  setConfirmHandler(confirm: (message: string) => Promise<boolean>): void {
    this.#confirm = confirm;
  }

  confirm(message: string): Promise<boolean> {
    return this.#confirm(message);
  }

  currentSignal(): AbortSignal {
    return this.#activeController?.signal ?? new AbortController().signal;
  }

  cancel(): boolean {
    if (this.#activeController === null) {
      return false;
    }
    this.#activeController.abort();
    return true;
  }

  #commandContext(): CommandContext {
    const context: CommandContext = {
      session: this.session,
      now: () => this.dependencies.now?.() ?? new Date().toISOString(),
      confirm: (message) => this.confirm(message),
      cancelActiveRun: async () => this.cancel(),
      applyRecord: async (record) => {
        await this.dependencies.sessions.append(context.session.id, record);
        context.session = reduceSessionRecord(context.session, record);
        this.session = context.session;
      },
    };
    return context;
  }

  async #runPrompt(
    prompt: string,
    executionMode?: "act" | "plan",
  ): Promise<RunResult> {
    if (this.#activeController !== null) {
      throw new RuntimeError("busy", "An agent run is already active");
    }
    if (this.dependencies.promptUnavailableMessage !== undefined) {
      throw new RuntimeError(
        "provider_not_configured",
        this.dependencies.promptUnavailableMessage,
      );
    }
    this.#activeController = new AbortController();
    try {
      const result = await this.dependencies.loop.run({
        sessionId: this.session.id,
        prompt,
        signal: this.#activeController.signal,
        ...(executionMode === undefined ? {} : { executionMode }),
      });
      this.session = await this.dependencies.sessions.loadState(this.session.id);
      return result;
    } catch (error) {
      try {
        this.session = await this.dependencies.sessions.loadState(this.session.id);
      } catch {
        // Preserve the original run failure when recovery itself fails.
      }
      throw error;
    } finally {
      this.#activeController = null;
    }
  }

  async submit(input: string): Promise<CommandResult | RunResult> {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      throw new RuntimeError("invalid_input", "Input cannot be empty");
    }
    const parsed = parseCommand(trimmed);
    if (parsed !== null) {
      if (
        this.#activeController !== null &&
        parsed.name !== "cancel" &&
        parsed.name !== "status" &&
        parsed.name !== "help"
      ) {
        throw new RuntimeError(
          "busy",
          "Only /cancel, /status, and /help are available during an active run",
        );
      }
      const ownsController =
        this.#activeController === null && parsed.name !== "cancel";
      if (ownsController) {
        this.#activeController = new AbortController();
      }
      const context = this.#commandContext();
      let result: CommandResult;
      try {
        result = await this.dependencies.commands.execute(parsed, context);
        this.session = context.session;
      } finally {
        if (ownsController) {
          this.#activeController = null;
        }
      }
      if (result.type === "submit_prompt") {
        return this.#runPrompt(result.prompt, result.executionMode);
      }
      return result;
    }
    if (trimmed.startsWith("/")) {
      return {
        type: "message",
        level: "error",
        text: "Invalid slash command",
      };
    }
    return this.#runPrompt(trimmed);
  }
}

export function isCancellation(error: unknown): boolean {
  return error instanceof AgentLoopError && error.code === "cancelled";
}
