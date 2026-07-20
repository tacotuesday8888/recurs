import type {
  ConnectionBoundModelProvider,
  DirectContinuationHandle,
  ProviderBackedMessage,
  ProviderEvent,
  ProviderRequest,
} from "@recurs/contracts";

import { CredentialEchoGuard } from "./credential-echo-guard.js";
import { NATIVE_TOOL_USE_PROFILE } from "./harness-profile.js";
import { environmentByokManifest } from "./environment-provider-policy.js";
import { retryAfterOptions } from "./retry-after.js";
import { ProviderError } from "./types.js";

const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_EVENTS = 8_192;
const MAX_OUTPUT_ITEMS = 128;
const MAX_INPUT_ITEMS = 1_024;
const MAX_TOOLS = 128;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_SCHEMA_BYTES = 64 * 1024;
const MAX_STORED_BYTES = 64 * 1024 * 1024;
const MAX_STORED_HANDLES = 512;
const MAX_OUTPUT_TOKENS = 8_192;

type Fetch = typeof globalThis.fetch;
type JsonObject = Record<string, unknown>;

interface StoredContinuation {
  readonly handle: DirectContinuationHandle;
  readonly items: readonly JsonObject[];
  readonly bytes: number;
}

interface PartialOutputItem {
  readonly id: string;
  readonly type: "message" | "function_call" | "reasoning";
  readonly callId?: string;
  readonly name?: string;
  arguments: string;
  text: string;
  refusal: string;
  reasoning: string;
  argumentsDone: boolean;
  textDone: boolean;
  refusalDone: boolean;
  reasoningDone: boolean;
  done: boolean;
}

interface DecodedCompletion {
  readonly outputItems: readonly JsonObject[];
  readonly usage: { inputTokens: number; outputTokens: number } | null;
  readonly stopReason: "complete" | "tool_calls" | "length";
}

export interface RemoteOpenAIResponsesProviderOptions {
  readonly connectionId: string;
  readonly apiKey: string;
  readonly fetch?: Fetch;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validIdentifier(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x21 && code <= 0x7e;
    });
}

function validToolName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
}

function validPrivateValue(value: string): boolean {
  return value.length > 0 && value.length <= 8_192 &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    });
}

function invalid(message = "OpenAI returned an invalid Responses stream"): ProviderError {
  return new ProviderError("invalid_response", message, false);
}

function requestFailure(signal: AbortSignal): ProviderError {
  return signal.aborted
    ? new ProviderError("cancelled", "OpenAI request was cancelled", false)
    : new ProviderError("transport", "Could not reach OpenAI", true);
}

function responseFailure(response: Response): ProviderError {
  if (response.status === 401 || response.status === 403) {
    return new ProviderError("authentication", "OpenAI authentication failed", false);
  }
  if (response.status === 429) {
    return new ProviderError(
      "rate_limit",
      "OpenAI rate limit reached",
      true,
      retryAfterOptions(response.headers),
    );
  }
  if (response.status === 413) {
    return new ProviderError("context_overflow", "OpenAI request was too large", false);
  }
  if (response.status >= 300 && response.status < 400) {
    return new ProviderError("transport", "OpenAI attempted an unsupported redirect", false);
  }
  return new ProviderError(
    "transport",
    `OpenAI returned HTTP ${response.status}`,
    response.status >= 500,
    retryAfterOptions(response.headers),
  );
}

function reviewedEndpoint(): string {
  const manifest = environmentByokManifest("openai-api");
  const endpoint = manifest?.endpoints.find((candidate) => candidate.kind === "origin");
  if (
    manifest?.protocol !== "openai_responses" ||
    endpoint?.value !== "https://api.openai.com/v1"
  ) {
    throw new TypeError("OpenAI does not have a reviewed Responses endpoint");
  }
  return `${endpoint.value}/responses`;
}

function parseArguments(value: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalid("OpenAI returned invalid tool arguments");
  }
  if (!isRecord(parsed)) throw invalid("OpenAI returned invalid tool arguments");
  return parsed;
}

function encodeArguments(value: unknown): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw invalid("Tool arguments are invalid");
  }
  if (encoded === undefined) throw invalid("Tool arguments are invalid");
  parseArguments(encoded);
  return encoded;
}

