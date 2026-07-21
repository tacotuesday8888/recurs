import type { ClientRequest, IncomingMessage } from "node:http";

import type {
  ConnectionBoundModelProvider,
  DirectContinuationHandle,
  ProviderBackedMessage,
  ProviderEvent,
  ProviderRequest,
  ProviderUsage,
} from "@recurs/contracts";
import WebSocket from "ws";

import { CredentialEchoGuard } from "./credential-echo-guard.js";
import { NATIVE_TOOL_USE_PROFILE } from "./harness-profile.js";
import { environmentByokManifest } from "./environment-provider-policy.js";
import { retryAfterOptions } from "./retry-after.js";
import { ProviderError } from "./types.js";
import {
  imageDataUrl,
  validatedMessageImages,
  validateRequestImageBudget,
} from "./model-images.js";

const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_EVENTS = 8_192;
const MAX_OUTPUT_ITEMS = 128;
const MAX_INPUT_ITEMS = 1_024;
const MAX_TOOLS = 128;
const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_TOOL_SCHEMA_BYTES = 64 * 1024;
const MAX_STORED_BYTES = 64 * 1024 * 1024;
const MAX_STORED_HANDLES = 512;
const MAX_OUTPUT_TOKENS = 8_192;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const WEBSOCKET_CONNECT_TIMEOUT_MS = 10_000;
const REASONING_EFFORTS = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

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
  readonly usage: ProviderUsage | null;
  readonly stopReason: "complete" | "tool_calls" | "length";
}

export interface RemoteOpenAIResponsesProviderOptions {
  readonly connectionId: string;
  readonly apiKey: string;
  readonly fetch?: Fetch;
  readonly webSocketFactory?: ResponsesWebSocketFactory | null;
}

export type ResponsesWebSocketFactory = (
  url: string,
  options: WebSocket.ClientOptions,
) => WebSocket;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalSafeInteger(
  object: JsonObject,
  key: string,
): number | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (!safeInteger(value)) throw invalid("OpenAI returned invalid usage telemetry");
  return value;
}

function decodeUsage(value: unknown): ProviderUsage {
  if (!isRecord(value) || !safeInteger(value.input_tokens) ||
    !safeInteger(value.output_tokens)) {
    throw invalid("OpenAI returned invalid usage telemetry");
  }
  const usage: ProviderUsage = {
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
  };
  if (value.total_tokens !== undefined) {
    const total = usage.inputTokens + usage.outputTokens;
    if (!safeInteger(value.total_tokens) || !safeInteger(total) || value.total_tokens !== total) {
      throw invalid("OpenAI returned invalid usage telemetry");
    }
  }
  if (value.input_tokens_details !== undefined) {
    if (!isRecord(value.input_tokens_details)) {
      throw invalid("OpenAI returned invalid usage telemetry");
    }
    const cachedInputTokens = optionalSafeInteger(
      value.input_tokens_details,
      "cached_tokens",
    );
    const cacheWriteInputTokens = optionalSafeInteger(
      value.input_tokens_details,
      "cache_write_tokens",
    );
    if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
    if (cacheWriteInputTokens !== undefined) {
      usage.cacheWriteInputTokens = cacheWriteInputTokens;
    }
    const accounted = (cachedInputTokens ?? 0) + (cacheWriteInputTokens ?? 0);
    if (!safeInteger(accounted) || accounted > usage.inputTokens) {
      throw invalid("OpenAI returned invalid usage telemetry");
    }
  }
  if (value.output_tokens_details !== undefined) {
    if (!isRecord(value.output_tokens_details)) {
      throw invalid("OpenAI returned invalid usage telemetry");
    }
    const reasoningTokens = optionalSafeInteger(
      value.output_tokens_details,
      "reasoning_tokens",
    );
    if ((reasoningTokens ?? 0) > usage.outputTokens) {
      throw invalid("OpenAI returned invalid usage telemetry");
    }
    if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;
  }
  return usage;
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

function responseCodeFailure(code: string): ProviderError {
  switch (code) {
    case "context_length_exceeded":
      return new ProviderError(
        "context_overflow",
        "OpenAI context limit exceeded",
        false,
      );
    case "rate_limit_exceeded":
      return new ProviderError("rate_limit", "OpenAI rate limit reached", true);
    case "server_error":
      return new ProviderError("transport", "OpenAI failed to complete the response", true);
    default:
      return new ProviderError(
        "transport",
        "OpenAI failed to complete the response",
        false,
      );
  }
}

function machineErrorCode(value: unknown): string | null {
  const error = isRecord(value) && isRecord(value.error) ? value.error : value;
  return isRecord(error) &&
      typeof error.code === "string" &&
      /^[a-z0-9_.-]{1,128}$/iu.test(error.code)
    ? error.code
    : null;
}

async function httpErrorCode(
  response: Response,
  credential: string,
  signal: AbortSignal,
): Promise<string | null> {
  if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return null;
  }
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_ERROR_BODY_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const echoGuard = new CredentialEchoGuard(credential);
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      echoGuard.inspect(chunk.value);
      bytes += chunk.value.byteLength;
      if (bytes > MAX_ERROR_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (signal.aborted) throw requestFailure(signal);
    return null;
  } finally {
    reader.releaseLock();
  }
  try {
    return machineErrorCode(JSON.parse(text));
  } catch {
    return null;
  }
}

