import { CredentialEchoGuard } from "./credential-echo-guard.js";
import { environmentByokManifest } from "./environment-provider-policy.js";
import { ProviderError } from "./types.js";

const ANTHROPIC_VERSION = "2023-06-01";
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const CONTROL_CHARACTER = /\p{Cc}/u;
const MAX_PAGE_BYTES = 2 * 1_024 * 1_024;
const MAX_MODELS = 1_000;
const PAGE_LIMIT = 100;
const MAX_PAGES = Math.ceil(MAX_MODELS / PAGE_LIMIT);
const DEFAULT_TIMEOUT_MS = 10_000;

type Fetch = typeof globalThis.fetch;

export interface EnvironmentModelDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: string;
  readonly maxInputTokens: number | null;
  readonly maxOutputTokens: number | null;
}

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

function anthropicOrigin(providerId: string): string {
  const manifest = environmentByokManifest(providerId);
  const origin = manifest?.endpoints.find((endpoint) => endpoint.kind === "origin");
  if (
    manifest?.protocol !== "anthropic_messages" ||
    origin?.value !== "https://api.anthropic.com/v1"
  ) {
    throw new TypeError("Provider does not have reviewed model discovery");
  }
  return origin.value;
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
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) {
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
      if (bytes > MAX_PAGE_BYTES) {
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

function model(value: unknown): EnvironmentModelDescriptor {
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

function page(value: unknown): {
  models: readonly EnvironmentModelDescriptor[];
  hasMore: boolean;
  firstId: string | null;
  lastId: string | null;
} {
  if (!isRecord(value) || !Array.isArray(value.data) || typeof value.has_more !== "boolean") {
    throw new ProviderError("invalid_response", "Provider model page was invalid", false);
  }
  const models = Object.freeze(value.data.map(model));
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
  const origin = anthropicOrigin(options.providerId);
  const fetcher = options.fetch ?? globalThis.fetch;
  const bounded = boundedSignal(options.signal, timeoutMs);
  const models: EnvironmentModelDescriptor[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  try {
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex += 1) {
      assertActive(options.signal, bounded);
      const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (cursor !== null) query.set("after_id", cursor);
      let response: Response;
      try {
        response = await fetcher(`${origin}/models?${query}`, {
          method: "GET",
          redirect: "manual",
          signal: bounded.signal,
          headers: {
            accept: "application/json",
            "anthropic-version": ANTHROPIC_VERSION,
            "x-api-key": options.apiKey,
          },
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
      let decoded: unknown;
      try {
        decoded = await readJson(response, options.apiKey);
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
      assertActive(options.signal, bounded);
      const current = page(decoded);
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