function canonicalContent(raw: unknown): readonly JsonObject[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 128) throw invalid();
  return raw.map((part): JsonObject => {
    if (!isRecord(part)) throw invalid();
    if (part.type === "output_text" && typeof part.text === "string") {
      return { type: "output_text", text: part.text, annotations: [] };
    }
    if (part.type === "refusal" && typeof part.refusal === "string") {
      return { type: "refusal", refusal: part.refusal };
    }
    throw invalid();
  });
}

function canonicalOutputItem(raw: unknown): JsonObject {
  if (!isRecord(raw) || !validIdentifier(raw.id) ||
    (raw.status !== "completed" && raw.status !== "incomplete") ||
    typeof raw.type !== "string") throw invalid();
  if (raw.type === "message") {
    if (raw.role !== "assistant") throw invalid();
    const item: JsonObject = {
      id: raw.id,
      type: "message",
      status: raw.status,
      role: "assistant",
      content: canonicalContent(raw.content),
    };
    if (raw.phase !== undefined && raw.phase !== null) {
      if (raw.phase !== "commentary" && raw.phase !== "final_answer") throw invalid();
      item.phase = raw.phase;
    }
    return item;
  }
  if (raw.type === "function_call") {
    if (raw.status !== "completed" || !validIdentifier(raw.call_id) ||
      !validToolName(raw.name) || typeof raw.arguments !== "string") throw invalid();
    parseArguments(raw.arguments);
    return {
      id: raw.id,
      type: "function_call",
      status: "completed",
      call_id: raw.call_id,
      name: raw.name,
      arguments: raw.arguments,
    };
  }
  if (raw.type === "reasoning") {
    if (!Array.isArray(raw.summary) || raw.summary.length > 128) throw invalid();
    const summary = raw.summary.map((part): JsonObject => {
      if (!isRecord(part) || part.type !== "summary_text" || typeof part.text !== "string") {
        throw invalid();
      }
      return { type: "summary_text", text: part.text };
    });
    if (raw.encrypted_content !== undefined && raw.encrypted_content !== null &&
      typeof raw.encrypted_content !== "string") throw invalid();
    return {
      id: raw.id,
      type: "reasoning",
      status: raw.status,
      summary,
      ...(raw.encrypted_content === undefined
        ? {}
        : { encrypted_content: raw.encrypted_content }),
    };
  }
  throw invalid();
}

function contentText(item: JsonObject, type: "output_text" | "refusal"): string {
  const content = item.content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!isRecord(part) || part.type !== type) return "";
    return type === "output_text" ? String(part.text ?? "") : String(part.refusal ?? "");
  }).join("");
}

function summaryText(item: JsonObject): string {
  const summary = item.summary;
  if (!Array.isArray(summary)) return "";
  return summary.map((part) => isRecord(part) ? String(part.text ?? "") : "").join("");
}

class ResponsesDecoder {
  readonly #items: PartialOutputItem[] = [];
  readonly #outputItems: JsonObject[] = [];
  #responseId: string | null = null;
  #lastSequence: number | null = null;
  #terminal = false;
  #eventCount = 0;

