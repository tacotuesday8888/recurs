export const MODELS_DEV_CATALOG_URL = "https://models.dev/api.json";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDERS = 2_000;
const MAX_MODELS_PER_PROVIDER = 4_096;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,255}$/u;

export type CatalogWire =
  | "anthropic"
  | "google"
  | "openai"
  | "openai-compatible"
  | "unknown";

export interface DiscoveredCatalogProvider {
  readonly id: string;
  readonly name: string;
  readonly api?: string;
  readonly wire: CatalogWire;
  readonly modelCount: number;
  readonly modelIds: readonly string[];
}

export interface ProviderCatalogSnapshot {
  readonly source: typeof MODELS_DEV_CATALOG_URL;
  readonly providers: readonly DiscoveredCatalogProvider[];
}

export interface ProviderCatalogOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

export interface LocalRuntimeDetection {
  readonly id: "ollama" | "lm-studio";
  readonly name: string;
  readonly baseUrl: string;
  readonly detected: boolean;
}

export interface LocalRuntimeDetectionOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export class ProviderDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderDiscoveryError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 256
    ? normalized
    : fallback;
}

function normalizedApi(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString().replace(/\/$/u, "")
      : undefined;
  } catch {
    return undefined;
  }
}

function wireFor(npm: unknown, id: string): CatalogWire {
  const hint = `${typeof npm === "string" ? npm : ""} ${id}`.toLowerCase();
  if (hint.includes("anthropic")) return "anthropic";
  if (hint.includes("google") || hint.includes("vertex")) return "google";
  if (hint.includes("openai-compatible")) return "openai-compatible";
  if (hint.includes("openai")) return "openai";
  return "unknown";
}

function normalizeCatalog(value: unknown): readonly DiscoveredCatalogProvider[] {
  if (!isRecord(value)) {
    throw new ProviderDiscoveryError("The provider catalog response is invalid");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_PROVIDERS) {
    throw new ProviderDiscoveryError("The provider catalog is unexpectedly large");
  }
  const providers = entries.flatMap(([id, raw]) => {
    if (!SAFE_ID.test(id) || !isRecord(raw)) return [];
    const models = isRecord(raw.models) ? raw.models : {};
    const modelKeys = Object.keys(models);
    if (modelKeys.length > MAX_MODELS_PER_PROVIDER) {
      throw new ProviderDiscoveryError(
        "A provider catalog entry contains too many models",
      );
    }
    const modelIds = Object.freeze(
      modelKeys
        .filter((modelId) => SAFE_ID.test(modelId))
        .sort((left, right) => left.localeCompare(right)),
    );
    const api = normalizedApi(raw.api);
    const provider: DiscoveredCatalogProvider = {
      id,
      name: normalizedText(raw.name, id),
      wire: wireFor(raw.npm, id),
      modelCount: modelIds.length,
      modelIds,
      ...(api === undefined ? {} : { api }),
    };
    return [Object.freeze(provider)];
  }).sort((left, right) =>
    left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  );
  if (providers.length === 0) {
    throw new ProviderDiscoveryError("The provider catalog contains no usable providers");
  }
  return Object.freeze(providers);
}

function boundedSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (signal?.aborted === true) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    },
  };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ProviderDiscoveryError("The provider catalog response is too large");
  }
  if (response.body === null) {
    throw new ProviderDiscoveryError("The provider catalog response is empty");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        throw new ProviderDiscoveryError("The provider catalog response is too large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderDiscoveryError("The provider catalog response is not valid JSON");
  }
}

export async function fetchProviderCatalog(
  options: ProviderCatalogOptions = {},
): Promise<ProviderCatalogSnapshot> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new ProviderDiscoveryError("The provider catalog timeout is invalid");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) {
    throw new ProviderDiscoveryError("The provider catalog size limit is invalid");
  }
  const bounded = boundedSignal(options.signal, timeoutMs);
  try {
    const response = await fetcher(MODELS_DEV_CATALOG_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: bounded.signal,
    });
    if (!response.ok) {
      throw new ProviderDiscoveryError(
        `The provider catalog request failed (HTTP ${response.status})`,
      );
    }
    return Object.freeze({
      source: MODELS_DEV_CATALOG_URL,
      providers: normalizeCatalog(await readBoundedJson(response, maxBytes)),
    });
  } catch (error) {
    if (error instanceof ProviderDiscoveryError) throw error;
    if (bounded.signal.aborted) {
      throw new ProviderDiscoveryError("The provider catalog request timed out or was cancelled");
    }
    throw new ProviderDiscoveryError("The provider catalog could not be reached");
  } finally {
    bounded.dispose();
  }
}

export function searchProviderCatalog(
  providers: readonly DiscoveredCatalogProvider[],
  query: string,
): readonly DiscoveredCatalogProvider[] {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return Object.freeze([...providers]);
  return Object.freeze(providers.filter((provider) => {
    const haystack = `${provider.id} ${provider.name} ${provider.api ?? ""} ${provider.wire}`
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }));
}

const LOCAL_RUNTIMES = Object.freeze([
  {
    id: "ollama" as const,
    name: "Ollama",
    probeUrl: "http://127.0.0.1:11434/api/tags",
    baseUrl: "http://127.0.0.1:11434/v1",
  },
  {
    id: "lm-studio" as const,
    name: "LM Studio",
    probeUrl: "http://127.0.0.1:1234/v1/models",
    baseUrl: "http://127.0.0.1:1234/v1",
  },
]);

export async function detectLocalRuntimes(
  options: LocalRuntimeDetectionOptions = {},
): Promise<readonly LocalRuntimeDetection[]> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 700;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) {
    throw new ProviderDiscoveryError("The local detection timeout is invalid");
  }
  return Object.freeze(await Promise.all(LOCAL_RUNTIMES.map(async (runtime) => {
    const bounded = boundedSignal(options.signal, timeoutMs);
    let detected: boolean;
    try {
      const response = await fetcher(runtime.probeUrl, {
        method: "GET",
        redirect: "error",
        signal: bounded.signal,
      });
      detected = response.ok;
      await response.body?.cancel().catch(() => undefined);
    } catch {
      detected = false;
    } finally {
      bounded.dispose();
    }
    return Object.freeze({
      id: runtime.id,
      name: runtime.name,
      baseUrl: runtime.baseUrl,
      detected,
    });
  })));
}
