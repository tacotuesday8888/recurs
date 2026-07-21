import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  AgentLoopError,
  CompatibilityRunCoordinator,
  CoordinatedRunError,
  CoordinatedRuntime,
  MAX_PENDING_QUEUED_TURNS,
  MAX_PENDING_STEERING_INPUTS,
  MAX_QUEUED_TURN_BYTES,
  MAX_STEERING_INPUT_BYTES,
  QueuedTurnAdmissionQueue,
  TurnSteeringQueue,
  createSessionState,
  isPinnedSessionState,
  reduceSessionRecord,
  type AgentLoop,
  type JsonlSessionStore,
  type SessionState,
  type WorkspaceShellState,
} from "@recurs/core";
import {
  createHostInvocation,
  type HostInvocation,
  type ModelImageInput,
  type RunCoordinator,
  type RunResult,
} from "@recurs/contracts";
import type {
  InteractWithOwnedProcessInput,
  OwnedProcessManager,
  OwnedProcessSnapshot,
} from "@recurs/tools";

import { parseCommand } from "./commands/parser.js";
import type { CommandRegistry } from "./commands/registry.js";
import type {
  CommandContext,
  CommandResult,
} from "./commands/types.js";
import { applyCommandSessionRecord } from "./session-mutations.js";
import type {
  UserInputHandler,
  UserInputRequest,
} from "./user-input-tool.js";

export type RuntimeErrorCode =
  | "busy"
  | "cancelled"
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
  processes?: Pick<OwnedProcessManager, "interact">;
  dispose?(): Promise<void>;
}

export interface RuntimeSubmissionOptions {
  readonly images?: readonly ModelImageInput[];
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
  #activeSteering: TurnSteeringQueue | null = null;
  #activeQueuedTurns: QueuedTurnAdmissionQueue | null = null;
  readonly #queuedInvocations = new Map<string, HostInvocation>();
  #confirm: (message: string) => Promise<boolean>;
  #userInput: UserInputHandler | null = null;
  #session: SessionState | null;
  #workspace: WorkspaceShellState | null;
  #runner: CoordinatedRuntime | null;
  readonly #coordinator: RunCoordinator | null;
  #closed = false;
  #closePromise: Promise<void> | undefined;

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

  setUserInputHandler(handler: UserInputHandler): void {
    this.#userInput = handler;
  }