  consume(block: string): ProviderEvent[] {
    if (new TextEncoder().encode(block).byteLength > MAX_EVENT_BYTES ||
      ++this.#eventCount > MAX_EVENTS || this.#terminal) throw invalid();
    const lines = block.replaceAll("\r\n", "\n").split("\n");
    if (lines.length !== 2 || !lines[0]?.startsWith("event: ") ||
      !lines[1]?.startsWith("data: ")) throw invalid();
    const eventName = lines[0].slice(7);
    let event: unknown;
    try {
      event = JSON.parse(lines[1].slice(6));
    } catch {
      throw invalid();
    }
    if (!isRecord(event) || event.type !== eventName || !safeInteger(event.sequence_number)) {
      throw invalid();
    }
    if (this.#lastSequence !== null && event.sequence_number !== this.#lastSequence + 1) {
      throw invalid();
    }
    this.#lastSequence = event.sequence_number;

    switch (eventName) {
      case "response.created": {
        if (this.#responseId !== null || !isRecord(event.response) ||
          !validIdentifier(event.response.id) ||
          (event.response.status !== "queued" && event.response.status !== "in_progress")) {
          throw invalid();
        }
        this.#responseId = event.response.id;
        return [];
      }
      case "response.queued":
      case "response.in_progress":
        this.#assertResponse(event.response, eventName.slice(9));
        return [];
      case "response.output_item.added":
        this.#addItem(event);
        return [];
      case "response.content_part.added":
      case "response.content_part.done":
      case "response.reasoning_summary_part.added":
      case "response.reasoning_summary_part.done":
        this.#assertItemEvent(event);
        return [];
      case "response.output_text.delta":
        return this.#delta(event, "message", "text", "text_delta");
      case "response.refusal.delta":
        return this.#delta(event, "message", "refusal", "text_delta");
      case "response.reasoning_summary_text.delta":
        return this.#delta(event, "reasoning", "reasoning", "reasoning_delta");
      case "response.output_text.done":
        this.#doneValue(event, "message", "text", "text");
        return [];
      case "response.refusal.done":
        this.#doneValue(event, "message", "refusal", "refusal");
        return [];
      case "response.reasoning_summary_text.done":
        this.#doneValue(event, "reasoning", "reasoning", "text");
        return [];
      case "response.function_call_arguments.delta": {
        const item = this.#correlated(event, "function_call");
        if (item.argumentsDone || typeof event.delta !== "string") throw invalid();
        item.arguments += event.delta;
        return [];
      }
      case "response.function_call_arguments.done": {
        const item = this.#correlated(event, "function_call");
        if (item.argumentsDone || event.name !== item.name ||
          typeof event.arguments !== "string" || event.arguments !== item.arguments) throw invalid();
        parseArguments(event.arguments);
        item.argumentsDone = true;
        return [];
      }
      case "response.output_item.done": {
        const item = this.#correlated(event);
        if (item.done) throw invalid();
        const canonical = canonicalOutputItem(event.item);
        if (canonical.id !== item.id || canonical.type !== item.type) throw invalid();
        if (item.type === "function_call") {
          if (canonical.call_id !== item.callId || canonical.name !== item.name ||
            canonical.arguments !== item.arguments || !item.argumentsDone) throw invalid();
        } else if (item.type === "message") {
          if (contentText(canonical, "output_text") !== item.text ||
            contentText(canonical, "refusal") !== item.refusal) throw invalid();
        } else if (summaryText(canonical) !== item.reasoning) throw invalid();
        item.done = true;
        this.#outputItems.push(canonical);
        if (item.type !== "function_call") return [];
        return [{
          type: "tool_call",
          call: {
            id: item.callId ?? "",
            name: item.name ?? "",
            arguments: parseArguments(item.arguments),
          },
        }];
      }
      case "response.completed":
        return this.#complete(event, false);
      case "response.incomplete":
        return this.#complete(event, true);
      case "response.failed":
      case "error":
        throw new ProviderError("transport", "OpenAI failed to complete the response", false);
      default:
        throw invalid();
    }
  }

  result(): DecodedCompletion {
    if (!this.#terminal) throw invalid("OpenAI stream ended without completion");
    const completion = this.#completion;
    if (completion === null) throw invalid();
    return completion;
  }

  #completion: DecodedCompletion | null = null;

  #assertResponse(raw: unknown, status: string): JsonObject {
    if (!isRecord(raw) || raw.id !== this.#responseId || raw.status !== status) throw invalid();
    return raw;
  }

  #addItem(event: JsonObject): void {
    if (!safeInteger(event.output_index) || event.output_index !== this.#items.length ||
      this.#items.length >= MAX_OUTPUT_ITEMS || !isRecord(event.item) ||
      !validIdentifier(event.item.id) || event.item.status !== "in_progress" ||
      (event.item.type !== "message" && event.item.type !== "function_call" &&
        event.item.type !== "reasoning")) throw invalid();
    const rawItem = event.item;
    const id = String(rawItem.id);
    const type = rawItem.type as PartialOutputItem["type"];
    if (this.#items.some((item) => item.id === id)) throw invalid();
    if (type === "message" && (rawItem.role !== "assistant" ||
      !Array.isArray(rawItem.content) || rawItem.content.length !== 0)) throw invalid();
    if (type === "reasoning" &&
      (!Array.isArray(rawItem.summary) || rawItem.summary.length !== 0)) throw invalid();
    if (type === "function_call" && (!validIdentifier(rawItem.call_id) ||
      !validToolName(rawItem.name) || rawItem.arguments !== "" ||
      this.#items.some((item) => item.callId === rawItem.call_id))) throw invalid();
    this.#items.push({
      id,
      type,
      ...(type === "function_call"
        ? { callId: String(rawItem.call_id), name: String(rawItem.name) }
        : {}),
      arguments: "",
      text: "",
      refusal: "",
      reasoning: "",
      argumentsDone: false,
      textDone: false,
      refusalDone: false,
      reasoningDone: false,
      done: false,
    });
  }

  #correlated(
    event: JsonObject,
    type?: PartialOutputItem["type"],
  ): PartialOutputItem {
    const itemId = event.item_id ?? (isRecord(event.item) ? event.item.id : undefined);
    if (!safeInteger(event.output_index) || !this.#items[event.output_index] ||
      itemId !== this.#items[event.output_index]?.id) throw invalid();
    const item = this.#items[event.output_index];
    if (item === undefined || (type !== undefined && item.type !== type)) throw invalid();
    return item;
  }

  #assertItemEvent(event: JsonObject): void {
    const item = this.#correlated(event);
    if (item.done || !isRecord(event.part)) throw invalid();
  }

  #delta(
    event: JsonObject,
    type: PartialOutputItem["type"],
    field: "text" | "refusal" | "reasoning",
    eventType: "text_delta" | "reasoning_delta",
  ): ProviderEvent[] {
    const item = this.#correlated(event, type);
    if (item.done || item[`${field}Done` as "textDone"] || typeof event.delta !== "string") {
      throw invalid();
    }
    item[field] += event.delta;
    return event.delta.length === 0 ? [] : [{ type: eventType, text: event.delta }];
  }

