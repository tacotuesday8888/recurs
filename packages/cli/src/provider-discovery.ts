import {
  MODELS_DEV_CATALOG_URL,
  detectLocalRuntimes,
  fetchProviderCatalog,
  searchProviderCatalog,
  type DiscoveredCatalogProvider,
  type LocalRuntimeDetection,
  type ProviderCatalogSnapshot,
} from "@recurs/providers";

import {
  listAccountSummaries,
  listProviderSummaries,
  type AccountSummary,
} from "./provider-account.js";

export interface ProviderDiscoveryDependencies {
  readonly fetchCatalog?: (
    signal?: AbortSignal,
  ) => Promise<ProviderCatalogSnapshot>;
  readonly detectLocal?: (
    signal?: AbortSignal,
  ) => Promise<readonly LocalRuntimeDetection[]>;
  readonly listAccounts?: () => Promise<readonly AccountSummary[]>;
}

export interface ProviderDiscoveryOverview {
  readonly accounts: readonly AccountSummary[];
  readonly localRuntimes: readonly LocalRuntimeDetection[];
  readonly catalog: {
    readonly source: typeof MODELS_DEV_CATALOG_URL;
    readonly total: number;
    readonly matches: readonly DiscoveredCatalogProvider[];
    readonly unavailable?: string;
  };
}

export async function discoverProviderCatalog(
  query = "",
  signal?: AbortSignal,
): Promise<ProviderCatalogSnapshot> {
  const snapshot = await fetchProviderCatalog(
    signal === undefined ? {} : { signal },
  );
  return Object.freeze({
    source: snapshot.source,
    providers: searchProviderCatalog(snapshot.providers, query),
  });
}

export async function providerDiscoveryOverview(
  dataDirectory: string,
  query = "",
  signal?: AbortSignal,
  dependencies: ProviderDiscoveryDependencies = {},
): Promise<ProviderDiscoveryOverview> {
  const accountsPromise = dependencies.listAccounts?.() ??
    listAccountSummaries(dataDirectory);
  const localPromise = dependencies.detectLocal?.(signal) ??
    detectLocalRuntimes(signal === undefined ? {} : { signal });
  const catalogPromise = dependencies.fetchCatalog?.(signal) ??
    fetchProviderCatalog(signal === undefined ? {} : { signal });
  const [accounts, localRuntimes, catalog] = await Promise.allSettled([
    accountsPromise,
    localPromise,
    catalogPromise,
  ]);
  const catalogProviders = catalog.status === "fulfilled"
    ? catalog.value.providers
    : [];
  return Object.freeze({
    accounts: accounts.status === "fulfilled" ? accounts.value : [],
    localRuntimes: localRuntimes.status === "fulfilled"
      ? localRuntimes.value
      : [],
    catalog: Object.freeze({
      source: MODELS_DEV_CATALOG_URL,
      total: catalogProviders.length,
      matches: Object.freeze(
        searchProviderCatalog(catalogProviders, query).slice(0, 12),
      ),
      ...(catalog.status === "rejected"
        ? { unavailable: "The public provider catalog is temporarily unavailable." }
        : {}),
    }),
  });
}

export function providerCatalogText(
  snapshot: ProviderCatalogSnapshot,
): string {
  if (snapshot.providers.length === 0) return "No catalog providers matched.\n";
  return `${snapshot.providers.map((provider) => {
    const endpoint = provider.api === undefined ? "" : ` · ${provider.api}`;
    return `${provider.id} — ${provider.name}\n  ${provider.wire} · ${provider.modelCount} models${endpoint}`;
  }).join("\n\n")}\n`;
}

export function localRuntimeText(
  runtimes: readonly LocalRuntimeDetection[],
): string {
  const detected = runtimes.filter((runtime) => runtime.detected);
  if (detected.length === 0) {
    return "No supported loopback model server was detected.\n";
  }
  return `${detected.map((runtime) =>
    `${runtime.name} — detected\n  ${runtime.baseUrl}`
  ).join("\n\n")}\n`;
}

export function providerOverviewText(
  overview: ProviderDiscoveryOverview,
  query = "",
): string {
  const connected = overview.accounts.length === 0
    ? ["  None yet"]
    : overview.accounts.map((account) =>
      `  ${account.primary ? "*" : "-"} ${account.label} · ${account.modelId}`
    );
  const detected = overview.localRuntimes.filter((runtime) => runtime.detected);
  const local = detected.length === 0
    ? ["  None (only fixed Ollama and LM Studio loopback ports are checked)"]
    : detected.map((runtime) => `  ${runtime.name} · ${runtime.baseUrl}`);
  const normalizedQuery = query.trim();
  const catalog = overview.catalog.unavailable === undefined
    ? normalizedQuery.length === 0
      ? [
          `  Loaded ${overview.catalog.total} providers from ${overview.catalog.source}`,
          "  Search with /provider <name>, for example /provider kimi",
        ]
      : overview.catalog.matches.length === 0
        ? [`  No matches for "${normalizedQuery}"`]
        : overview.catalog.matches.map((provider) =>
          `  ${provider.id} — ${provider.name} · ${provider.modelCount} models`
        )
    : [`  ${overview.catalog.unavailable}`];
  const available = listProviderSummaries().filter((provider) =>
    provider.status === "runnable" || provider.status === "requires_native_broker"
  ).slice(0, 8).map((provider) =>
    `  ${provider.displayName} · ${provider.status.replaceAll("_", " ")}`
  );

  return [
    "Providers",
    "",
    "Connected",
    ...connected,
    "",
    "Detected locally",
    ...local,
    "",
    normalizedQuery.length === 0 ? "Available catalog" : `Catalog matches: ${normalizedQuery}`,
    ...catalog,
    "",
    "Recurs setup paths",
    ...available,
    "",
    "Next: recurs setup codex, recurs setup openai, recurs setup anthropic --model <id>,",
    "      recurs setup kimi --model <id>, or recurs setup local --url <loopback-url> --model <id>.",
    "Catalog entries are discovery metadata, not a claim that every provider is runnable.",
  ].join("\n");
}
