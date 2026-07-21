import { RECURS_VERSION } from "@recurs/contracts";

import { CredentialEchoGuard } from "./credential-echo-guard.js";
import { environmentByokManifest } from "./environment-provider-policy.js";
import { ProviderError } from "./types.js";

const ANTHROPIC_VERSION = "2023-06-01";
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const CONTROL_CHARACTER = /\p{Cc}/u;
const MAX_ANTHROPIC_PAGE_BYTES = 2 * 1_024 * 1_024;
const MAX_GEMINI_PAGE_BYTES = 4 * 1_024 * 1_024;
const MAX_OPENAI_CATALOG_BYTES = 4 * 1_024 * 1_024;
const MAX_MODELS = 1_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = Math.ceil(MAX_MODELS / PAGE_LIMIT);
const DEFAULT_TIMEOUT_MS = 10_000;
const GEMINI_PAGE_TOKEN = /^[A-Za-z0-9._~+/=-]{1,4096}$/u;

type Fetch = typeof globalThis.fetch;

export interface EnvironmentModelDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: string | null;
  readonly maxInputTokens: number | null;
  readonly maxOutputTokens: number | null;
}

type ModelDiscoveryProfile =
  | { readonly kind: "anthropic"; readonly origin: string }
  | { readonly kind: "gemini"; readonly origin: string }
  | { readonly kind: "openai"; readonly origin: string };

const OPENAI_MODEL_DISCOVERY_ORIGINS: Readonly<Record<string, string>> =
  Object.freeze({
    "openai-api": "https://api.openai.com/v1",
    "openrouter-api": "https://openrouter.ai/api/v1",
    "deepseek-api": "https://api.deepseek.com",
    "minimax-api": "https://api.minimax.io/v1",
  });

export interface EnvironmentModelDiscoveryOptions {
  readonly providerId: string;
  readonly apiKey: string;
  readonly fetch?: Fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCredential(value: string): boolean {
  return value.length > 0 && value.length <= 8_192 &&
    [...value].every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x21 && codePoint <= 0x7e;
    });
}

function discoveryProfile(providerId: string): ModelDiscoveryProfile | null {
  const manifest = environmentByokManifest(providerId);
  const origin = manifest?.endpoints.find((endpoint) => endpoint.kind === "origin");
  if (
    manifest?.protocol === "gemini_generate_content" &&
    manifest.id === "google-gemini-api" &&
    origin?.value === "https://generativelanguage.googleapis.com/v1beta"
  ) {
    return { kind: "gemini", origin: origin.value };
  }
  if (
    manifest?.protocol !== "anthropic_messages" ||
    origin?.value !== "https://api.anthropic.com/v1"
  ) {
    const reviewedOrigin = OPENAI_MODEL_DISCOVERY_ORIGINS[providerId];
    return (manifest?.protocol === "openai_chat" ||
        manifest?.protocol === "openai_responses") &&
        reviewedOrigin !== undefined && origin?.value === reviewedOrigin
      ? { kind: "openai", origin: reviewedOrigin }
      : null;
  }
  return { kind: "anthropic", origin: origin.value };
}

export function hasEnvironmentProviderModelDiscovery(
  providerId: string,
): boolean {
  return discoveryProfile(providerId) !== null;
}

function responseError(response: Response): ProviderError {
  if (response.status === 401 || response.status === 403) {
    return new ProviderError("authentication", "Provider authentication failed", false);
  }
  if (response.status === 429) {
    return new ProviderError("rate_limit", "Provider rate limit reached", true);
  }
  if (response.status >= 300 && response.status < 400) {
    return new ProviderError("transport", "Provider attempted a redirect", false);
  }
  return new ProviderError(
    "transport",
    `Provider returned HTTP ${response.status}`,
    response.status >= 500,
  );
}

async function readJson(
  response: Response,
  credential: string,
  maxBytes: number,
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ProviderError("invalid_response", "Provider model page was too large", false);
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new ProviderError("invalid_response", "Provider model page was empty", false);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const echoGuard = new CredentialEchoGuard(credential);
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the bounded invalid-response classification.
        }
        throw new ProviderError("invalid_response", "Provider model page was too large", false);
      }
      echoGuard.inspect(chunk.value);
      try {
        text += decoder.decode(chunk.value, { stream: true });
      } catch {
        throw new ProviderError("invalid_response", "Provider model page was invalid", false);
      }
    }
    try {
      text += decoder.decode();
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProviderError("invalid_response", "Provider model page was invalid", false);
    }
  } finally {
    reader.releaseLock();
  }
}