  #doneValue(
    event: JsonObject,
    type: PartialOutputItem["type"],
    field: "text" | "refusal" | "reasoning",
    valueKey: "text" | "refusal",
  ): void {
    const item = this.#correlated(event, type);
    const doneKey = `${field}Done` as "textDone" | "refusalDone" | "reasoningDone";
    if (item[doneKey] || event[valueKey] !== item[field]) throw invalid();
    item[doneKey] = true;
  }

  #complete(event: JsonObject, incomplete: boolean): ProviderEvent[] {
    const response = this.#assertResponse(event.response, incomplete ? "incomplete" : "completed");
    if (this.#items.length === 0 || this.#items.some((item) => !item.done) ||
      this.#outputItems.length !== this.#items.length) throw invalid();
    if (!Array.isArray(response.output) || response.output.length !== this.#outputItems.length) {
      throw invalid();
    }
    for (let index = 0; index < response.output.length; index += 1) {
      const terminalItem = canonicalOutputItem(response.output[index]);
      if (JSON.stringify(terminalItem) !== JSON.stringify(this.#outputItems[index])) {
        throw invalid();
      }
    }
    let usage: DecodedCompletion["usage"] = null;
    if (response.usage !== undefined && response.usage !== null) {
      if (!isRecord(response.usage) || !safeInteger(response.usage.input_tokens) ||
        !safeInteger(response.usage.output_tokens)) throw invalid();
      usage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    }
    let stopReason: DecodedCompletion["stopReason"] = this.#items.some(
      (item) => item.type === "function_call",
    ) ? "tool_calls" : "complete";
    if (incomplete) {
      const details = response.incomplete_details;
      if (!isRecord(details) || details.reason !== "max_output_tokens") {
        throw new ProviderError("invalid_response", "OpenAI did not complete the response", false);
      }
      stopReason = "length";
    }
    this.#completion = { outputItems: [...this.#outputItems], usage, stopReason };
    this.#terminal = true;
    return [];
  }
}

function encodeMessage(
  message: ProviderBackedMessage,
  load: (handle: DirectContinuationHandle) => readonly JsonObject[],
): readonly JsonObject[] {
  if (message.role === "assistant" && message.providerStateHandle !== undefined) {
    return load(message.providerStateHandle);
  }
  if (message.role === "tool") {
    if (!validIdentifier(message.toolCallId)) throw invalid("Tool result identity is invalid");
    return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
  }
  const items: JsonObject[] = [];
  if (message.content.length > 0 || message.role !== "assistant" ||
    (message.toolCalls?.length ?? 0) === 0) {
    items.push({ type: "message", role: message.role, content: message.content });
  }
  for (const call of message.toolCalls ?? []) {
    if (!validIdentifier(call.id) || !validToolName(call.name)) {
      throw invalid("Tool call identity is invalid");
    }
    items.push({
      type: "function_call",
      call_id: call.id,
      name: call.name,
      arguments: encodeArguments(call.arguments),
    });
  }
  return items;
}

