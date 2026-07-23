import type {
  AccessKind,
  AdapterKind,
  BillingPolicy,
  ProviderEndpoint,
  ProviderManifest,
  ProviderProtocol,
  ProviderRegionAvailability,
  ProviderUsagePolicy,
  SupportStatus,
} from "@recurs/contracts";
import {
  ProviderManifestRegistry,
  isEnvironmentByokManifest,
} from "@recurs/providers";

export type OnboardingStatus =
  | "runnable"
  | "runnable_byok"
  | "blocked";

export interface OnboardingCatalogEntry {
  id: string;
  displayName: string;
  adapterKind: AdapterKind;
  accessKind: AccessKind;
  protocol: ProviderProtocol;
  status: OnboardingStatus;
  supportStatus: SupportStatus;
  connectionOwner:
    | ProviderManifest["credentialOwner"]
    | "process_environment";
  endpoints: readonly ProviderEndpoint[];
  regionAvailability: ProviderRegionAvailability;
  billing: BillingPolicy;
  restrictions: readonly string[];
  policy: ProviderUsagePolicy;
}

export interface OnboardingCatalogOptions {
  now?: () => Date;
}

export interface OnboardingCatalogListOptions {
  includeBlocked?: boolean;
  now?: Date;
}

const RUNNABLE_IDS = new Set([
  "openai-codex-chatgpt",
  "ollama-local",
  "lm-studio-local",
]);

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function currentPolicy(manifest: ProviderManifest, now: Date): boolean {
  const milliseconds = now.getTime();
  const reviewedAt = Date.parse(`${manifest.usagePolicy.reviewedAt}T00:00:00.000Z`);
  const expiresAt = Date.parse(manifest.usagePolicy.expiresAt);
  return (
    Number.isFinite(milliseconds) &&
    milliseconds >= reviewedAt &&
    milliseconds < expiresAt
  );
}

function statusFor(
  manifest: ProviderManifest,
  now: Date,
): OnboardingStatus {
  if (!currentPolicy(manifest, now)) return "blocked";
  if (manifest.billingPolicy.providerFallback === "unknown") return "blocked";
  if (
    manifest.supportStatus === "blocked" ||
    manifest.supportStatus === "blocked_pending_written_approval"
  ) {
    return "blocked";
  }
  if (manifest.runnable && RUNNABLE_IDS.has(manifest.id)) return "runnable";
  if (isEnvironmentByokManifest(manifest)) return "runnable_byok";
  return "blocked";
}

function restrictionsFor(
  manifest: ProviderManifest,
  status: OnboardingStatus,
  now: Date,
): readonly string[] {
  const restrictions = [manifest.usagePolicy.evidenceSummary];
  if (manifest.endpointEvidence !== undefined) {
    restrictions.push(manifest.endpointEvidence);
  }
  for (const rule of manifest.usagePolicy.rules) restrictions.push(rule.reason);
  if (!currentPolicy(manifest, now)) {
    restrictions.push("The reviewed usage policy is expired or not yet current.");
  } else if (manifest.billingPolicy.providerFallback === "unknown") {
    restrictions.push("Unknown provider billing fallback is blocked.");
  } else if (status === "runnable_byok") {
    restrictions.push(
      "BYOK stores only provider/model metadata, an environment-variable name, and a one-way credential fingerprint; the key remains in the process environment.",
    );
  } else if (status === "blocked") {
    restrictions.push("This path is blocked by its reviewed support or runtime policy.");
  }
  if (manifest.usagePolicy.officialRuntimeRequired) {
    restrictions.push("The official provider runtime is required.");
  }
  if (manifest.usagePolicy.accountSharingForbidden) {
    restrictions.push("Account sharing is forbidden.");
  }
  return Object.freeze([...new Set(restrictions)]);
}

function entryFor(
  manifest: ProviderManifest,
  now: Date,
): OnboardingCatalogEntry {
  const status = statusFor(manifest, now);
  return deepFreeze({
    id: manifest.id,
    displayName: manifest.displayName,
    adapterKind: manifest.adapterKind,
    accessKind: manifest.accessKind,
    protocol: manifest.protocol,
    status,
    supportStatus: manifest.supportStatus,
    connectionOwner: isEnvironmentByokManifest(manifest)
      ? "process_environment"
      : manifest.credentialOwner,
    endpoints: structuredClone(manifest.endpoints),
    regionAvailability: structuredClone(manifest.regionAvailability),
    billing: structuredClone(manifest.billingPolicy),
    restrictions: restrictionsFor(manifest, status, now),
    policy: structuredClone(manifest.usagePolicy),
  });
}

const STATUS_ORDER: Readonly<Record<OnboardingStatus, number>> = {
  runnable: 0,
  runnable_byok: 1,
  blocked: 2,
};

export class OnboardingCatalog {
  readonly #registry: ProviderManifestRegistry;
  readonly #now: () => Date;

  constructor(
    registry: ProviderManifestRegistry = new ProviderManifestRegistry(),
    options: OnboardingCatalogOptions = {},
  ) {
    this.#registry = registry;
    this.#now = options.now ?? (() => new Date());
  }

  list(options: OnboardingCatalogListOptions = {}): readonly OnboardingCatalogEntry[] {
    const now = options.now ?? this.#now();
    const entries = this.#registry
      .list({ includeBlocked: true })
      .map((manifest, index) => ({ entry: entryFor(manifest, now), index }))
      .sort((left, right) =>
        STATUS_ORDER[left.entry.status] - STATUS_ORDER[right.entry.status] ||
        left.index - right.index,
      )
      .map(({ entry }) => entry)
      .filter(
        (entry) => options.includeBlocked === true || entry.status !== "blocked",
      );
    return deepFreeze(entries.map((entry) => structuredClone(entry)));
  }
}