function optionalTokenLimit(value: unknown): number | null {
  if (value === null) return null;
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : NaN;
}

function anthropicModel(value: unknown): EnvironmentModelDescriptor {
  if (
    !isRecord(value) ||
    value.type !== "model" ||
    typeof value.id !== "string" ||
    !MODEL_ID.test(value.id) ||
    typeof value.display_name !== "string" ||
    value.display_name.trim().length === 0 ||
    value.display_name.length > 256 ||
    CONTROL_CHARACTER.test(value.display_name) ||
    typeof value.created_at !== "string" ||
    value.created_at.length === 0 ||
    value.created_at.length > 64 ||
    CONTROL_CHARACTER.test(value.created_at) ||
    !Number.isFinite(Date.parse(value.created_at))
  ) {
    throw new ProviderError("invalid_response", "Provider model entry was invalid", false);
  }
  const maxInputTokens = optionalTokenLimit(value.max_input_tokens);
  const maxOutputTokens = optionalTokenLimit(value.max_tokens);
  if (Number.isNaN(maxInputTokens) || Number.isNaN(maxOutputTokens)) {
    throw new ProviderError("invalid_response", "Provider model entry was invalid", false);
  }
  return Object.freeze({
    id: value.id,
    displayName: value.display_name,
    createdAt: value.created_at,
    maxInputTokens,
    maxOutputTokens,
  });
}

function anthropicPage(value: unknown): {
  models: readonly EnvironmentModelDescriptor[];
  hasMore: boolean;
  firstId: string | null;
  lastId: string | null;
} {
  if (!isRecord(value) || !Array.isArray(value.data) || typeof value.has_more !== "boolean") {
    throw new ProviderError("invalid_response", "Provider model page was invalid", false);
  }
  const models = Object.freeze(value.data.map(anthropicModel));
  const firstId = value.first_id === null ? null : value.first_id;
  const lastId = value.last_id === null ? null : value.last_id;
  if (
    (firstId !== null && (typeof firstId !== "string" || !MODEL_ID.test(firstId))) ||
    (lastId !== null && (typeof lastId !== "string" || !MODEL_ID.test(lastId))) ||
    (models.length === 0 && (firstId !== null || lastId !== null || value.has_more)) ||
    (models.length > 0 &&
      (firstId !== models[0]?.id || lastId !== models.at(-1)?.id))
  ) {
    throw new ProviderError("invalid_response", "Provider model page was invalid", false);
  }
  return { models, hasMore: value.has_more, firstId, lastId };
}

function optionalOpenAITokenLimit(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : NaN;
}

function openAICreatedAt(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 253_402_300_799) {
    throw new ProviderError("invalid_response", "Provider model entry was invalid", false);
  }
  return new Date(Number(value) * 1_000).toISOString();
}

function openAIModel(value: unknown): EnvironmentModelDescriptor {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !MODEL_ID.test(value.id) ||
    (value.object !== undefined && value.object !== "model") ||
    (value.name !== undefined &&
      (typeof value.name !== "string" || value.name.trim().length === 0 ||
        value.name.length > 256 || CONTROL_CHARACTER.test(value.name)))
  ) {
    throw new ProviderError("invalid_response", "Provider model entry was invalid", false);
  }
  const topProvider = value.top_provider;
  if (topProvider !== undefined && topProvider !== null && !isRecord(topProvider)) {
    throw new ProviderError("invalid_response", "Provider model entry was invalid", false);
  }
  const maxInputTokens = optionalOpenAITokenLimit(value.context_length);
  const maxOutputTokens = optionalOpenAITokenLimit(
    isRecord(topProvider) ? topProvider.max_completion_tokens : undefined,
  );
  if (Number.isNaN(maxInputTokens) || Number.isNaN(maxOutputTokens)) {
    throw new ProviderError("invalid_response", "Provider model entry was invalid", false);
  }
  return Object.freeze({
    id: value.id,
    displayName: typeof value.name === "string" ? value.name : value.id,
    createdAt: openAICreatedAt(value.created),
    maxInputTokens,
    maxOutputTokens,
  });
}