function requestBody(
  request: ProviderRequest,
  load: (handle: DirectContinuationHandle) => readonly JsonObject[],
): JsonObject {
  const input = request.messages.flatMap((message) =>
    encodeMessage(message as ProviderBackedMessage, load)
  );
  if (input.length === 0 || input.length > MAX_INPUT_ITEMS ||
    request.tools.length > MAX_TOOLS ||
    new Set(request.tools.map((tool) => tool.name)).size !== request.tools.length) {
    throw new ProviderError("context_overflow", "OpenAI request exceeded its limits", false);
  }
  for (const tool of request.tools) {
    if (!validToolName(tool.name) ||
      new TextEncoder().encode(tool.description).byteLength > 1_024 ||
      new TextEncoder().encode(JSON.stringify(tool.inputSchema)).byteLength >
        MAX_TOOL_SCHEMA_BYTES) {
      throw invalid("OpenAI tool definition is invalid");
    }
  }
  return {
    model: request.model,
    input,
    tools: request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    })),
    tool_choice: "auto",
    parallel_tool_calls: true,
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    max_output_tokens: MAX_OUTPUT_TOKENS,
  };
}

export class RemoteOpenAIResponsesProvider implements ConnectionBoundModelProvider {
  readonly id = "openai-api";
  readonly adapterId = "openai-responses";
  readonly harnessProfile = NATIVE_TOOL_USE_PROFILE;
  readonly connectionId: string;
  readonly #apiKey: string;
  readonly #fetch: Fetch;
  readonly #endpoint: string;
  readonly #ownerInstanceId = globalThis.crypto.randomUUID();
  readonly #continuations = new Map<string, StoredContinuation>();
  #storedBytes = 0;

