import type {
  ConnectionBoundModelProvider,
  ModelMessage,
  ProviderEvent,
  ProviderRequest,
  ToolCall,
} from "@recurs/contracts";

import { NATIVE_TOOL_USE_PROFILE } from "./harness-profile.js";
import { environmentByokManifest } from "./environment-provider-policy.js";
import { CredentialEchoGuard } from "./credential-echo-guard.js";
import { retryAfterOptions } from "./retry-after.js";
import { ProviderError } from "./types.js";

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_OUTPUT_TOKENS = 8_192;
const MAX_REQUEST_BYTES = 4 * 1_024 * 1_024;
const MAX_RESPONSE_BYTES = 32 * 1_024 * 1_024;
const MAX_EVENT_BYTES = 1 * 1_024 * 1_024;
const MAX_EVENT_COUNT = 8_192;
const MAX_INPUT_COUNT = 1_024;
const MAX_TOOL_COUNT = 128;
const IDENTIFIER = /^[\x21-\x7e]{1,256}$/u;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/u;

type Fetch = typeof globalThis.fetch;

export interface RemoteAnthropicMessagesProviderOptions {
  readonly providerId: string;
  readonly connectionId: string;
  readonly apiKey: string;
  readonly fetch?: Fetch;
}

interface AnthropicContentBlock {
  readonly type: "text" | "tool_use" | "tool_result";
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
  readonly tool_use_id?: string;
  readonly content?: string;
}

interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: AnthropicContentBlock[];
}

interface TextStreamBlock {
  readonly kind: "text";
}

interface ToolStreamBlock {
  readonly kind: "tool";
  readonly id: string;
  readonly name: string;
  json: string;
}

type StreamBlock = TextStreamBlock | ToolStreamBlock;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function validCredential(value: string): boolean {
  return value.length > 0 && value.length <= 8_192 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x21 && codePoint <= 0x7e;
    });
}

function endpoint(providerId: string): string {
  const manifest = environmentByokManifest(providerId);
  const origin = manifest?.endpoints.find((candidate) => candidate.kind === "origin");
  if (
    manifest?.protocol !== "anthropic_messages" ||
    origin === undefined ||
    origin.value !== "https://api.anthropic.com/v1"
  ) {
    throw new TypeError("Remote provider does not have a reviewed Anthropic Messages endpoint");
  }
  return `${origin.value}/messages`;
}

function appendBlock(
  messages: AnthropicMessage[],
  role: AnthropicMessage["role"],
  block: AnthropicContentBlock,
): void {
  const previous = messages.at(-1);
  if (previous?.role !== role) {
    messages.push({ role, content: [block] });
    return;
  }
  const previousIsToolResult = previous.content.every(
    (candidate) => candidate.type === "tool_result",
  );
  if (
    role === "user" &&
    ((block.type === "tool_result") !== previousIsToolResult)
  ) {
    throw new ProviderError(
      "invalid_response",
      "Anthropic conversation ordering is invalid",
      false,
    );
  }
  previous.content.push(block);
}

function toolUseBlock(call: ToolCall): AnthropicContentBlock {
  if (!IDENTIFIER.test(call.id) || !TOOL_NAME.test(call.name) || !isRecord(call.arguments)) {
    throw new ProviderError("invalid_response", "Anthropic tool input is invalid", false);
  }
  return {
    type: "tool_use",
    id: call.id,
    name: call.name,
    input: call.arguments,
  };
}

function appendMessage(
  messages: AnthropicMessage[],
  system: string[],
  message: ModelMessage,
): void {
  if (message.role === "system") {
    if (
      messages.length > 0 ||
      message.content.length === 0 ||
      message.toolCallId !== undefined ||
      message.toolCalls !== undefined
    ) {
      throw new ProviderError(
        "invalid_response",
        "Anthropic system instructions are invalid",
        false,
      );
    }
    system.push(message.content);
    return;
  }
  if (message.role === "tool") {
    if (
      message.toolCallId === undefined ||
      !IDENTIFIER.test(message.toolCallId) ||
      message.content.length === 0 ||
      message.toolCalls !== undefined
    ) {
      throw new ProviderError("invalid_response", "Anthropic tool result is invalid", false);
    }
    appendBlock(messages, "user", {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: message.content,
    });
    return;
  }
  if (message.toolCallId !== undefined) {
    throw new ProviderError("invalid_response", "Anthropic message is invalid", false);
  }
  if (message.role === "user") {
    if (message.content.length === 0 || message.toolCalls !== undefined) {
      throw new ProviderError("invalid_response", "Anthropic user message is invalid", false);
    }
    appendBlock(messages, "user", { type: "text", text: message.content });
    return;
  }
  if (message.content.length === 0 && (message.toolCalls?.length ?? 0) === 0) {
    throw new ProviderError("invalid_response", "Anthropic assistant message is invalid", false);
  }
  if (message.content.length > 0) {
    appendBlock(messages, "assistant", { type: "text", text: message.content });
  }
  for (const call of message.toolCalls ?? []) {
    appendBlock(messages, "assistant", toolUseBlock(call));
  }
}

