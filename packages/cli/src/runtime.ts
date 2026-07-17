import {
  AgentLoopError,
  CompatibilityRunCoordinator,
  CoordinatedRunError,
  CoordinatedRuntime,
  createSessionState,
  reduceSessionRecord,
  type AgentLoop,
  type JsonlSessionStore,
  type SessionState,
  type WorkspaceShellState,
} from "@recurs/core";
import {
  createHostInvocation,
  type HostInvocation,
  type RunCoordinator,
  type RunResult,
} from "@recurs/contracts";

import { parseCommand } from "./commands/parser.js";
import type { CommandRegistry } from "./commands/registry.js";
import type {
  CommandContext,
  CommandResult,
} from "./commands/types.js";
import { applyCommandSessionRecord } from "./session-mutations.js";

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
  loop?: AgentLoop;
  coordinator?: RunCoordinator;
  sessions: JsonlSessionStore;
  confirm(message: string): Promise<boolean>;
  now?: () => string;
  promptUnavailableMessage?: string;
  providerGuide?(query: string, signal: AbortSignal): Promise<string>;
}

const MAX_CONFIRMATION_TEXT_LENGTH = 8_192;
const TERMINAL_CONTROL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

function terminalSafeConfirmationText(message: string): string {
  let safe = "";
  for (const character of message) {
    const rendered = TERMINAL_CONTROL.test(character)
      ? `\\u{${character.codePointAt(0)!.toString(16).toUpperCase()}}`
      : character;
    if (safe.length + rendered.length > MAX_CONFIRMATION_TEXT_LENGTH) {
      return `${safe}…`;
    }
    safe += rendered;
  }
  return safe;
}

function isWorkspaceShellState(
  state: SessionState | WorkspaceShellState,
): state is WorkspaceShellState {
  return "type" in state && state.type === "workspace";
}

function untrustedProgrammaticInvocation(): HostInvocation {
  return createHostInvocation({
    invocation: "one_shot",
    userPresent: false,
    remote: false,
    scripted: true,
    embedding: "sdk",
  });
}

export class RecursRuntime {
  #activeController: AbortController | null = null;
  #confirm: (message: string) => Promise<boolean>;
  #session: SessionState | null;
  #workspace: WorkspaceShellState | null;
  #runner: CoordinatedRuntime | null;
  readonly #coordinator: RunCoordinator | null;

  constructor(
    private readonly dependencies: RuntimeDependencies,
    initialState: SessionState | WorkspaceShellState,
  ) {
    this.#confirm = dependencies.confirm;
    this.#coordinator = dependencies.coordinator ??
      (dependencies.loop === undefined
        ? null
        : new CompatibilityRunCoordinator(dependencies.loop));
    if (isWorkspaceShellState(initialState)) {
      this.#session = null;
      this.#workspace = initialState;
      this.#runner = null;
    } else {
      this.#session = initialState;
      this.#workspace = null;
      this.#runner = this.#coordinator === null
        ? null
        : new CoordinatedRuntime(
            { sessions: dependencies.sessions, coordinator: this.#coordinator },
            initialState,
          );
    }
  }

  #activateSession(session: SessionState): void {
    this.#session = session;
    this.#workspace = null;
    if (this.#coordinator === null) {
      this.#runner = null;
    } else if (this.#runner === null) {
      this.#runner = new CoordinatedRuntime(
        { sessions: this.dependencies.sessions, coordinator: this.#coordinator },
        session,
      );
    } else {
      this.#runner.replaceSession(session);
    }
  }

  get state():
    | WorkspaceShellState
    | { type: "session"; session: SessionState } {
    if (this.#workspace !== null) {
      return this.#workspace;
    }
    return { type: "session", session: this.session };
  }

  get session(): SessionState {
    if (this.#session === null) {
      throw new RuntimeError(
        "provider_not_configured",
        "No active model session",
      );
    }
    return this.#session;
  }

  setConfirmHandler(confirm: (message: string) => Promise<boolean>): void {
    this.#confirm = confirm;
  }

