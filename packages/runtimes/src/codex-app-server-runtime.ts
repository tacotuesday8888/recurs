import { randomUUID } from "node:crypto";

import {
  RECURS_VERSION,
  type AgentRunRequest,
  type AgentRuntime,
  type AgentRuntimeEvent,
  type AgentRuntimeHost,
  type IntegrationFailure,
  type ModelReasoningEffort,
  type RuntimeCapabilities,
  type RuntimeContinuationStore,
  type ToolDefinition,
} from "@recurs/contracts";
import { z } from "zod";

import {
  CodexAppServerProtocolError,
  createCodexAppServerClient,
  type CodexAppServerClient,
  type CodexAppServerMessage,
  type CodexAppServerProcessProfile,
  type CodexAppServerRequest,
} from "./codex-app-server-protocol.js";
import {
  CodexAppServerCatalogError,
  codexSubscriptionAccountFingerprint,
  createCodexAppServerProcessProfile,
} from "./codex-app-server-catalog.js";

export const CODEX_APP_SERVER_ADAPTER_ID = "codex-app-server";
export const CODEX_APP_SERVER_PROFILE_REVISION =
  "codex-app-server-0.144.0-host-tools-v1";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;
const MAX_TOOLS = 128;
const MAX_FINAL_TEXT_BYTES = 4 * 1_024 * 1_024;

const accountSchema = z.object({
  account: z.object({
    type: z.literal("chatgpt"),
    email: z.string().email().max(320).nullable(),
    planType: z.string().min(1).max(64),
  }).nullable(),
  requiresOpenaiAuth: z.boolean(),
});
const initializeSchema = z.object({
  userAgent: z.string().min(1).max(512),
  codexHome: z.string().min(1).max(4_096),
  platformFamily: z.string().min(1).max(64),
  platformOs: z.string().min(1).max(64),
});
const threadStartSchema = z.object({
  thread: z.object({ id: z.string().min(1).max(1_024) }),
  model: z.string().min(1).max(256),
  reasoningEffort: z.string().max(64).nullable(),
});
const turnStartSchema = z.object({
  turn: z.object({ id: z.string().min(1).max(1_024) }),
});
const dynamicToolRequestSchema = z.object({
  threadId: z.string().min(1).max(1_024),
  turnId: z.string().min(1).max(1_024),
  callId: z.string().min(1).max(1_024),
  namespace: z.string().max(256).nullable(),
  tool: z.string().min(1).max(256),
  arguments: z.unknown(),
});
const textDeltaSchema = z.object({
  threadId: z.string().min(1).max(1_024),
  turnId: z.string().min(1).max(1_024),
  itemId: z.string().min(1).max(1_024),
  delta: z.string().max(1_024 * 1_024),
});
const usageSchema = z.object({
  threadId: z.string().min(1).max(1_024),
  turnId: z.string().min(1).max(1_024),
  tokenUsage: z.object({
    last: z.object({
      inputTokens: z.number().int().nonnegative(),
      cachedInputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      reasoningOutputTokens: z.number().int().nonnegative(),
    }),
  }),
});
const turnCompletedSchema = z.object({
  threadId: z.string().min(1).max(1_024),
  turn: z.object({
    id: z.string().min(1).max(1_024),
    status: z.enum(["completed", "interrupted", "failed"]),
    error: z.object({ message: z.string().max(4_096) }).nullable(),
  }),
});
const itemLifecycleSchema = z.object({
  threadId: z.string().min(1).max(1_024),
  turnId: z.string().min(1).max(1_024),
  item: z.object({
    id: z.string().min(1).max(1_024),
    type: z.string().min(1).max(128),
    tool: z.string().min(1).max(256).optional(),
    status: z.string().max(128).optional(),
    text: z.string().max(MAX_FINAL_TEXT_BYTES).optional(),
  }).passthrough(),
});

interface Terminal {
  readonly status: "completed" | "interrupted" | "failed";
  readonly message?: string;
}

class EventQueue implements AsyncIterable<AgentRuntimeEvent> {
  readonly #events: AgentRuntimeEvent[] = [];
  readonly #waiters: Array<() => void> = [];
  #closed = false;

