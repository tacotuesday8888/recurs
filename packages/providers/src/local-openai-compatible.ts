import type {
  ConnectionBoundModelProvider,
  ProviderEvent,
  ProviderRequest,
  ToolCall,
} from "@recurs/contracts";

import { ProviderError } from "./types.js";
import { COMPATIBLE_TOOL_USE_PROFILE } from "./harness-profile.js";
import { environmentByokManifest } from "./environment-provider-policy.js";
import { retryAfterOptions } from "./retry-after.js";

const URL_ERROR =
  "Local model URL must be plain HTTP on literal 127.0.0.1 or [::1]";
const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;

type Fetch = typeof globalThis.fetch;

export interface LocalModelDescriptor {
  id: string;
  ownedBy: string | null;
}

export interface LocalProviderOptions {
  baseUrl: string;
  fetch?: Fetch;
}

export interface BoundLocalProviderOptions extends LocalProviderOptions {
  connectionId: string;
}

export function normalizeLoopbackOpenAIBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError(URL_ERROR);
  }
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError(URL_ERROR);
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.length === 0 ? "/v1" : pathname;
  return url.toString().replace(/\/$/, "");
}

function localEndpoint(baseUrl: string, suffix: string): string {
  return `${normalizeLoopbackOpenAIBaseUrl(baseUrl)}${suffix}`;
}

function transportError(signal: AbortSignal): ProviderError {
  if (signal.aborted) {
    return new ProviderError("cancelled", "Local model request was cancelled", false);
  }
  return new ProviderError(
    "transport",
    "Could not reach the local model server",
    true,
  );
}

function responseError(response: Response): ProviderError {
  if (response.status >= 300 && response.status < 400) {
    return new ProviderError(
      "transport",
      "The local model server attempted an unsupported redirect",
      false,
    );
  }
  return new ProviderError(
    "transport",
    `The local model server returned HTTP ${response.status}`,
    response.status >= 500,
  );
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new ProviderError("invalid_response", "Local model response had no body", false);
  }
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new ProviderError("invalid_response", "Local model response was too large", false);
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function listLocalOpenAIModels(
  options: LocalProviderOptions & { signal?: AbortSignal },
): Promise<LocalModelDescriptor[]> {
  const signal = options.signal ?? new AbortController().signal;
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(
      localEndpoint(options.baseUrl, "/models"),
      { method: "GET", redirect: "manual", signal },
    );
  } catch {
    throw transportError(signal);
  }
  if (!response.ok) throw responseError(response);
  let value: unknown;
  try {
    value = JSON.parse(await readBoundedText(response, MAX_CATALOG_BYTES));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError("invalid_response", "Local model catalog was invalid", false);
  }
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new ProviderError("invalid_response", "Local model catalog was invalid", false);
  }
  const models = value.data.map((entry): LocalModelDescriptor => {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.trim().length === 0) {
      throw new ProviderError("invalid_response", "Local model catalog was invalid", false);
    }
    if (entry.owned_by !== undefined && typeof entry.owned_by !== "string") {
      throw new ProviderError("invalid_response", "Local model catalog was invalid", false);
    }
    return { id: entry.id, ownedBy: entry.owned_by ?? null };
  });
  return models.sort((left, right) => left.id.localeCompare(right.id));
}

interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

function stopReason(value: unknown, hasTools: boolean): "complete" | "tool_calls" | "length" {
  if (hasTools || value === "tool_calls") return "tool_calls";
  if (value === "length") return "length";
  return "complete";
}

function requestBody(request: ProviderRequest): Record<string, unknown> {
  return {
    model: request.model,
    stream: true,
    stream_options: { include_usage: true },
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
      ...(message.toolCalls === undefined
        ? {}
        : {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }),
    })),
    tools: request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    })),
  };
}

interface ChatCompletionStreamOptions {
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetch: Fetch;
  readonly request: ProviderRequest;
  readonly local: boolean;
}

function requestFailure(
  signal: AbortSignal,
  local: boolean,
): ProviderError {
  if (signal.aborted) {
    return new ProviderError("cancelled", "Provider request was cancelled", false);
  }
  return new ProviderError(
    "transport",
    local
      ? "Could not reach the local model server"
      : "Could not reach the provider",
    true,
  );
}

function providerResponseError(response: Response, local: boolean): ProviderError {
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
    return new ProviderError(
      "transport",
      "The provider attempted an unsupported redirect",
      false,
    );
  }
  return new ProviderError(
    "transport",
    local
      ? `The local model server returned HTTP ${response.status}`
      : `The provider returned HTTP ${response.status}`,
    response.status >= 500,
    retryAfterOptions(response.headers),
  );
}