  confirm(message: string): Promise<boolean> {
    return this.#confirm(terminalSafeConfirmationText(message));
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
        context.session = await applyCommandSessionRecord(
          this.dependencies.sessions,
          context.session,
          record,
        );
        this.#activateSession(context.session);
      },
    };
    return context;
  }

  #workspaceContext(): CommandContext {
    const workspace = this.#workspace;
    if (workspace === null) {
      throw new RuntimeError("invalid_input", "Workspace shell is unavailable");
    }
    const transient = createSessionState({
      id: "workspace-shell",
      cwd: workspace.cwd,
      model: "unconfigured",
      permissionMode: workspace.permissionMode,
    });
    const context: CommandContext = {
      session: transient,
      now: () => this.dependencies.now?.() ?? new Date().toISOString(),
      confirm: (message) => this.confirm(message),
      cancelActiveRun: async () => this.cancel(),
      applyRecord: async (record) => {
        context.session = reduceSessionRecord(context.session, record);
        this.#workspace = {
          ...workspace,
          permissionMode: context.session.permissionMode,
        };
      },
    };
    return context;
  }

  async #submitWorkspaceCommand(
    name: string,
    args: string,
  ): Promise<CommandResult> {
    const workspace = this.#workspace;
    if (workspace === null) {
      throw new RuntimeError("invalid_input", "Workspace shell is unavailable");
    }
    if (name === "help") {
      return {
        type: "message",
        level: "info",
        text: [
          "/help                         Show workspace commands",
          "/provider [search]            Discover, detect, and connect providers",
          "/connect                      Alias for /provider",
          "/model                        Inspect model configuration",
          "/permissions [mode]           Set the next-session permission default",
          "/status                       Show workspace configuration",
          "/resume                       List historical sessions",
          "/init                         Create AGENTS.md without overwriting it",
          "/diff [--staged] [path]       Show the current Git diff",
          "/quit, /exit, /q              Exit",
        ].join("\n"),
      };
    }
    if (name === "status") {
      return {
        type: "message",
        level: "info",
        text: [
          "No active session",
          `Workspace: ${workspace.cwd}`,
          `Permissions: ${workspace.permissionMode}`,
          "Model connection: Not configured",
        ].join("\n"),
      };
    }
    if ((name === "provider" || name === "connect") && this.dependencies.providerGuide !== undefined) {
      return {
        type: "message",
        level: "info",
        text: await this.dependencies.providerGuide(args, this.currentSignal()),
      };
    }
    if (name === "connect") {
      return {
        type: "message",
        level: "warning",
        text: [
          "Choose one setup path, then restart Recurs:",
          "  recurs setup codex",
          "  recurs setup local --url http://127.0.0.1:11434/v1 --model <model-id>",
          "Codex setup delegates ChatGPT sign-in to the official runtime. Local setup requests no API key.",
        ].join("\n"),
      };
    }
    if (name === "model") {
      return {
        type: "message",
        level: "warning",
        text: "No model connection is configured. Use /connect for Codex subscription or credential-free local setup instructions.",
      };
    }
    const allowed = new Set([
      "help",
      "permissions",
      "permission",
      "resume",
      "init",
      "diff",
      "quit",
      "exit",
      "q",
    ]);
    if (!allowed.has(name)) {
      return {
        type: "message",
        level: "error",
        text: `/${name} requires an active model session`,
      };
    }
    const context = this.#workspaceContext();
    const result = await this.dependencies.commands.execute(
      { name, args },
      context,
    );
    if (context.session.id !== "workspace-shell") {
      this.#activateSession(context.session);
    }
    return result;
  }

  async #runPrompt(
    prompt: string,
    executionMode?: "act" | "plan",
    invocation: HostInvocation = untrustedProgrammaticInvocation(),
  ): Promise<RunResult> {
    if (this.#activeController !== null) {
      throw new RuntimeError("busy", "An agent run is already active");
    }
    if (this.#session === null || this.#runner === null) {
      throw new RuntimeError(
        "provider_not_configured",
        this.dependencies.promptUnavailableMessage ??
          "No model connection is configured",
      );
    }
    this.#activeController = new AbortController();
    try {
      const result = await this.#runner.run(
        prompt,
        invocation,
        this.#activeController.signal,
        executionMode,
      );
      this.#session = this.#runner.session;
      return result;
    } catch (error) {
      try {
        this.#activateSession(
          await this.dependencies.sessions.loadState(this.#session.id),
        );
      } catch {
        // Preserve the original run failure when recovery itself fails.
      }
      throw error;
    } finally {
      this.#activeController = null;
    }
  }

  async submit(
    input: string,
    invocation: HostInvocation = untrustedProgrammaticInvocation(),
  ): Promise<CommandResult | RunResult> {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      throw new RuntimeError("invalid_input", "Input cannot be empty");
    }
    const parsed = parseCommand(trimmed);
    if (parsed !== null) {
      if (this.#workspace !== null) {
        return this.#submitWorkspaceCommand(parsed.name, parsed.args);
      }
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
      if (
        (parsed.name === "provider" || parsed.name === "connect") &&
        this.dependencies.providerGuide !== undefined
      ) {
        return {
          type: "message",
          level: "info",
          text: await this.dependencies.providerGuide(
            parsed.args,
            this.currentSignal(),
          ),
        };
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
        this.#activateSession(context.session);
      } finally {
        if (ownsController) {
          this.#activeController = null;
        }
      }
      if (result.type === "submit_prompt") {
        return this.#runPrompt(
          result.prompt,
          result.executionMode,
          invocation,
        );
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
    if (this.#workspace !== null) {
      throw new RuntimeError(
        "provider_not_configured",
        this.dependencies.promptUnavailableMessage ??
          "No model connection is configured",
      );
    }
    return this.#runPrompt(trimmed, undefined, invocation);
  }
}

export function isCancellation(error: unknown): boolean {
  return (error instanceof AgentLoopError && error.code === "cancelled") ||
    (error instanceof CoordinatedRunError && error.failure.code === "cancelled");
}