function openAICollection(value: unknown): readonly EnvironmentModelDescriptor[] {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    value.data.length > MAX_MODELS ||
    (value.object !== undefined && value.object !== "list")
  ) {
    throw new ProviderError("invalid_response", "Provider model catalog was invalid", false);
  }
  const models = value.data.map(openAIModel);
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw new ProviderError("invalid_response", "Provider model catalog was invalid", false);
  }
  return Object.freeze(models);
}

function geminiModel(value: unknown): EnvironmentModelDescriptor | null {
  if (
    !isRecord(value) || typeof value.name !== "string" ||
    !value.name.startsWith("models/") || !MODEL_ID.test(value.name.slice(7)) ||
    typeof value.displayName !== "string" || value.displayName.trim().length === 0 ||
    value.displayName.length > 128 || CONTROL_CHARACTER.test(value.displayName) ||
    !Array.isArray(value.supportedGenerationMethods) ||
    value.supportedGenerationMethods.length > 64 ||
    value.supportedGenerationMethods.some((method) =>
      typeof method !== "string" || method.length === 0 || method.length > 128 ||
      CONTROL_CHARACTER.test(method)
    )
  ) {
    throw new ProviderError("invalid_response", "Provider model entry was invalid", false);
  }
  const maxInputTokens = optionalTokenLimit(value.inputTokenLimit);
  const maxOutputTokens = optionalTokenLimit(value.outputTokenLimit);
  if (Number.isNaN(maxInputTokens) || Number.isNaN(maxOutputTokens)) {
    throw new ProviderError("invalid_response", "Provider model entry was invalid", false);
  }
  if (!value.supportedGenerationMethods.includes("generateContent")) return null;
  return Object.freeze({
    id: value.name.slice(7),
    displayName: value.displayName,
    createdAt: null,
    maxInputTokens,
    maxOutputTokens,
  });
}

function geminiPage(value: unknown): {
  models: readonly EnvironmentModelDescriptor[];
  nextPageToken: string | null;
} {
  if (!isRecord(value) || !Array.isArray(value.models) || value.models.length > MAX_MODELS) {
    throw new ProviderError("invalid_response", "Provider model page was invalid", false);
  }
  const nextPageToken = value.nextPageToken === undefined
    ? null
    : value.nextPageToken;
  if (
    nextPageToken !== null &&
    (typeof nextPageToken !== "string" || !GEMINI_PAGE_TOKEN.test(nextPageToken))
  ) {
    throw new ProviderError("invalid_response", "Provider model cursor was invalid", false);
  }
  return {
    models: Object.freeze(value.models.map(geminiModel).filter(
      (model): model is EnvironmentModelDescriptor => model !== null,
    )),
    nextPageToken,
  };
}

function boundedSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut(): boolean; dispose(): void } {
  const controller = new AbortController();
  let timeoutReached = false;
  const abort = (): void => controller.abort();
  if (parent?.aborted === true) controller.abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    dispose() {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function assertActive(
  parent: AbortSignal | undefined,
  bounded: ReturnType<typeof boundedSignal>,
): void {
  if (!bounded.signal.aborted) return;
  if (parent?.aborted === true) {
    throw new ProviderError("cancelled", "Provider request cancelled", false);
  }
  throw new ProviderError("transport", "Provider model discovery timed out", true);
}

async function requestJson(
  url: string,
  headers: Readonly<Record<string, string>>,
  credential: string,
  maxBytes: number,
  options: EnvironmentModelDiscoveryOptions,
  bounded: ReturnType<typeof boundedSignal>,
): Promise<unknown> {
  assertActive(options.signal, bounded);
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(url, {
      method: "GET",
      redirect: "manual",
      signal: bounded.signal,
      headers,
    });
  } catch {
    if (options.signal?.aborted === true) {
      throw new ProviderError("cancelled", "Provider request cancelled", false);
    }
    throw new ProviderError(
      "transport",
      bounded.timedOut() ? "Provider model discovery timed out" : "Provider could not be reached",
      true,
    );
  }
  assertActive(options.signal, bounded);
  if (!response.ok) throw responseError(response);
  try {
    const decoded = await readJson(response, credential, maxBytes);
    assertActive(options.signal, bounded);
    return decoded;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (options.signal?.aborted === true) {
      throw new ProviderError("cancelled", "Provider request cancelled", false);
    }
    throw new ProviderError(
      "transport",
      bounded.timedOut()
        ? "Provider model discovery timed out"
        : "Provider response could not be read",
      true,
    );
  }
}

export async function listEnvironmentProviderModels(
  options: EnvironmentModelDiscoveryOptions,
): Promise<readonly EnvironmentModelDescriptor[]> {
  if (!validCredential(options.apiKey)) {
    throw new TypeError("Provider model discovery credential is invalid");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError("Provider model discovery timeout is invalid");
  }
  const profile = discoveryProfile(options.providerId);
  if (profile === null) {
    throw new TypeError("Provider does not have reviewed model discovery");
  }
  const bounded = boundedSignal(options.signal, timeoutMs);
  if (profile.kind === "gemini") {
    const models: EnvironmentModelDescriptor[] = [];
    const seenModels = new Set<string>();
    const seenTokens = new Set<string>();
    let pageToken: string | null = null;
    try {
      for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
        const query = new URLSearchParams({ pageSize: String(PAGE_LIMIT) });
        if (pageToken !== null) query.set("pageToken", pageToken);
        const decoded = await requestJson(
          `${profile.origin}/models?${query}`,
          {
            accept: "application/json",
            "x-goog-api-client": `recurs/${RECURS_VERSION}`,
            "x-goog-api-key": options.apiKey,
          },
          options.apiKey,
          MAX_GEMINI_PAGE_BYTES,
          options,
          bounded,
        );
        const current = geminiPage(decoded);
        for (const model of current.models) {
          if (seenModels.has(model.id) || models.length >= MAX_MODELS) {
            throw new ProviderError(
              "invalid_response",
              "Provider model catalog was invalid",
              false,
            );
          }
          seenModels.add(model.id);
          models.push(model);
        }
        if (current.nextPageToken === null) return Object.freeze(models);
        if (seenTokens.has(current.nextPageToken)) {
          throw new ProviderError(
            "invalid_response",
            "Provider model cursor was invalid",
            false,
          );
        }
        seenTokens.add(current.nextPageToken);
        pageToken = current.nextPageToken;
      }
      throw new ProviderError(
        "invalid_response",
        "Provider model catalog was too large",
        false,
      );
    } finally {
      bounded.dispose();
    }
  }
  if (profile.kind === "openai") {
    try {
      const decoded = await requestJson(
        `${profile.origin}/models`,
        {
          accept: "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        options.apiKey,
        MAX_OPENAI_CATALOG_BYTES,
        options,
        bounded,
      );
      return openAICollection(decoded);
    } finally {
      bounded.dispose();
    }
  }
  const models: EnvironmentModelDescriptor[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  try {
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
      const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (cursor !== null) query.set("after_id", cursor);
      const decoded = await requestJson(
        `${profile.origin}/models?${query}`,
        {
          accept: "application/json",
          "anthropic-version": ANTHROPIC_VERSION,
          "x-api-key": options.apiKey,
        },
        options.apiKey,
        MAX_ANTHROPIC_PAGE_BYTES,
        options,
        bounded,
      );
      const current = anthropicPage(decoded);
      for (const entry of current.models) {
        if (seen.has(entry.id) || models.length >= MAX_MODELS) {
          throw new ProviderError("invalid_response", "Provider model catalog was invalid", false);
        }
        seen.add(entry.id);
        models.push(entry);
      }
      if (!current.hasMore) return Object.freeze(models);
      if (current.lastId === null || current.lastId === cursor) {
        throw new ProviderError("invalid_response", "Provider model cursor was invalid", false);
      }
      cursor = current.lastId;
    }
    throw new ProviderError("invalid_response", "Provider model catalog was too large", false);
  } finally {
    bounded.dispose();
  }
}