async function* streamChatCompletions(
  options: ChatCompletionStreamOptions,
): AsyncIterable<ProviderEvent> {
  const { request } = options;
  let response: Response;
  try {
    response = await options.fetch(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      redirect: "manual",
      signal: request.signal,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...options.headers,
      },
      body: JSON.stringify(requestBody(request)),
    });
  } catch {
    throw requestFailure(request.signal, options.local);
  }
  if (!response.ok) throw providerResponseError(response, options.local);
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new ProviderError("invalid_response", "Provider response had no body", false);
  }
  const decoder = new TextDecoder();
  const tools = new Map<number, PartialToolCall>();
  let buffer = "";
  let bytes = 0;
  let finish: unknown = null;
  const usage: {
    value: { inputTokens: number; outputTokens: number } | null;
  } = { value: null };

  const consume = function* (block: string): Generator<ProviderEvent> {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data.length === 0 || data === "[DONE]") continue;
      let value: unknown;
      try {
        value = JSON.parse(data);
      } catch {
        throw new ProviderError("invalid_response", "Provider stream was invalid", false);
      }
      if (!isRecord(value)) {
        throw new ProviderError("invalid_response", "Provider stream was invalid", false);
      }
      if (isRecord(value.usage)) {
        const input = value.usage.prompt_tokens;
        const output = value.usage.completion_tokens;
        if (Number.isSafeInteger(input) && Number.isSafeInteger(output) && Number(input) >= 0 && Number(output) >= 0) {
          usage.value = { inputTokens: Number(input), outputTokens: Number(output) };
        }
      }
      const choice = Array.isArray(value.choices) ? value.choices[0] : undefined;
      if (!isRecord(choice)) continue;
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) finish = choice.finish_reason;
      if (!isRecord(choice.delta)) continue;
      if (typeof choice.delta.content === "string" && choice.delta.content.length > 0) {
        yield { type: "text_delta", text: choice.delta.content };
      }
      if (typeof choice.delta.reasoning_content === "string" && choice.delta.reasoning_content.length > 0) {
        yield { type: "reasoning_delta", text: choice.delta.reasoning_content };
      }
      if (!Array.isArray(choice.delta.tool_calls)) continue;
      for (const raw of choice.delta.tool_calls) {
        if (!isRecord(raw) || !Number.isSafeInteger(raw.index) || Number(raw.index) < 0) {
          throw new ProviderError("invalid_response", "Provider tool call was invalid", false);
        }
        const index = Number(raw.index);
        const current = tools.get(index) ?? { id: "", name: "", arguments: "" };
        if (typeof raw.id === "string") current.id += raw.id;
        if (isRecord(raw.function)) {
          if (typeof raw.function.name === "string") current.name += raw.function.name;
          if (typeof raw.function.arguments === "string") current.arguments += raw.function.arguments;
        }
        tools.set(index, current);
      }
    }
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) {
        await reader.cancel();
        throw new ProviderError("invalid_response", "Provider stream was too large", false);
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) yield* consume(block);
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) yield* consume(buffer);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw requestFailure(request.signal, options.local);
  }

  for (const [, partial] of [...tools.entries()].sort(([left], [right]) => left - right)) {
    let args: unknown;
    try {
      args = JSON.parse(partial.arguments);
    } catch {
      throw new ProviderError("invalid_response", "Provider tool arguments were invalid", false);
    }
    if (partial.id.length === 0 || partial.name.length === 0) {
      throw new ProviderError("invalid_response", "Provider tool call was incomplete", false);
    }
    const call: ToolCall = { id: partial.id, name: partial.name, arguments: args };
    yield { type: "tool_call", call };
  }
  if (usage.value !== null) {
    yield {
      type: "usage",
      inputTokens: usage.value.inputTokens,
      outputTokens: usage.value.outputTokens,
    };
  }
  yield { type: "done", stopReason: stopReason(finish, tools.size > 0) };
}

export class LocalOpenAICompatibleProvider implements ConnectionBoundModelProvider {
  readonly id = "local-openai-compatible";
  readonly adapterId = "openai-chat-completions";
  readonly harnessProfile = COMPATIBLE_TOOL_USE_PROFILE;
  readonly connectionId: string;
  readonly #baseUrl: string;
  readonly #fetch: Fetch;

  constructor(options: BoundLocalProviderOptions) {
    if (
      options.connectionId.length === 0 ||
      options.connectionId !== options.connectionId.trim() ||
      options.connectionId.length > 128
    ) {
      throw new TypeError("Local model connection identity is invalid");
    }
    this.connectionId = options.connectionId;
    this.#baseUrl = normalizeLoopbackOpenAIBaseUrl(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    yield* streamChatCompletions({
      baseUrl: this.#baseUrl,
      headers: {},
      fetch: this.#fetch,
      request,
      local: true,
    });
  }
}

export interface RemoteOpenAICompatibleProviderOptions {
  readonly providerId: string;
  readonly connectionId: string;
  readonly apiKey: string;
  readonly fetch?: Fetch;
}

function reviewedChatEndpoint(providerId: string): string {
  const manifest = environmentByokManifest(providerId);
  const endpoint = manifest?.endpoints.find(
    (candidate) => candidate.kind === "origin",
  );
  if (
    manifest === null ||
    manifest.protocol !== "openai_chat" ||
    endpoint === undefined ||
    !endpoint.value.startsWith("https://")
  ) {
    throw new TypeError("Remote provider does not have a reviewed Chat Completions endpoint");
  }
  return endpoint.value.replace(/\/+$/u, "");
}

function validPrivateValue(value: string): boolean {
  return value.length > 0 && value.length <= 8_192 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f && codePoint !== 0x7f;
    });
}

export class RemoteOpenAICompatibleProvider
  implements ConnectionBoundModelProvider {
  readonly id: string;
  readonly adapterId = "openai-chat-completions";
  readonly harnessProfile = COMPATIBLE_TOOL_USE_PROFILE;
  readonly connectionId: string;
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: Fetch;

  constructor(options: RemoteOpenAICompatibleProviderOptions) {
    if (
      options.connectionId.length === 0 ||
      options.connectionId !== options.connectionId.trim() ||
      options.connectionId.length > 128 ||
      !validPrivateValue(options.apiKey)
    ) {
      throw new TypeError("Remote provider connection is invalid");
    }
    this.id = options.providerId;
    this.connectionId = options.connectionId;
    this.#baseUrl = reviewedChatEndpoint(options.providerId);
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    yield* streamChatCompletions({
      baseUrl: this.#baseUrl,
      headers: { authorization: `Bearer ${this.#apiKey}` },
      fetch: this.#fetch,
      request,
      local: false,
    });
  }
}