function requestBody(request: ProviderRequest): string {
  if (!IDENTIFIER.test(request.model) || request.messages.length > MAX_INPUT_COUNT) {
    throw new ProviderError("invalid_response", "Anthropic request is invalid", false);
  }
  if (request.tools.length > MAX_TOOL_COUNT) {
    throw new ProviderError("invalid_response", "Anthropic tool list is too large", false);
  }
  const system: string[] = [];
  const messages: AnthropicMessage[] = [];
  for (const message of request.messages) appendMessage(messages, system, message);
  if (messages.length === 0 || messages[0]?.role !== "user") {
    throw new ProviderError("invalid_response", "Anthropic conversation is invalid", false);
  }
  const tools = request.tools.map((tool) => {
    if (
      !TOOL_NAME.test(tool.name) ||
      new TextEncoder().encode(tool.description).byteLength > 1_024 ||
      !isRecord(tool.inputSchema)
    ) {
      throw new ProviderError("invalid_response", "Anthropic tool definition is invalid", false);
    }
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    };
  });
  const body = JSON.stringify({
    model: request.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
    ...(system.length === 0 ? {} : { system: system.join("\n\n") }),
    messages,
    ...(tools.length === 0 ? {} : { tools }),
  });
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw new ProviderError("context_overflow", "Anthropic request was too large", false);
  }
  return body;
}

function responseError(response: Response): ProviderError {
  if (response.status === 401 || response.status === 403) {
    return new ProviderError("authentication", "Provider authentication failed", false);
  }
  if (response.status === 429) {
    return new ProviderError(
      "rate_limit",
      "Provider rate limit reached",
      true,
      retryAfterOptions(response.headers),
    );
  }
  if (response.status === 413) {
    return new ProviderError("context_overflow", "Provider request was too large", false);
  }
  if (response.status >= 300 && response.status < 400) {
    return new ProviderError("transport", "The provider attempted an unsupported redirect", false);
  }
  return new ProviderError(
    "transport",
    `The provider returned HTTP ${response.status}`,
    response.status >= 500,
    retryAfterOptions(response.headers),
  );
}

function transportError(signal: AbortSignal): ProviderError {
  return signal.aborted
    ? new ProviderError("cancelled", "Provider request was cancelled", false)
    : new ProviderError("transport", "Could not reach the provider", true);
}

class AnthropicStreamDecoder {
  #buffer = "";
  #bytes = 0;
  #events = 0;
  #started = false;
  #stopped = false;
  #activeIndex: number | null = null;
  #blocks: StreamBlock[] = [];
  #inputTokens: number | null = null;
  #cachedInputTokens: number | undefined;
  #cacheWriteInputTokens: number | undefined;
  #stopReason: "complete" | "tool_calls" | "length" | null = null;
  #usageEmitted = false;