  requestUserInput(
    request: UserInputRequest,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (this.#closed || this.#userInput === null) {
      throw new RuntimeError("invalid_input", "User input is unavailable");
    }
    return this.#userInput({
      question: terminalSafeConfirmationText(request.question),
      options: request.options.map(terminalSafeConfirmationText),
    }, signal);
  }

  currentSignal(): AbortSignal {
    return this.#activeController?.signal ?? new AbortController().signal;
  }

  get canAcceptSteering(): boolean {
    return this.#activeSteering?.isOpen === true;
  }

  get canAcceptLiveInput(): boolean {
    return this.#activeSteering?.isOpen === true ||
      this.#activeQueuedTurns?.isOpen === true;
  }

  get hasActiveRun(): boolean {
    return this.#activeController !== null;
  }

  get activeTurnId(): string | null {
    return this.#activeSteering?.turnId ?? null;
  }

  cancel(): boolean {
    if (this.#activeController === null) {
      return false;
    }
    this.#activeSteering?.close();
    this.#activeQueuedTurns?.close("The active turn was cancelled");
    this.#activeController.abort();
    return true;
  }

  interactWithOwnedProcess(
    input: Omit<InteractWithOwnedProcessInput, "ownerId">,
  ): Promise<OwnedProcessSnapshot> {
    if (this.#closed || this.dependencies.processes === undefined) {
      throw new RuntimeError(
        "invalid_input",
        "Process session controls are unavailable",
      );
    }
    return this.dependencies.processes.interact({
      ...input,
      ownerId: this.session.id,
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.cancel();
    this.#closePromise = this.dependencies.dispose?.() ?? Promise.resolve();
    return this.#closePromise;
  }

  #commandContext(invocation: HostInvocation): CommandContext {
    const context: CommandContext = {
      session: this.session,
      invocation,
      now: () => this.dependencies.now?.() ?? new Date().toISOString(),
      confirm: (message) => this.confirm(message),
      cancelActiveRun: async () => this.cancel(),
      manageQueuedTurns: async (args) => {
        const result = await this.#manageQueuedTurns(args, invocation);
        context.session = this.session;
        return result;
      },
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

  #workspaceContext(invocation: HostInvocation): CommandContext {
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
      invocation,
      now: () => this.dependencies.now?.() ?? new Date().toISOString(),
      confirm: (message) => this.confirm(message),
      cancelActiveRun: async () => this.cancel(),
      manageQueuedTurns: async () => ({
        type: "message",
        level: "warning",
        text: "Connect a model before managing queued turns",
      }),
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
    invocation: HostInvocation,
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
          "/model [connection-id]        List saved models or start a fresh session",
          "/permissions [mode]           Set the next-session permission default",
          "/agents [profiles]            Explain modes or inspect agent profiles",
          "/skills [action]              Inspect Agent Skills or trust project skills",
          "/mcp                          Inspect MCP servers and project trust",
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
          "  RECURS_PROVIDER=<id> RECURS_MODEL=<id> RECURS_API_KEY=<key> recurs",
          "Codex delegates sign-in to its official runtime; local setup is credential-free; environment BYOK is ephemeral.",
        ].join("\n"),
      };
    }
    if (
      (name === "agents" || name === "agent") &&
      args.trim().toLowerCase() !== "profiles"
    ) {
      return {
        type: "message",
        level: args.trim().length === 0 ? "info" : "warning",
        text: args.trim().length === 0
          ? "Agent modes are session policy. Connect a model first; new sessions default to Balanced and currently inherit their pinned backend."
          : "Connect a model before changing the agent operating mode.",
      };
    }
    const allowed = new Set([
      "help",
      "permissions",
      "permission",
      "model",
      "agents",
      "agent",
      "skills",
      "mcp",
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
    const context = this.#workspaceContext(invocation);
    const result = await this.dependencies.commands.execute(
      { name, args },
      context,
    );
    if (context.session.id !== "workspace-shell") {
      this.#activateSession(context.session);
    }
    return result;
  }

  async #manageQueuedTurns(
    rawArgs: string,
    invocation: HostInvocation,
  ): Promise<CommandResult> {
    const session = this.#session;
    if (
      session === null || !isPinnedSessionState(session) ||
      session.backend.pin.kind !== "model_provider" ||
      session.agent.role !== "parent"
    ) {
      throw new RuntimeError(
        "invalid_input",
        "Queued turns require a pinned direct-provider parent session",
      );
    }
    const args = rawArgs.trim();
    if (this.#activeController !== null) {
      if (args.length === 0 || args === "list" || args === "resume" || args === "clear") {
        throw new RuntimeError(
          "busy",
          "Use /queue <prompt> during a run; inspect or recover the queue when idle",
        );
      }
      const queue = this.#activeQueuedTurns;
      if (queue === null) {
        throw new RuntimeError(
          "busy",
          "This active backend cannot durably queue another turn; wait or use /cancel",
        );
      }
      const id = randomUUID();
      const enqueued = queue.enqueue({
        id,
        prompt: args,
        at: this.dependencies.now?.() ?? new Date().toISOString(),
      });
      if (!enqueued.accepted) {
        if (enqueued.reason === "too_large") {
          throw new RuntimeError(
            "invalid_input",
            `Queued prompt exceeds ${MAX_QUEUED_TURN_BYTES} bytes`,
          );
        }
        if (enqueued.reason === "full") {
          throw new RuntimeError(
            "busy",
            `Turn queue is full (${MAX_PENDING_QUEUED_TURNS} pending prompts maximum)`,
          );
        }
        throw new RuntimeError("busy", "The active turn is already finishing");
      }
      this.#queuedInvocations.set(id, invocation);
      try {
        await enqueued.persisted;
      } catch (error) {
        this.#queuedInvocations.delete(id);
        throw new RuntimeError(
          "busy",
          error instanceof Error ? error.message : "Queued prompt was not persisted",
        );
      }
      const durable = await this.dependencies.sessions.loadState(session.id);
      const pending = isPinnedSessionState(durable)
        ? durable.queuedTurns.length
        : 0;
      return {
        type: "message",
        level: "info",
        text: `Queued separate turn ${id} (${pending}/${MAX_PENDING_QUEUED_TURNS})`,
      };
    }

    const reloaded = await this.dependencies.sessions.loadState(session.id);
    if (!isPinnedSessionState(reloaded)) {
      throw new RuntimeError("invalid_input", "Legacy sessions cannot queue turns");
    }
    this.#activateSession(reloaded);
    if (args.length === 0 || args === "list") {
      return reloaded.queuedTurns.length === 0
        ? { type: "message", level: "info", text: "No queued turns" }
        : {
            type: "message",
            level: "info",
            text: [
              `Queued turns: ${reloaded.queuedTurns.length}`,
              ...reloaded.queuedTurns.map((queued, index) =>
                `${index + 1}. ${queued.id} (${Buffer.byteLength(queued.prompt, "utf8")} bytes)`
              ),
            ].join("\n"),
          };
    }
    if (args === "resume") {
      const queued = reloaded.queuedTurns[0];
      return queued === undefined
        ? { type: "message", level: "warning", text: "No queued turns to resume" }
        : {
            type: "submit_queued_prompt",
            queuedInputId: queued.id,
            prompt: queued.prompt,
          };
    }
    if (args === "clear") {
      if (reloaded.queuedTurns.length === 0) {
        return { type: "message", level: "warning", text: "No queued turns to clear" };
      }
      if (!await this.confirm(
        `Clear ${reloaded.queuedTurns.length} durable queued turn${reloaded.queuedTurns.length === 1 ? "" : "s"}?`,
      )) {
        return { type: "message", level: "warning", text: "Queue unchanged" };
      }
      await this.dependencies.sessions.withSessionMutation(
        reloaded.id,
        reloaded.lastSequence,
        async (mutation) => {
          await mutation.append({
            type: "prompt_queue_cleared",
            queuedInputIds: reloaded.queuedTurns.map((queued) => queued.id),
            at: this.dependencies.now?.() ?? new Date().toISOString(),
          });
        },
      );
      this.#queuedInvocations.clear();
      this.#activateSession(await this.dependencies.sessions.loadState(reloaded.id));
      return { type: "message", level: "info", text: "Cleared queued turns" };
    }
    if (Buffer.byteLength(args, "utf8") > MAX_QUEUED_TURN_BYTES) {
      throw new RuntimeError(
        "invalid_input",
        `Queued prompt exceeds ${MAX_QUEUED_TURN_BYTES} bytes`,
      );
    }
    if (reloaded.queuedTurns.length >= MAX_PENDING_QUEUED_TURNS) {
      throw new RuntimeError(
        "busy",
        `Turn queue is full (${MAX_PENDING_QUEUED_TURNS} pending prompts maximum)`,
      );
    }
    await this.dependencies.sessions.withSessionMutation(
      reloaded.id,
      reloaded.lastSequence,
      async (mutation) => {
        await mutation.append({
          type: "prompt_queued",
          queuedInputId: randomUUID(),
          prompt: args,
          at: this.dependencies.now?.() ?? new Date().toISOString(),
        });
      },
    );
    const updated = await this.dependencies.sessions.loadState(reloaded.id);
    this.#activateSession(updated);
    const pending = isPinnedSessionState(updated) ? updated.queuedTurns.length : 0;
    return {
      type: "message",
      level: "info",
      text: `Queued turn for explicit resume (${pending}/${MAX_PENDING_QUEUED_TURNS})`,
    };
  }

  async #runPrompt(
    prompt: string,
    executionMode?: "act" | "plan",
    invocation: HostInvocation = untrustedProgrammaticInvocation(),
    queuedInputId?: string,
    resumePersistedQueue = false,
    images?: readonly ModelImageInput[],
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
    if (
      isPinnedSessionState(this.#session) &&
      this.#session.queuedTurns.length > 0 &&
      queuedInputId === undefined
    ) {
      throw new RuntimeError(
        "busy",
        "Pending queued turns must be resumed with /queue resume or cleared before starting new work",
      );
    }
    this.#activeController = new AbortController();
    let nextPrompt = prompt;
    let nextInvocation = invocation;
    let nextQueuedInputId = queuedInputId;
    let nextExecutionMode = executionMode;
    let nextImages = images;
    let result: RunResult | undefined;
    const resumeAllPersisted = resumePersistedQueue || queuedInputId !== undefined;
    try {
      for (;;) {
        const direct = isPinnedSessionState(this.#session) &&
          this.#session.backend.pin.kind === "model_provider";
        const directParent = isPinnedSessionState(this.#session) &&
          this.#session.backend.pin.kind === "model_provider" &&
          this.#session.agent.role === "parent";
        const turnId = randomUUID();
        const steering = direct ? new TurnSteeringQueue(turnId) : null;
        const queuedTurns = directParent
          ? new QueuedTurnAdmissionQueue(turnId)
          : null;
        this.#activeSteering = steering;
        this.#activeQueuedTurns = queuedTurns;
        try {
          result = await this.#runner.run(
            nextPrompt,
            nextInvocation,
            this.#activeController.signal,
            nextExecutionMode,
            steering ?? undefined,
            queuedTurns ?? undefined,
            nextQueuedInputId,
            nextImages,
          );
          this.#session = this.#runner.session;
        } finally {
          steering?.close();
          queuedTurns?.close();
          if (this.#activeSteering === steering) this.#activeSteering = null;
          if (this.#activeQueuedTurns === queuedTurns) {
            this.#activeQueuedTurns = null;
          }
        }
        nextImages = undefined;

        const queued = isPinnedSessionState(this.#session)
          ? this.#session.queuedTurns[0]
          : undefined;
        if (queued === undefined) break;
        const queuedInvocation = resumeAllPersisted
          ? invocation
          : this.#queuedInvocations.get(queued.id);
        if (queuedInvocation === undefined) break;
        this.#queuedInvocations.delete(queued.id);
        nextPrompt = queued.prompt;
        nextInvocation = queuedInvocation;
        nextQueuedInputId = queued.id;
        nextExecutionMode = undefined;
      }
      if (result === undefined) {
        throw new RuntimeError("busy", "The agent run did not produce a result");
      }
      return result;
    } catch (error) {
      this.#queuedInvocations.clear();
      try {
        this.#activateSession(
          await this.dependencies.sessions.loadState(this.#session.id),
        );
      } catch {
        // Preserve the original run failure when recovery itself fails.
      }
      throw error;
    } finally {
      this.#activeSteering?.close();
      this.#activeQueuedTurns?.close();
      this.#activeSteering = null;
      this.#activeQueuedTurns = null;
      this.#activeController = null;
    }
  }

  async submit(
    input: string,
    invocation: HostInvocation = untrustedProgrammaticInvocation(),
    options: RuntimeSubmissionOptions = {},
  ): Promise<CommandResult | RunResult> {
    if (this.#closed) {
      throw new RuntimeError("busy", "Runtime is closed");
    }
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      throw new RuntimeError("invalid_input", "Input cannot be empty");
    }
    const parsed = parseCommand(trimmed);
    if (parsed !== null) {
      if (options.images !== undefined) {
        throw new RuntimeError(
          "invalid_input",
          "Image input can accompany an agent prompt, not a slash command",
        );
      }
      if (this.#workspace !== null) {
        return this.#submitWorkspaceCommand(parsed.name, parsed.args, invocation);
      }
      if (
        this.#activeController !== null &&
        parsed.name !== "cancel" &&
        parsed.name !== "status" &&
        parsed.name !== "help" &&
        parsed.name !== "queue"
      ) {
        throw new RuntimeError(
          "busy",
          "Only /cancel, /status, /help, and /queue are available during an active run",
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
        this.#activeController === null &&
        parsed.name !== "cancel" && parsed.name !== "queue";
      if (ownsController) {
        this.#activeController = new AbortController();
      }
      const context = this.#commandContext(invocation);
      let result: CommandResult;
      try {
        result = await this.dependencies.commands.execute(parsed, context);
        if (this.#activeController === null || ownsController) {
          this.#activateSession(context.session);
        }
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
      if (result.type === "submit_queued_prompt") {
        return this.#runPrompt(
          result.prompt,
          undefined,
          invocation,
          result.queuedInputId,
          true,
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
    if (this.#activeController !== null) {
      if (options.images !== undefined) {
        throw new RuntimeError(
          "invalid_input",
          "Image input cannot be queued as same-turn steering",
        );
      }
      const steering = this.#activeSteering;
      if (steering === null) {
        throw new RuntimeError(
          "busy",
          "This active backend cannot accept same-turn steering; wait or use /cancel",
        );
      }
      const enqueued = steering.enqueue({
        id: randomUUID(),
        prompt: trimmed,
        at: this.dependencies.now?.() ?? new Date().toISOString(),
      });
      if (!enqueued.accepted) {
        if (enqueued.reason === "too_large") {
          throw new RuntimeError(
            "invalid_input",
            `Steering input exceeds ${MAX_STEERING_INPUT_BYTES} bytes`,
          );
        }
        if (enqueued.reason === "full") {
          throw new RuntimeError(
            "busy",
            `Steering queue is full (${MAX_PENDING_STEERING_INPUTS} pending inputs maximum)`,
          );
        }
        throw new RuntimeError("busy", "The active turn is already finishing");
      }
      return {
        type: "message",
        level: "info",
        text: `Steering queued for turn ${steering.turnId} (${enqueued.pending}/${MAX_PENDING_STEERING_INPUTS})`,
      };
    }
    return this.#runPrompt(
      trimmed,
      undefined,
      invocation,
      undefined,
      false,
      options.images,
    );
  }
}

export function isCancellation(error: unknown): boolean {
  return (error instanceof AgentLoopError && error.code === "cancelled") ||
    (error instanceof CoordinatedRunError && error.failure.code === "cancelled");
}