async function responseFailure(
  response: Response,
  credential: string,
  signal: AbortSignal,
): Promise<ProviderError> {
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
  if (response.status === 400 || response.status === 422) {
    const code = await httpErrorCode(response, credential, signal);
    if (code !== null) return responseCodeFailure(code);
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

function reviewedWebSocketEndpoint(): string {
  return reviewedEndpoint().replace(/^https:/u, "wss:");
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
    if (new TextEncoder().encode(block).byteLength > MAX_EVENT_BYTES) throw invalid();
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
    return this.#consumeEvent(event, eventName);
  }

  consumeMessage(message: string): ProviderEvent[] {
    if (new TextEncoder().encode(message).byteLength > MAX_EVENT_BYTES) throw invalid();
    let event: unknown;
    try {
      event = JSON.parse(message);
    } catch {
      throw invalid();
    }
    if (isRecord(event) && event.type === "error" && event.sequence_number === undefined) {
      const code = machineErrorCode(event);
      if (code === null) throw invalid();
      throw responseCodeFailure(code);
    }
    return this.#consumeEvent(event);
  }

  get terminal(): boolean {
    return this.#terminal;
  }

  #consumeEvent(event: unknown, expectedType?: string): ProviderEvent[] {
    if (++this.#eventCount > MAX_EVENTS || this.#terminal || !isRecord(event) ||
      typeof event.type !== "string" ||
      (expectedType !== undefined && event.type !== expectedType) ||
      !safeInteger(event.sequence_number)) {
      throw invalid();
    }
    if (this.#lastSequence !== null && event.sequence_number !== this.#lastSequence + 1) {
      throw invalid();
    }
    this.#lastSequence = event.sequence_number;

    switch (event.type) {
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
        this.#assertResponse(event.response, event.type.slice(9));
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
        throw this.#responseFailure(event);
      case "error": {
        const code = machineErrorCode(event);
        if (code === null || typeof event.message !== "string") throw invalid();
        throw responseCodeFailure(code);
      }
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
      usage = decodeUsage(response.usage);
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

  #responseFailure(event: JsonObject): ProviderError {
    const response = this.#assertResponse(event.response, "failed");
    const code = machineErrorCode(response.error);
    if (code === null || !isRecord(response.error) ||
      typeof response.error.message !== "string") throw invalid();
    return responseCodeFailure(code);
  }
}

function encodeMessage(
  message: ProviderBackedMessage,
  load: (handle: DirectContinuationHandle) => readonly JsonObject[],
): readonly JsonObject[] {
  const images = validatedMessageImages(message);
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
    items.push({
      type: "message",
      role: message.role,
      content: images.length === 0
        ? message.content
        : [
            { type: "input_text", text: message.content },
            ...images.map((image) => ({
              type: "input_image",
              image_url: imageDataUrl(image),
            })),
          ],
    });
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
  validateRequestImageBudget(request.messages);
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
  if (
    request.reasoningEffort !== undefined &&
    !REASONING_EFFORTS.has(request.reasoningEffort)
  ) {
    throw invalid("OpenAI reasoning effort is invalid");
  }
  return {
    model: request.model,
    ...(request.reasoningEffort === undefined
      ? {}
      : { reasoning: { effort: request.reasoningEffort } }),
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

type SocketInboxItem =
  | { readonly type: "message"; readonly data: WebSocket.RawData; readonly binary: boolean }
  | { readonly type: "closed" }
  | { readonly type: "error" };

class SocketInbox {
  readonly #items: SocketInboxItem[] = [];
  #waiter: ((item: SocketInboxItem) => void) | null = null;

  push(item: SocketInboxItem): void {
    if (this.#waiter !== null) {
      const resolve = this.#waiter;
      this.#waiter = null;
      resolve(item);
      return;
    }
    this.#items.push(item);
  }

  async next(signal: AbortSignal): Promise<SocketInboxItem> {
    const item = this.#items.shift();
    if (item !== undefined) return item;
    if (signal.aborted) throw requestFailure(signal);
    return await new Promise<SocketInboxItem>((resolve, reject) => {
      const onAbort = (): void => {
        this.#waiter = null;
        reject(requestFailure(signal));
      };
      this.#waiter = (next) => {
        signal.removeEventListener("abort", onAbort);
        resolve(next);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

class WebSocketConnectError extends Error {
  constructor() {
    super("OpenAI WebSocket connection failed");
    this.name = "WebSocketConnectError";
  }
}

function terminateSocket(socket: WebSocket): void {
  try {
    socket.terminate();
  } catch {
    // A socket can race from CONNECTING to CLOSED during cancellation.
  }
}

function rawDataBytes(data: WebSocket.RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export class RemoteOpenAIResponsesProvider implements ConnectionBoundModelProvider {
  readonly id = "openai-api";
  readonly adapterId = "openai-responses";
  readonly inputModalities = ["text", "image"] as const;
  readonly harnessProfile = NATIVE_TOOL_USE_PROFILE;
  readonly connectionId: string;
  readonly #apiKey: string;
  readonly #fetch: Fetch;
  readonly #endpoint: string;
  readonly #webSocketEndpoint: string;
  readonly #webSocketFactory: ResponsesWebSocketFactory | null;
  readonly #ownerInstanceId = globalThis.crypto.randomUUID();
  readonly #continuations = new Map<string, StoredContinuation>();
  #socket: WebSocket | null = null;
  #socketBusy = false;
  #webSocketDisabled = false;
  #storedBytes = 0;

  constructor(options: RemoteOpenAIResponsesProviderOptions) {
    if (!validIdentifier(options.connectionId, 128) || !validPrivateValue(options.apiKey)) {
      throw new TypeError("OpenAI Responses connection is invalid");
    }
    this.connectionId = options.connectionId;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#endpoint = reviewedEndpoint();
    this.#webSocketEndpoint = reviewedWebSocketEndpoint();
    this.#webSocketFactory = options.webSocketFactory === undefined
      ? options.fetch === undefined
        ? (url, clientOptions) => new WebSocket(url, clientOptions)
        : null
      : options.webSocketFactory;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const load = (handle: DirectContinuationHandle): readonly JsonObject[] =>
      this.#loadContinuation(handle, request);
    const messages = this.#recoverCompletedHistory(request);
    let bodyObject: JsonObject;
    let body: string;
    try {
      bodyObject = requestBody({ ...request, messages }, load);
      body = JSON.stringify(bodyObject);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw invalid("OpenAI request was invalid");
    }
    if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
      throw new ProviderError("context_overflow", "OpenAI request was too large", false);
    }

    if (
      this.#webSocketFactory !== null && !this.#webSocketDisabled &&
      !this.#socketBusy
    ) {
      this.#socketBusy = true;
      try {
        let socket: WebSocket;
        try {
          socket = await this.#openSocket(request.signal);
        } catch (error) {
          if (!(error instanceof WebSocketConnectError)) throw error;
          this.#webSocketDisabled = true;
          yield {
            type: "transport_fallback",
            from: "websocket",
            to: "sse",
            reason: "connect_failed",
          };
          yield* this.#streamSse(body, request);
          return;
        }
        yield* this.#streamSocket(socket, bodyObject, request);
        return;
      } finally {
        this.#socketBusy = false;
      }
    }
    if (
      this.#webSocketFactory !== null && !this.#webSocketDisabled &&
      this.#socketBusy
    ) {
      yield {
        type: "transport_fallback",
        from: "websocket",
        to: "sse",
        reason: "connection_busy",
      };
    }
    yield* this.#streamSse(body, request);
  }

  close(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#webSocketDisabled = false;
    if (socket !== null) terminateSocket(socket);
  }

  async #openSocket(signal: AbortSignal): Promise<WebSocket> {
    if (signal.aborted) throw requestFailure(signal);
    if (this.#socket?.readyState === WebSocket.OPEN) return this.#socket;
    if (this.#socket !== null) {
      terminateSocket(this.#socket);
      this.#socket = null;
    }
    const factory = this.#webSocketFactory;
    if (factory === null) throw new WebSocketConnectError();
    let socket: WebSocket;
    try {
      socket = factory(this.#webSocketEndpoint, {
        headers: { authorization: `Bearer ${this.#apiKey}` },
        followRedirects: false,
        handshakeTimeout: WEBSOCKET_CONNECT_TIMEOUT_MS,
        maxPayload: MAX_EVENT_BYTES,
        perMessageDeflate: false,
        skipUTF8Validation: false,
      });
    } catch {
      throw new WebSocketConnectError();
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("close", onClose);
        socket.off("unexpected-response", onUnexpectedResponse);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onAbort = (): void => {
        terminateSocket(socket);
        finish(requestFailure(signal));
      };
      const onOpen = (): void => finish();
      const onError = (): void => {
        terminateSocket(socket);
        finish(new WebSocketConnectError());
      };
      const onClose = (): void => finish(new WebSocketConnectError());
      const onUnexpectedResponse = (
        _request: ClientRequest,
        response: IncomingMessage,
      ): void => {
        const status = response.statusCode ?? 0;
        response.resume();
        terminateSocket(socket);
        if (status === 401 || status === 403) {
          finish(new ProviderError("authentication", "OpenAI authentication failed", false));
        } else if (status === 429) {
          finish(new ProviderError("rate_limit", "OpenAI rate limit reached", true));
        } else {
          finish(new WebSocketConnectError());
        }
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("unexpected-response", onUnexpectedResponse);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    this.#socket = socket;
    socket.on("close", () => {
      if (this.#socket === socket) this.#socket = null;
    });
    socket.on("error", () => {
      if (this.#socket === socket) this.#socket = null;
    });
    return socket;
  }

  async *#streamSocket(
    socket: WebSocket,
    bodyObject: JsonObject,
    request: ProviderRequest,
  ): AsyncIterable<ProviderEvent> {
    if (socket.readyState !== WebSocket.OPEN) {
      this.#disableSocket(socket);
      throw new ProviderError("transport", "OpenAI transport became unavailable", false);
    }
    const payload: JsonObject = { ...bodyObject };
    delete payload.stream;
    const encoded = JSON.stringify({ type: "response.create", ...payload });
    if (new TextEncoder().encode(encoded).byteLength > MAX_REQUEST_BYTES) {
      throw new ProviderError("context_overflow", "OpenAI request was too large", false);
    }
    const inbox = new SocketInbox();
    const onMessage = (data: WebSocket.RawData, binary: boolean): void => {
      inbox.push({ type: "message", data, binary });
    };
    const onClose = (): void => inbox.push({ type: "closed" });
    const onError = (): void => inbox.push({ type: "error" });
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.send(encoded, (error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }).catch(() => {
        this.#disableSocket(socket);
        throw new ProviderError("transport", "OpenAI request delivery was uncertain", false);
      });
      const decoder = new ResponsesDecoder();
      const echoGuard = new CredentialEchoGuard(this.#apiKey);
      const textDecoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0;
      while (!decoder.terminal) {
        const item = await inbox.next(request.signal);
        if (item.type !== "message") {
          this.#disableSocket(socket);
          throw new ProviderError("transport", "OpenAI request delivery was interrupted", false);
        }
        if (item.binary) throw invalid("OpenAI WebSocket returned binary data");
        const chunk = rawDataBytes(item.data);
        echoGuard.inspect(chunk);
        bytes += chunk.byteLength;
        if (bytes > MAX_STREAM_BYTES) throw invalid("OpenAI response was too large");
        let message: string;
        try {
          message = textDecoder.decode(chunk);
        } catch {
          throw invalid("OpenAI response was not valid UTF-8");
        }
        yield* decoder.consumeMessage(message);
      }
      yield* this.#completionEvents(decoder, request);
    } catch (error) {
      if (request.signal.aborted) {
        this.#dropSocket(socket);
        throw requestFailure(request.signal);
      }
      if (!(error instanceof ProviderError) || error.code === "invalid_response") {
        this.#dropSocket(socket);
      }
      throw error;
    } finally {
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    }
  }

  async *#streamSse(
    body: string,
    request: ProviderRequest,
  ): AsyncIterable<ProviderEvent> {
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
    if (!response.ok) {
      throw await responseFailure(response, this.#apiKey, request.signal);
    }
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
    yield* this.#completionEvents(stream, request);
  }

  *#completionEvents(
    stream: ResponsesDecoder,
    request: ProviderRequest,
  ): Iterable<ProviderEvent> {
    const completion = stream.result();
    if (completion.usage !== null) yield { type: "usage", ...completion.usage };
    const handle = this.#storeContinuation(completion.outputItems, request);
    if (handle !== null) yield { type: "provider_state", handle };
    yield { type: "done", stopReason: completion.stopReason };
  }

  #disableSocket(socket: WebSocket): void {
    this.#webSocketDisabled = true;
    this.#dropSocket(socket);
  }

  #dropSocket(socket: WebSocket): void {
    if (this.#socket === socket) this.#socket = null;
    terminateSocket(socket);
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
