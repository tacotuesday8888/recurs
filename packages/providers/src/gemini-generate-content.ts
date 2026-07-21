import {
  RECURS_VERSION,
  type ConnectionBoundModelProvider,
  type DirectContinuationHandle,
  type ProviderBackedMessage,
  type ProviderEvent,
  type ProviderRequest,
  type ProviderUsage,
  type ToolCall,
} from "@recurs/contracts";

import { CredentialEchoGuard } from "./credential-echo-guard.js";
import { environmentByokManifest } from "./environment-provider-policy.js";
import { NATIVE_TOOL_USE_PROFILE } from "./harness-profile.js";
import {
  validatedMessageImages,
  validateRequestImageBudget,
} from "./model-images.js";
import { retryAfterOptions } from "./retry-after.js";
import { ProviderError } from "./types.js";

const MAX_REQUEST_BYTES = 16 * 1_024 * 1_024;
const MAX_RESPONSE_BYTES = 32 * 1_024 * 1_024;
const MAX_EVENT_BYTES = 1 * 1_024 * 1_024;
const MAX_EVENT_COUNT = 8_192;
const MAX_INPUT_COUNT = 1_024;
const MAX_TOOL_COUNT = 128;
const MAX_STORED_HANDLES = 128;
const MAX_STORED_BYTES = 16 * 1_024 * 1_024;
const MAX_THOUGHT_SIGNATURE_BYTES = 64 * 1_024;
const IDENTIFIER = /^[\x21-\x7e]{1,256}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;

type Fetch = typeof globalThis.fetch;
type JsonObject = Record<string, unknown>;

export interface RemoteGeminiGenerateContentProviderOptions {
  readonly providerId: string;
  readonly connectionId: string;
  readonly apiKey: string;
  readonly fetch?: Fetch;
}

interface StoredCall {
  readonly name: string;
  readonly providerId: string | null;
}

interface StoredContinuation {
  readonly handle: DirectContinuationHandle;
  readonly content: JsonObject;
  readonly calls: ReadonlyMap<string, StoredCall>;
  readonly bytes: number;
}

interface DecodedCompletion {
  readonly content: JsonObject;
  readonly calls: ReadonlyMap<string, StoredCall>;
  readonly usage: ProviderUsage | null;
  readonly stopReason: "complete" | "tool_calls" | "length";
}

function invalid(message = "Gemini response was invalid"): ProviderError {
  return new ProviderError("invalid_response", message, false);
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCredential(value: string): boolean {
  return value.length > 0 && value.length <= 8_192 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x21 && codePoint <= 0x7e;
    });
}

function validThoughtSignature(value: string): boolean {
  return value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_THOUGHT_SIGNATURE_BYTES &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x21 && codePoint <= 0x7e;
    });
}

function endpoint(providerId: string): string {
  const manifest = environmentByokManifest(providerId);
  const origin = manifest?.endpoints.find((candidate) => candidate.kind === "origin");
  if (
    manifest?.protocol !== "gemini_generate_content" ||
    manifest.id !== "google-gemini-api" ||
    origin?.value !== "https://generativelanguage.googleapis.com/v1beta"
  ) {
    throw new TypeError("Remote provider does not have a reviewed Gemini endpoint");
  }
  return origin.value;
}

function responseError(response: Response): ProviderError {
  if (response.status === 401 || response.status === 403) {
    return new ProviderError("authentication", "Gemini authentication failed", false);
  }
  if (response.status === 429) {
    return new ProviderError(
      "rate_limit",
      "Gemini rate limit reached",
      true,
      retryAfterOptions(response.headers),
    );
  }
  if (response.status === 413) {
    return new ProviderError("context_overflow", "Gemini request was too large", false);
  }
  if (response.status >= 300 && response.status < 400) {
    return new ProviderError("transport", "Gemini attempted an unsupported redirect", false);
  }
  return new ProviderError(
    "transport",
    `Gemini returned HTTP ${response.status}`,
    response.status >= 500,
    retryAfterOptions(response.headers),
  );
}