  *receive(text: string, byteLength: number): Generator<ProviderEvent> {
    this.#bytes += byteLength;
    if (this.#bytes > MAX_RESPONSE_BYTES || this.#stopped) {
      throw new ProviderError("invalid_response", "Provider stream was too large", false);
    }
    this.#buffer += text;
    while (true) {
      const boundary = /\r?\n\r?\n/u.exec(this.#buffer);
      if (boundary === null) break;
      const block = this.#buffer.slice(0, boundary.index);
      this.#buffer = this.#buffer.slice(boundary.index + boundary[0].length);
      if (new TextEncoder().encode(block).byteLength > MAX_EVENT_BYTES) {
        throw new ProviderError("invalid_response", "Provider event was too large", false);
      }
      this.#events += 1;
      if (this.#events > MAX_EVENT_COUNT) {
        throw new ProviderError("invalid_response", "Provider stream had too many events", false);
      }
      if (block.length > 0) yield* this.#consume(block);
    }
    if (new TextEncoder().encode(this.#buffer).byteLength > MAX_EVENT_BYTES) {
      throw new ProviderError("invalid_response", "Provider event was too large", false);
    }
  }

  finish(): void {
    if (this.#buffer.trim().length > 0 || !this.#stopped) {
      throw new ProviderError("invalid_response", "Provider stream ended unexpectedly", false);
    }
  }

  *#consume(block: string): Generator<ProviderEvent> {
    const lines = block.replaceAll("\r\n", "\n").split("\n");
    const eventLines = lines.filter((line) => line.startsWith("event: "));
    const dataLines = lines.filter((line) => line.startsWith("data: "));
    if (eventLines.length !== 1 || dataLines.length !== 1) {
      throw new ProviderError("invalid_response", "Provider stream was invalid", false);
    }
    const name = eventLines[0]!.slice(7);
    let value: unknown;
    try {
      value = JSON.parse(dataLines[0]!.slice(6));
    } catch {
      throw new ProviderError("invalid_response", "Provider stream was invalid", false);
    }
    if (!isRecord(value) || value.type !== name) {
      throw new ProviderError("invalid_response", "Provider stream was invalid", false);
    }
    if (name === "message_start") {
      if (
        this.#started ||
        !isRecord(value.message) ||
        typeof value.message.id !== "string" ||
        !IDENTIFIER.test(value.message.id) ||
        value.message.type !== "message" ||
        value.message.role !== "assistant" ||
        typeof value.message.model !== "string" ||
        !IDENTIFIER.test(value.message.model) ||
        !Array.isArray(value.message.content) ||
        value.message.content.length !== 0 ||
        value.message.stop_reason !== null ||
        value.message.stop_sequence !== null
      ) {
        throw new ProviderError("invalid_response", "Provider stream was invalid", false);
      }
      const usage = value.message.usage;
      if (!isRecord(usage)) {
        throw new ProviderError("invalid_response", "Provider usage was invalid", false);
      }
      const input = nonnegativeInteger(usage.input_tokens);
      const cacheReadReported = usage.cache_read_input_tokens !== undefined;
      const cacheWriteReported = usage.cache_creation_input_tokens !== undefined;
      const cacheRead = !cacheReadReported
        ? 0
        : nonnegativeInteger(usage.cache_read_input_tokens);
      const cacheWrite = !cacheWriteReported
        ? 0
        : nonnegativeInteger(usage.cache_creation_input_tokens);
      if (input === null || cacheRead === null || cacheWrite === null) {
        throw new ProviderError("invalid_response", "Provider usage was invalid", false);
      }
      this.#inputTokens = input + cacheRead + cacheWrite;
      if (!Number.isSafeInteger(this.#inputTokens)) {
        throw new ProviderError("invalid_response", "Provider usage was invalid", false);
      }
      this.#cachedInputTokens = cacheReadReported ? cacheRead : undefined;
      this.#cacheWriteInputTokens = cacheWriteReported ? cacheWrite : undefined;
      this.#started = true;
      return;
    }
    if (name === "ping") {
      if (!this.#started || this.#stopped) {
        throw new ProviderError("invalid_response", "Provider stream was invalid", false);
      }
      return;
    }
    if (name === "content_block_start") {
      if (!this.#started || this.#activeIndex !== null || this.#stopReason !== null) {
        throw new ProviderError("invalid_response", "Provider content block was invalid", false);
      }
      const index = nonnegativeInteger(value.index);
      const content = value.content_block;
      if (index !== this.#blocks.length || !isRecord(content)) {
        throw new ProviderError("invalid_response", "Provider content block was invalid", false);
      }
      if (content.type === "text" && content.text === "") {
        this.#blocks.push({ kind: "text" });
      } else if (
        content.type === "tool_use" &&
        typeof content.id === "string" && IDENTIFIER.test(content.id) &&
        typeof content.name === "string" && TOOL_NAME.test(content.name) &&
        isRecord(content.input) && Object.keys(content.input).length === 0
      ) {
        this.#blocks.push({
          kind: "tool",
          id: content.id,
          name: content.name,
          json: "",
        });
      } else {
        throw new ProviderError("invalid_response", "Provider content block was invalid", false);
      }
      this.#activeIndex = index;
      return;
    }
    if (name === "content_block_delta") {
      const index = nonnegativeInteger(value.index);
      const delta = value.delta;
      const active = index === null ? undefined : this.#blocks[index];
      if (index !== this.#activeIndex || active === undefined || !isRecord(delta)) {
        throw new ProviderError("invalid_response", "Provider content delta was invalid", false);
      }
      if (active.kind === "text" && delta.type === "text_delta" && typeof delta.text === "string") {
        if (delta.text.length > 0) yield { type: "text_delta", text: delta.text };
        return;
      }
      if (
        active.kind === "tool" &&
        delta.type === "input_json_delta" &&
        typeof delta.partial_json === "string"
      ) {
        active.json += delta.partial_json;
        if (new TextEncoder().encode(active.json).byteLength > MAX_EVENT_BYTES) {
          throw new ProviderError("invalid_response", "Provider tool input was too large", false);
        }
        return;
      }
      throw new ProviderError("invalid_response", "Provider content delta was invalid", false);
    }
    if (name === "content_block_stop") {
      const index = nonnegativeInteger(value.index);
      const active = index === null ? undefined : this.#blocks[index];
      if (index !== this.#activeIndex || active === undefined) {
        throw new ProviderError("invalid_response", "Provider content block was invalid", false);
      }
      this.#activeIndex = null;
      if (active.kind === "tool") {
        let input: unknown;
        try {
          input = JSON.parse(active.json);
        } catch {
          throw new ProviderError("invalid_response", "Provider tool input was invalid", false);
        }
        if (!isRecord(input)) {
          throw new ProviderError("invalid_response", "Provider tool input was invalid", false);
        }
        yield {
          type: "tool_call",
          call: { id: active.id, name: active.name, arguments: input },
        };
      }
      return;
    }
    if (name === "message_delta") {
      if (
        !this.#started ||
        this.#activeIndex !== null ||
        this.#stopReason !== null ||
        !isRecord(value.delta) ||
        !isRecord(value.usage) ||
        this.#inputTokens === null
      ) {
        throw new ProviderError("invalid_response", "Provider completion was invalid", false);
      }
      const output = nonnegativeInteger(value.usage.output_tokens);
      if (output === null) {
        throw new ProviderError("invalid_response", "Provider usage was invalid", false);
      }
      switch (value.delta.stop_reason) {
        case "end_turn":
        case "stop_sequence":
          this.#stopReason = "complete";
          break;
        case "tool_use":
          this.#stopReason = "tool_calls";
          break;
        case "max_tokens":
          this.#stopReason = "length";
          break;
        case "refusal":
          throw new ProviderError("transport", "Provider refused the request", false);
        default:
          throw new ProviderError("invalid_response", "Provider stop reason was invalid", false);
      }
      this.#usageEmitted = true;
      yield {
        type: "usage",
        inputTokens: this.#inputTokens,
        outputTokens: output,
        ...(this.#cachedInputTokens === undefined
          ? {}
          : { cachedInputTokens: this.#cachedInputTokens }),
        ...(this.#cacheWriteInputTokens === undefined
          ? {}
          : { cacheWriteInputTokens: this.#cacheWriteInputTokens }),
      };
      return;
    }
    if (name === "message_stop") {
      if (
        !this.#started ||
        this.#activeIndex !== null ||
        this.#stopReason === null ||
        !this.#usageEmitted ||
        this.#stopped
      ) {
        throw new ProviderError("invalid_response", "Provider completion was invalid", false);
      }
      this.#stopped = true;
      yield { type: "done", stopReason: this.#stopReason };
      return;
    }
    if (name === "error") {
      throw new ProviderError("transport", "Provider stream failed", false);
    }
    throw new ProviderError("invalid_response", "Provider stream event was unsupported", false);
  }
}

export class RemoteAnthropicMessagesProvider
  implements ConnectionBoundModelProvider {
  readonly id: string;
  readonly adapterId = "anthropic-messages";
  readonly harnessProfile = NATIVE_TOOL_USE_PROFILE;
  readonly connectionId: string;
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #fetch: Fetch;

  constructor(options: RemoteAnthropicMessagesProviderOptions) {
    if (
      !IDENTIFIER.test(options.connectionId) ||
      !validCredential(options.apiKey)
    ) {
      throw new TypeError("Remote Anthropic connection is invalid");
    }
    this.id = options.providerId;
    this.connectionId = options.connectionId;
    this.#endpoint = endpoint(options.providerId);
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        redirect: "manual",
        signal: request.signal,
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          "anthropic-version": ANTHROPIC_VERSION,
          "x-api-key": this.#apiKey,
        },
        body: requestBody(request),
      });
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw transportError(request.signal);
    }
    if (!response.ok) throw responseError(response);
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new ProviderError("invalid_response", "Provider response had no body", false);
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const stream = new AnthropicStreamDecoder();
    const echoGuard = new CredentialEchoGuard(this.#apiKey);
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        echoGuard.inspect(chunk.value);
        let text: string;
        try {
          text = decoder.decode(chunk.value, { stream: true });
        } catch {
          throw new ProviderError("invalid_response", "Provider stream was invalid", false);
        }
        yield* stream.receive(text, chunk.value.byteLength);
      }
      let final: string;
      try {
        final = decoder.decode();
      } catch {
        throw new ProviderError("invalid_response", "Provider stream was invalid", false);
      }
      if (final.length > 0) yield* stream.receive(final, 0);
      stream.finish();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw transportError(request.signal);
    }
  }
}