  constructor(options: RemoteOpenAIResponsesProviderOptions) {
    if (!validIdentifier(options.connectionId, 128) || !validPrivateValue(options.apiKey)) {
      throw new TypeError("OpenAI Responses connection is invalid");
    }
    this.connectionId = options.connectionId;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#endpoint = reviewedEndpoint();
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const load = (handle: DirectContinuationHandle): readonly JsonObject[] =>
      this.#loadContinuation(handle, request);
    const messages = this.#recoverCompletedHistory(request);
    let body: string;
    try {
      body = JSON.stringify(requestBody({ ...request, messages }, load));
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw invalid("OpenAI request was invalid");
    }
    if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
      throw new ProviderError("context_overflow", "OpenAI request was too large", false);
    }
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        redirect: "manual",
        signal: request.signal,
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body,
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw requestFailure(request.signal);
    }
    if (!response.ok) throw responseFailure(response);
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
      throw invalid("OpenAI response had an invalid content type");
    }
    const reader = response.body?.getReader();
    if (reader === undefined) throw invalid("OpenAI response had no body");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const stream = new ResponsesDecoder();
    const echoGuard = new CredentialEchoGuard(this.#apiKey);
    let buffer = "";
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        echoGuard.inspect(chunk.value);
        bytes += chunk.value.byteLength;
        if (bytes > MAX_STREAM_BYTES) {
          await reader.cancel();
          throw invalid("OpenAI response was too large");
        }
        try {
          buffer += decoder.decode(chunk.value, { stream: true });
        } catch {
          throw invalid("OpenAI response was not valid UTF-8");
        }
        const blocks = buffer.split(/\r?\n\r?\n/u);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          if (block.length === 0) continue;
          yield* stream.consume(block);
        }
      }
      try {
        buffer += decoder.decode();
      } catch {
        throw invalid("OpenAI response was not valid UTF-8");
      }
      if (buffer.trim().length > 0) yield* stream.consume(buffer.trimEnd());
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw requestFailure(request.signal);
    } finally {
      reader.releaseLock();
    }
    const completion = stream.result();
    if (completion.usage !== null) yield { type: "usage", ...completion.usage };
    const handle = this.#storeContinuation(completion.outputItems, request);
    if (handle !== null) yield { type: "provider_state", handle };
    yield { type: "done", stopReason: completion.stopReason };
  }

  #loadContinuation(
    handle: DirectContinuationHandle,
    request: ProviderRequest,
  ): readonly JsonObject[] {
    const stored = this.#continuations.get(handle.id);
    if (stored === undefined || !this.#continuationAvailable(handle, request, stored)) {
      throw new ProviderError(
        "invalid_response",
        "OpenAI continuation state is unavailable in this process",
        false,
      );
    }
    return stored.items;
  }

  #continuationAvailable(
    handle: DirectContinuationHandle,
    request: ProviderRequest,
    stored = this.#continuations.get(handle.id),
  ): stored is StoredContinuation {
    const authorization = request.directContext?.authorization;
    return authorization !== undefined && stored !== undefined &&
      handle.storageClass === "process_scoped" &&
      handle.ownerInstanceId === this.#ownerInstanceId &&
      handle.connectionId === this.connectionId && handle.adapterId === this.adapterId &&
      handle.modelId === request.model &&
      handle.backendFingerprint === authorization.backendFingerprint &&
      handle.recursSessionId === authorization.sessionId && handle.status === "committed" &&
      stored.handle.originTurnId === handle.originTurnId &&
      stored.handle.continuationSequence === handle.continuationSequence;
  }

  #recoverCompletedHistory(request: ProviderRequest): readonly ProviderBackedMessage[] {
    let boundary = -1;
    for (let index = 0; index < request.messages.length; index += 1) {
      const message = request.messages[index] as ProviderBackedMessage | undefined;
      const handle = message?.providerStateHandle;
      if (handle === undefined || this.#continuationAvailable(handle, request)) continue;
      if (!this.#recoverableExpiredContinuation(handle, request)) {
        this.#loadContinuation(handle, request);
      }
      const completed = request.messages.findIndex((candidate, candidateIndex) =>
        candidateIndex > index && candidate.role === "assistant" &&
        (candidate.toolCalls?.length ?? 0) === 0 && candidate.content.length > 0 &&
        (candidate as ProviderBackedMessage).providerStateHandle === undefined
      );
      if (completed === -1) this.#loadContinuation(handle, request);
      boundary = Math.max(boundary, completed);
      index = completed;
    }
    if (boundary === -1) return request.messages as readonly ProviderBackedMessage[];
    const leadingSystem = request.messages.slice(
      0,
      request.messages.findIndex((message) => message.role !== "system") === -1
        ? request.messages.length
        : request.messages.findIndex((message) => message.role !== "system"),
    );
    return [
      ...leadingSystem,
      ...(request.messages.slice(boundary) as readonly ProviderBackedMessage[]),
    ];
  }

  #recoverableExpiredContinuation(
    handle: DirectContinuationHandle,
    request: ProviderRequest,
  ): boolean {
    const authorization = request.directContext?.authorization;
    return authorization !== undefined && !this.#continuations.has(handle.id) &&
      handle.storageClass === "process_scoped" &&
      handle.ownerInstanceId !== undefined && handle.ownerInstanceId !== this.#ownerInstanceId &&
      handle.connectionId === this.connectionId && handle.adapterId === this.adapterId &&
      handle.modelId === request.model &&
      handle.backendFingerprint === authorization.backendFingerprint &&
      handle.recursSessionId === authorization.sessionId && handle.status === "committed";
  }

  #storeContinuation(
    items: readonly JsonObject[],
    request: ProviderRequest,
  ): DirectContinuationHandle | null {
    if (!items.some((item) => item.type === "function_call")) return null;
    const authorization = request.directContext?.authorization;
    if (authorization === undefined || authorization.turnId === null ||
      authorization.operation !== "run" || authorization.connectionId !== this.connectionId ||
      authorization.modelId !== request.model) return null;
    const bytes = new TextEncoder().encode(JSON.stringify(items)).byteLength;
    if (this.#continuations.size >= MAX_STORED_HANDLES ||
      this.#storedBytes + bytes > MAX_STORED_BYTES) {
      throw invalid("OpenAI process continuation storage is full");
    }
    const previousSequence = request.messages.reduce((maximum, message) =>
      Math.max(
        maximum,
        (message as ProviderBackedMessage).providerStateHandle?.continuationSequence ?? 0,
      ), 0);
    const handle: DirectContinuationHandle = {
      kind: "direct",
      id: globalThis.crypto.randomUUID(),
      storageClass: "process_scoped",
      ownerInstanceId: this.#ownerInstanceId,
      recursSessionId: authorization.sessionId,
      connectionId: this.connectionId,
      adapterId: this.adapterId,
      modelId: request.model,
      backendFingerprint: authorization.backendFingerprint,
      stateVersion: 1,
      originTurnId: authorization.turnId,
      continuationSequence: previousSequence + 1,
      status: "committed",
    };
    const stored: StoredContinuation = {
      handle,
      items: structuredClone(items),
      bytes,
    };
    this.#continuations.set(handle.id, stored);
    this.#storedBytes += bytes;
    return handle;
  }
}