  push(event: AgentRuntimeEvent): void {
    if (this.#closed) return;
    this.#events.push(event);
    this.#waiters.shift()?.();
  }

  close(): void {
    this.#closed = true;
    while (this.#waiters.length > 0) this.#waiters.shift()?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent> {
    while (!this.#closed || this.#events.length > 0) {
      const event = this.#events.shift();
      if (event !== undefined) {
        yield event;
        continue;
      }
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }
}

function failure(
  phase: "preflight" | "started",
  domain: IntegrationFailure["domain"],
  code: IntegrationFailure["code"],
  safeMessage: string,
): IntegrationFailure {
  return {
    domain,
    phase,
    code,
    safeMessage,
    diagnosticId: randomUUID(),
    retryable: code === "transport" || code === "timeout",
    ...(code === "authentication_required"
      ? { action: "reauthenticate" as const }
      : code === "account_mismatch"
        ? { action: "select_connection" as const }
        : {}),
  };
}

function mapFailure(error: unknown, phase: "preflight" | "started"): IntegrationFailure {
  if (error instanceof CodexAppServerCatalogError) {
    if (error.code === "authentication_required") {
      return failure(phase, "auth", "authentication_required",
        "The Codex connection requires ChatGPT sign-in");
    }
    if (error.code === "account_mismatch") {
      return failure(phase, "auth", "account_mismatch",
        "The active ChatGPT account does not match this Codex connection");
    }
    if (error.code === "cancelled") {
      return failure(phase, "runtime", "cancelled",
        "The Codex runtime was cancelled");
    }
  }
  if (error instanceof CodexAppServerProtocolError) {
    if (error.code === "cancelled") {
      return failure(phase, "runtime", "cancelled",
        "The Codex runtime was cancelled");
    }
    if (error.code === "timeout") {
      return failure(phase, "runtime", "timeout",
        "The Codex runtime timed out");
    }
    return failure(phase, "runtime", "transport",
      "The Codex app-server connection failed");
  }
  if (error instanceof z.ZodError) {
    return failure(phase, "runtime", "invalid_response",
      "Codex returned an invalid runtime response");
  }
  return failure(phase, "runtime", "runtime_failed",
    "The Codex runtime failed");
}

function validateTools(tools: readonly ToolDefinition[] | undefined): readonly ToolDefinition[] {
  const definitions = tools ?? [];
  const names = new Set<string>();
  if (
    definitions.length > MAX_TOOLS ||
    definitions.some((tool) =>
      !SAFE_ID.test(tool.name) ||
      tool.description.length > 4_096 ||
      names.has(tool.name) ||
      (names.add(tool.name), false)
    )
  ) {
    throw new TypeError("Codex app-server host tools are invalid");
  }
  return definitions;
}

function developerInstructions(executionMode: "act" | "plan"): string {
  return [
    "You are running inside the Recurs harness.",
    "Use only the tools supplied by Recurs in this thread.",
    "The Codex environment is intentionally disabled; do not attempt built-in shell, file-edit, MCP, plugin, app, browser, image, or Codex sub-agent operations.",
    "Never claim a change, command, or verification unless its Recurs tool returned evidence.",
    executionMode === "plan"
      ? "This is Plan mode: inspect and propose only; do not mutate the project."
      : "This is Act mode: stay within the bounded assigned task and supplied permissions.",
  ].join("\n");
}

export interface CreateCodexAppServerRuntimeInput {
  readonly connectionId: string;
  readonly modelId: string;
  readonly reasoningEffort: ModelReasoningEffort;
  readonly expectedAccountSubjectFingerprint: string;
  readonly store: RuntimeContinuationStore;
  readonly processProfile?: CodexAppServerProcessProfile;
}

export class CodexAppServerRuntime implements AgentRuntime {
  readonly adapterId = CODEX_APP_SERVER_ADAPTER_ID;
  readonly connectionId: string;
  readonly capabilityProfileRevision = CODEX_APP_SERVER_PROFILE_REVISION;
  readonly capabilities: RuntimeCapabilities = Object.freeze({
    resume: false,
    cancellation: "protocol",
    fileEvents: false,
    usageEvents: true,
    supportedPermissionModes: Object.freeze([
      "ask_always",
      "approved_for_me",
      "full_access",
    ] as const),
    approvalControl: "host",
    planMode: "enforced",
    toolExecution: "host_tools",
    checkpointing: "host_tools",
  });
  readonly #modelId: string;
  readonly #reasoningEffort: ModelReasoningEffort;
  readonly #expectedFingerprint: string;
  readonly #processProfile: CodexAppServerProcessProfile;

  constructor(input: CreateCodexAppServerRuntimeInput) {
    if (
      !SAFE_ID.test(input.connectionId) ||
      !SAFE_ID.test(input.modelId) ||
      !FINGERPRINT.test(input.expectedAccountSubjectFingerprint)
    ) {
      throw new TypeError("Codex app-server runtime binding is invalid");
    }
    this.connectionId = input.connectionId;
    this.#modelId = input.modelId;
    this.#reasoningEffort = input.reasoningEffort;
    this.#expectedFingerprint = input.expectedAccountSubjectFingerprint;
    this.#processProfile = input.processProfile ?? createCodexAppServerProcessProfile();
  }

  run(request: AgentRunRequest, host: AgentRuntimeHost): AsyncIterable<AgentRuntimeEvent> {
    const queue = new EventQueue();
    void this.#execute(request, host, queue).finally(() => queue.close());
    return queue;
  }

  async reconcile(): Promise<"gone"> {
    return "gone";
  }

  async #execute(
    request: AgentRunRequest,
    host: AgentRuntimeHost,
    queue: EventQueue,
  ): Promise<void> {
    let phase: "preflight" | "started" = "preflight";
    let client: CodexAppServerClient | null = null;
    let threadId: string | null = null;
    let turnId: string | null = null;
    let finalText = "";
    let terminalResolve!: (terminal: Terminal) => void;
    const terminal = new Promise<Terminal>((resolve) => {
      terminalResolve = resolve;
    });
    let terminalSeen = false;
    const resolveTerminal = (value: Terminal): void => {
      if (terminalSeen) return;
      terminalSeen = true;
      terminalResolve(value);
    };
    const tools = validateTools(host.tools);
    const toolNames = new Set(tools.map((tool) => tool.name));
    const pendingMessages: CodexAppServerMessage[] = [];
    let activeResolve!: () => void;
    const activeReady = new Promise<void>((resolve) => {
      activeResolve = resolve;
    });
    const appendText = (text: string): void => {
      if (Buffer.byteLength(finalText) + Buffer.byteLength(text) >
        MAX_FINAL_TEXT_BYTES) {
        throw new z.ZodError([]);
      }
      finalText += text;
    };
    const processMessage = (message: CodexAppServerMessage): void => {
      this.#onMessage(
        message,
        queue,
        () => ({ threadId, turnId }),
        appendText,
        resolveTerminal,
      );
    };

    try {
      if (
        request.signal.aborted ||
        request.modelId !== this.#modelId ||
        request.authorization.connectionId !== this.connectionId ||
        request.authorization.modelId !== this.#modelId ||
        request.continuation !== null ||
        request.continuationReader !== null
      ) {
        throw new TypeError("Codex app-server request binding is invalid");
      }
      client = createCodexAppServerClient(this.#processProfile, {
        onMessage: (message) => {
          if (turnId === null) {
            pendingMessages.push(message);
            return;
          }
          processMessage(message);
        },
        onRequest: async (incoming) => {
          await activeReady;
          return await this.#onRequest(
            incoming,
            host,
            toolNames,
            () => ({ threadId, turnId }),
            request.signal,
          );
        },
      });
      void client.closed.catch((error: unknown) => {
        resolveTerminal({ status: "failed", message: error instanceof Error
          ? error.message
          : "Codex app-server closed" });
      });
      initializeSchema.parse(await client.request("initialize", {
        clientInfo: { name: "recurs", title: "Recurs", version: RECURS_VERSION },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, request.signal));
      client.notify("initialized");
      const account = accountSchema.parse(await client.request(
        "account/read",
        { refreshToken: false },
        request.signal,
      ));
      if (account.account === null) {
        throw new CodexAppServerCatalogError(
          "authentication_required",
          "Codex requires ChatGPT sign-in",
        );
      }
      if (
        account.account.email === null ||
        codexSubscriptionAccountFingerprint(account.account.email) !==
          this.#expectedFingerprint
      ) {
        throw new CodexAppServerCatalogError(
          "account_mismatch",
          "Codex account binding changed",
        );
      }
      const thread = threadStartSchema.parse(await client.request(
        "thread/start",
        {
          model: this.#modelId,
          allowProviderModelFallback: false,
          cwd: request.cwd,
          approvalPolicy: "never",
          sandbox: "read-only",
          developerInstructions: developerInstructions(request.executionMode),
          ephemeral: true,
          environments: [],
          dynamicTools: tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            deferLoading: false,
          })),
          selectedCapabilityRoots: [],
        },
        request.signal,
      ));
      if (thread.model !== this.#modelId) {
        throw new TypeError("Codex selected a different model");
      }
      threadId = thread.thread.id;
      const started = turnStartSchema.parse(await client.request(
        "turn/start",
        {
          threadId,
          input: [{ type: "text", text: request.prompt, text_elements: [] }],
          environments: [],
          cwd: request.cwd,
          approvalPolicy: "never",
          model: this.#modelId,
          effort: this.#reasoningEffort,
        },
        request.signal,
      ));
      turnId = started.turn.id;
      phase = "started";
      activeResolve();
      queue.push({
        type: "activity",
        activity: {
          id: turnId,
          kind: "other",
          name: "codex_turn",
          status: "started",
        },
      });
      for (const message of pendingMessages.splice(0)) processMessage(message);
      const onAbort = (): void => {
        if (client !== null && threadId !== null && turnId !== null) {
          void client.request("turn/interrupt", { threadId, turnId })
            .catch(() => undefined);
        }
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      const completed = await terminal;
      request.signal.removeEventListener("abort", onAbort);
      if (request.signal.aborted || completed.status === "interrupted") {
        queue.push({ type: "cancelled", reason: "Codex turn was interrupted" });
      } else if (completed.status === "failed") {
        queue.push({
          type: "failed",
          failure: failure("started", "runtime", "runtime_failed",
            "The Codex turn failed"),
        });
      } else {
        queue.push({ type: "done", finalText, stopReason: "complete" });
      }
    } catch (error) {
      queue.push({ type: "failed", failure: mapFailure(error, phase) });
    } finally {
      activeResolve();
      await client?.close();
    }
  }

  async #onRequest(
    request: CodexAppServerRequest,
    host: AgentRuntimeHost,
    toolNames: ReadonlySet<string>,
    active: () => { readonly threadId: string | null; readonly turnId: string | null },
    signal: AbortSignal,
  ): Promise<unknown> {
    if (request.method !== "item/tool/call" || host.executeTool === undefined) {
      throw new TypeError("Unsupported Codex client request");
    }
    const call = dynamicToolRequestSchema.parse(request.params);
    const expected = active();
    if (
      call.threadId !== expected.threadId ||
      call.turnId !== expected.turnId ||
      call.namespace !== null ||
      !toolNames.has(call.tool) ||
      signal.aborted
    ) {
      throw new TypeError("Codex dynamic tool request is outside the active turn");
    }
    try {
      const result = await host.executeTool({
        id: call.callId,
        name: call.tool,
        arguments: call.arguments,
      }, signal);
      return {
        contentItems: [{ type: "inputText", text: result.output }],
        success: true,
      };
    } catch {
      return {
        contentItems: [{ type: "inputText", text: "Recurs rejected the tool call" }],
        success: false,
      };
    }
  }

  #onMessage(
    message: CodexAppServerMessage,
    queue: EventQueue,
    active: () => { readonly threadId: string | null; readonly turnId: string | null },
    appendText: (text: string) => void,
    resolveTerminal: (terminal: Terminal) => void,
  ): void {
    const expected = active();
    if (message.method === "item/agentMessage/delta") {
      const delta = textDeltaSchema.parse(message.params);
      if (delta.threadId !== expected.threadId || delta.turnId !== expected.turnId) return;
      appendText(delta.delta);
      queue.push({ type: "text_delta", text: delta.delta });
      return;
    }
    if (message.method === "item/reasoning/textDelta") {
      const delta = textDeltaSchema.parse(message.params);
      if (delta.threadId !== expected.threadId || delta.turnId !== expected.turnId) return;
      queue.push({ type: "reasoning_delta", text: delta.delta });
      return;
    }
    if (message.method === "thread/tokenUsage/updated") {
      const usage = usageSchema.parse(message.params);
      if (usage.threadId !== expected.threadId || usage.turnId !== expected.turnId) return;
      queue.push({
        type: "usage",
        usage: {
          inputTokens: usage.tokenUsage.last.inputTokens,
          outputTokens: usage.tokenUsage.last.outputTokens,
          cachedInputTokens: usage.tokenUsage.last.cachedInputTokens,
          reasoningTokens: usage.tokenUsage.last.reasoningOutputTokens,
        },
      });
      return;
    }
    if (message.method === "item/started" || message.method === "item/completed") {
      const lifecycle = itemLifecycleSchema.parse(message.params);
      if (
        lifecycle.threadId !== expected.threadId ||
        lifecycle.turnId !== expected.turnId
      ) return;
      if (["commandExecution", "fileChange", "mcpToolCall", "collabAgentToolCall"]
        .includes(lifecycle.item.type)) {
        throw new TypeError("Codex emitted a disabled built-in tool item");
      }
      if (lifecycle.item.type === "dynamicToolCall") {
        queue.push({
          type: "activity",
          activity: {
            id: lifecycle.item.id,
            kind: "tool",
            name: lifecycle.item.tool ?? "dynamic_tool",
            status: message.method === "item/started"
              ? "started"
              : lifecycle.item.status === "failed"
                ? "failed"
                : "completed",
          },
        });
      }
      return;
    }
    if (message.method === "turn/completed") {
      const completed = turnCompletedSchema.parse(message.params);
      if (
        completed.threadId === expected.threadId &&
        completed.turn.id === expected.turnId
      ) {
        resolveTerminal({
          status: completed.turn.status,
          ...(completed.turn.error === null
            ? {}
            : { message: completed.turn.error.message }),
        });
      }
    }
  }
}

export function createAccountBoundCodexAppServerRuntime(
  input: CreateCodexAppServerRuntimeInput,
): AgentRuntime {
  return new CodexAppServerRuntime(input);
}