function transportError(signal: AbortSignal): ProviderError {
  return signal.aborted
    ? new ProviderError("cancelled", "Gemini request was cancelled", false)
    : new ProviderError("transport", "Could not reach Gemini", true);
}

function requestPart(message: ProviderBackedMessage): JsonObject[] {
  const images = validatedMessageImages(message);
  if (message.role === "assistant" && images.length > 0) {
    throw invalid("Gemini model messages cannot contain images");
  }
  if (message.content.length === 0 && images.length === 0) return [];
  return [
    ...(message.content.length === 0 ? [] : [{ text: message.content }]),
    ...images.map((image) => ({
      inlineData: { mimeType: image.mediaType, data: image.data },
    })),
  ];
}

function appendToolResponse(contents: JsonObject[], part: JsonObject): void {
  const previous = contents.at(-1);
  if (
    previous?.role === "user" && Array.isArray(previous.parts) &&
    previous.parts.every((candidate) =>
      isRecord(candidate) && candidate.functionResponse !== undefined
    )
  ) {
    previous.parts.push(part);
    return;
  }
  contents.push({ role: "user", parts: [part] });
}

function requestBody(
  request: ProviderRequest,
  load: (handle: DirectContinuationHandle) => StoredContinuation,
): string {
  validateRequestImageBudget(request.messages);
  if (
    !MODEL_ID.test(request.model) ||
    request.messages.length === 0 ||
    request.messages.length > MAX_INPUT_COUNT ||
    request.tools.length > MAX_TOOL_COUNT ||
    new Set(request.tools.map((tool) => tool.name)).size !== request.tools.length
  ) {
    throw invalid("Gemini request exceeded its limits");
  }
  const system: string[] = [];
  const contents: JsonObject[] = [];
  const calls = new Map<string, StoredCall>();
  for (const raw of request.messages) {
    const message = raw as ProviderBackedMessage;
    if (message.role === "system") {
      if (
        contents.length > 0 || message.content.length === 0 ||
        message.images !== undefined || message.toolCallId !== undefined ||
        message.toolCalls !== undefined || message.providerStateHandle !== undefined
      ) {
        throw invalid("Gemini system instructions were invalid");
      }
      system.push(message.content);
      continue;
    }
    if (message.role === "assistant" && message.providerStateHandle !== undefined) {
      const stored = load(message.providerStateHandle);
      contents.push(structuredClone(stored.content));
      for (const [id, call] of stored.calls) calls.set(id, call);
      continue;
    }
    if (message.role === "tool") {
      const call = message.toolCallId === undefined
        ? undefined
        : calls.get(message.toolCallId);
      if (
        call === undefined || message.content.length === 0 ||
        message.images !== undefined || message.toolCalls !== undefined
      ) {
        throw invalid("Gemini tool result was invalid");
      }
      appendToolResponse(contents, {
        functionResponse: {
          name: call.name,
          ...(call.providerId === null ? {} : { id: call.providerId }),
          response: { output: message.content },
        },
      });
      continue;
    }
    if (
      message.toolCallId !== undefined ||
      (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0)
    ) {
      throw invalid("Gemini continuation state was unavailable");
    }
    const parts = requestPart(message);
    if (parts.length === 0 || message.toolCalls !== undefined) {
      throw invalid("Gemini message was invalid");
    }
    contents.push({
      role: message.role === "assistant" ? "model" : "user",
      parts,
    });
  }
  if (contents.length === 0 || contents[0]?.role !== "user") {
    throw invalid("Gemini conversation was invalid");
  }
  const declarations = request.tools.map((tool) => {
    if (
      !TOOL_NAME.test(tool.name) ||
      new TextEncoder().encode(tool.description).byteLength > 1_024 ||
      !isRecord(tool.inputSchema)
    ) {
      throw invalid("Gemini tool definition was invalid");
    }
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    };
  });
  const body = JSON.stringify({
    ...(system.length === 0
      ? {}
      : { systemInstruction: { parts: [{ text: system.join("\n\n") }] } }),
    contents,
    ...(declarations.length === 0
      ? {}
      : { tools: [{ functionDeclarations: declarations }] }),
  });
  if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw new ProviderError("context_overflow", "Gemini request was too large", false);
  }
  return body;
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function decodeUsage(value: unknown): ProviderUsage {
  if (!isRecord(value)) throw invalid("Gemini usage was invalid");
  const inputTokens = nonnegativeInteger(value.promptTokenCount);
  const outputTokens = nonnegativeInteger(value.candidatesTokenCount);
  const cachedInputTokens = value.cachedContentTokenCount === undefined
    ? undefined
    : nonnegativeInteger(value.cachedContentTokenCount);
  const reasoningTokens = value.thoughtsTokenCount === undefined
    ? undefined
    : nonnegativeInteger(value.thoughtsTokenCount);
  if (
    inputTokens === null || outputTokens === null ||
    cachedInputTokens === null || reasoningTokens === null ||
    (cachedInputTokens !== undefined && cachedInputTokens > inputTokens)
  ) {
    throw invalid("Gemini usage was invalid");
  }
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function exactPart(value: JsonObject): JsonObject {
  const allowed = new Set(["text", "thought", "thoughtSignature", "functionCall"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalid("Gemini content part was unsupported");
  }
  if (value.thought !== undefined && typeof value.thought !== "boolean") {
    throw invalid("Gemini content part was invalid");
  }
  if (
    value.thoughtSignature !== undefined &&
    (typeof value.thoughtSignature !== "string" ||
      !validThoughtSignature(value.thoughtSignature))
  ) {
    throw invalid("Gemini thought signature was invalid");
  }
  if (
    (value.text !== undefined && typeof value.text !== "string") ||
    (value.text !== undefined && value.functionCall !== undefined) ||
    (value.text === undefined && value.functionCall === undefined &&
      value.thoughtSignature === undefined) ||
    (value.thought === true && value.text === undefined)
  ) {
    throw invalid("Gemini content part was invalid");
  }
  return structuredClone(value);
}

class GeminiStreamDecoder {
  readonly #parts: JsonObject[] = [];
  readonly #calls = new Map<string, StoredCall>();
  #events = 0;
  #usage: ProviderUsage | null = null;
  #finishReason: string | null = null;
  #responseId: string | null = null;
  #modelVersion: string | null = null;
  #terminal = false;

  *consume(block: string): Generator<ProviderEvent> {
    if (this.#terminal) throw invalid("Gemini stream continued after completion");
    this.#events += 1;
    if (
      this.#events > MAX_EVENT_COUNT ||
      new TextEncoder().encode(block).byteLength > MAX_EVENT_BYTES
    ) {
      throw invalid("Gemini stream exceeded its limits");
    }
    const data = block.split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data.length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      throw invalid();
    }
    if (!isRecord(value)) throw invalid();
    this.#stableMetadata(value);
    if (value.promptFeedback !== undefined) {
      if (!isRecord(value.promptFeedback)) {
        throw invalid("Gemini prompt feedback was invalid");
      }
      if (value.promptFeedback.blockReason !== undefined) {
        throw invalid("Gemini blocked the prompt");
      }
    }
    if (value.usageMetadata !== undefined) {
      this.#usage = decodeUsage(value.usageMetadata);
    }
    if (value.candidates === undefined) return;
    if (!Array.isArray(value.candidates) || value.candidates.length !== 1) {
      throw invalid("Gemini candidate count was invalid");
    }
    const candidate = value.candidates[0];
    if (!isRecord(candidate) || (candidate.index !== undefined && candidate.index !== 0)) {
      throw invalid("Gemini candidate was invalid");
    }
    if (candidate.finishReason !== undefined) {
      if (typeof candidate.finishReason !== "string" || this.#finishReason !== null) {
        throw invalid("Gemini finish reason was invalid");
      }
      this.#finishReason = candidate.finishReason;
    }
    if (candidate.content === undefined) return;
    if (!isRecord(candidate.content) || candidate.content.role !== "model" ||
      !Array.isArray(candidate.content.parts)) {
      throw invalid("Gemini candidate content was invalid");
    }
    for (const rawPart of candidate.content.parts) {
      if (!isRecord(rawPart)) throw invalid("Gemini content part was invalid");
      const part = exactPart(rawPart);
      this.#parts.push(part);
      if (typeof part.text === "string") {
        if (part.functionCall !== undefined || part.text.length === 0) continue;
        yield {
          type: part.thought === true ? "reasoning_delta" : "text_delta",
          text: part.text,
        };
        continue;
      }
      if (!isRecord(part.functionCall) || part.thought === true) {
        if (part.thoughtSignature !== undefined && part.functionCall === undefined) continue;
        throw invalid("Gemini content part was invalid");
      }
      const providerId = part.functionCall.id;
      const name = part.functionCall.name;
      const args = part.functionCall.args;
      if (
        (providerId !== undefined &&
          (typeof providerId !== "string" || !IDENTIFIER.test(providerId))) ||
        typeof name !== "string" || !TOOL_NAME.test(name) || !isRecord(args)
      ) {
        throw invalid("Gemini function call was invalid");
      }
      const id = typeof providerId === "string"
        ? providerId
        : `gemini-${globalThis.crypto.randomUUID()}`;
      if (this.#calls.has(id)) throw invalid("Gemini function call was duplicated");
      this.#calls.set(id, { name, providerId: providerId ?? null });
      const call: ToolCall = { id, name, arguments: structuredClone(args) };
      yield { type: "tool_call", call };
    }
  }

  finish(): DecodedCompletion {
    if (this.#terminal || this.#finishReason === null || this.#parts.length === 0) {
      throw invalid("Gemini stream ended unexpectedly");
    }
    this.#terminal = true;
    const stopReason = this.#finishReason === "MAX_TOKENS"
      ? "length"
      : this.#finishReason === "STOP"
      ? this.#calls.size > 0 ? "tool_calls" : "complete"
      : null;
    if (stopReason === null) throw invalid("Gemini did not complete the response");
    return {
      content: { role: "model", parts: structuredClone(this.#parts) },
      calls: new Map(this.#calls),
      usage: this.#usage,
      stopReason,
    };
  }

  #stableMetadata(value: JsonObject): void {
    for (const [field, current] of [
      ["responseId", this.#responseId],
      ["modelVersion", this.#modelVersion],
    ] as const) {
      const candidate = value[field];
      if (candidate === undefined) continue;
      if (typeof candidate !== "string" || !IDENTIFIER.test(candidate) ||
        (current !== null && candidate !== current)) {
        throw invalid("Gemini response metadata was invalid");
      }
      if (field === "responseId") this.#responseId = candidate;
      else this.#modelVersion = candidate;
    }
  }
}

export class RemoteGeminiGenerateContentProvider
  implements ConnectionBoundModelProvider {
  readonly id: string;
  readonly adapterId = "gemini-generate-content";
  readonly inputModalities = ["text", "image"] as const;
  readonly harnessProfile = NATIVE_TOOL_USE_PROFILE;
  readonly connectionId: string;
  readonly #apiKey: string;
  readonly #fetch: Fetch;
  readonly #endpoint: string;
  readonly #ownerInstanceId = globalThis.crypto.randomUUID();
  readonly #continuations = new Map<string, StoredContinuation>();
  #storedBytes = 0;

  constructor(options: RemoteGeminiGenerateContentProviderOptions) {
    if (!IDENTIFIER.test(options.connectionId) || !validCredential(options.apiKey)) {
      throw new TypeError("Remote Gemini connection is invalid");
    }
    this.id = options.providerId;
    this.connectionId = options.connectionId;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#endpoint = endpoint(options.providerId);
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const messages = this.#recoverCompletedHistory(request);
    const body = requestBody(
      { ...request, messages },
      (handle) => this.#loadContinuation(handle, request),
    );
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#endpoint}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          redirect: "manual",
          signal: request.signal,
          headers: {
            accept: "text/event-stream",
            "content-type": "application/json",
            "x-goog-api-client": `recurs/${RECURS_VERSION}`,
            "x-goog-api-key": this.#apiKey,
          },
          body,
        },
      );
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw transportError(request.signal);
    }
    if (!response.ok) throw responseError(response);
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
      throw invalid("Gemini response had an invalid content type");
    }
    const reader = response.body?.getReader();
    if (reader === undefined) throw invalid("Gemini response had no body");
    const textDecoder = new TextDecoder("utf-8", { fatal: true });
    const stream = new GeminiStreamDecoder();
    const echoGuard = new CredentialEchoGuard(this.#apiKey);
    let buffer = "";
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        echoGuard.inspect(chunk.value);
        bytes += chunk.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw invalid("Gemini response was too large");
        }
        try {
          buffer += textDecoder.decode(chunk.value, { stream: true });
        } catch {
          throw invalid("Gemini response was not valid UTF-8");
        }
        const blocks = buffer.split(/\r?\n\r?\n/u);
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          if (block.length > 0) yield* stream.consume(block);
        }
      }
      try {
        buffer += textDecoder.decode();
      } catch {
        throw invalid("Gemini response was not valid UTF-8");
      }
      if (buffer.trim().length > 0) yield* stream.consume(buffer.trimEnd());
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw transportError(request.signal);
    } finally {
      reader.releaseLock();
    }
    const completion = stream.finish();
    if (completion.usage !== null) yield { type: "usage", ...completion.usage };
    const handle = this.#storeContinuation(completion, request);
    if (handle !== null) yield { type: "provider_state", handle };
    yield { type: "done", stopReason: completion.stopReason };
  }

  close(): void {
    this.#continuations.clear();
    this.#storedBytes = 0;
  }

  #loadContinuation(
    handle: DirectContinuationHandle,
    request: ProviderRequest,
  ): StoredContinuation {
    const stored = this.#continuations.get(handle.id);
    if (stored === undefined || !this.#continuationAvailable(handle, request, stored)) {
      throw invalid("Gemini continuation state is unavailable in this process");
    }
    return stored;
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
      handle.connectionId === this.connectionId &&
      handle.adapterId === this.adapterId && handle.modelId === request.model &&
      handle.backendFingerprint === authorization.backendFingerprint &&
      handle.recursSessionId === authorization.sessionId &&
      handle.status === "committed" && handle.stateVersion === 1 &&
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
    const firstNonSystem = request.messages.findIndex((message) => message.role !== "system");
    const leadingSystem = request.messages.slice(
      0,
      firstNonSystem === -1 ? request.messages.length : firstNonSystem,
    );
    return [
      ...leadingSystem,
      ...(request.messages.slice(boundary + 1) as readonly ProviderBackedMessage[]),
    ];
  }

  #recoverableExpiredContinuation(
    handle: DirectContinuationHandle,
    request: ProviderRequest,
  ): boolean {
    const authorization = request.directContext?.authorization;
    return authorization !== undefined && !this.#continuations.has(handle.id) &&
      handle.storageClass === "process_scoped" && handle.ownerInstanceId !== undefined &&
      handle.ownerInstanceId !== this.#ownerInstanceId &&
      handle.connectionId === this.connectionId && handle.adapterId === this.adapterId &&
      handle.modelId === request.model &&
      handle.backendFingerprint === authorization.backendFingerprint &&
      handle.recursSessionId === authorization.sessionId && handle.status === "committed";
  }

  #storeContinuation(
    completion: DecodedCompletion,
    request: ProviderRequest,
  ): DirectContinuationHandle | null {
    if (completion.calls.size === 0) return null;
    const authorization = request.directContext?.authorization;
    if (
      authorization === undefined || authorization.turnId === null ||
      authorization.operation !== "run" ||
      authorization.connectionId !== this.connectionId ||
      authorization.modelId !== request.model
    ) {
      throw invalid("Gemini tool continuation lacked an authorized run context");
    }
    const bytes = new TextEncoder().encode(JSON.stringify(completion.content)).byteLength;
    if (
      this.#continuations.size >= MAX_STORED_HANDLES ||
      this.#storedBytes + bytes > MAX_STORED_BYTES
    ) {
      throw invalid("Gemini continuation storage was full");
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
    this.#continuations.set(handle.id, {
      handle,
      content: structuredClone(completion.content),
      calls: new Map(completion.calls),
      bytes,
    });
    this.#storedBytes += bytes;
    return handle;
  }
}
