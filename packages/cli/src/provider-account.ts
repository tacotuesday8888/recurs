import type {
  AccessKind,
  AdapterKind,
  BillingSource,
  ProviderManifest,
  ProviderProtocol,
  SupportStatus,
  TeamRunRole,
} from "@recurs/contracts";
import {
  ConnectionLifecycleService,
  FileConnectionRegistry,
  OnboardingCatalog,
  verifyEnvironmentConnection,
  verifyLocalConnection,
  type ConnectionDisconnection,
  type AgentRouteAssignment,
  type ConnectionSummary,
  type ConnectionVerification,
  type ConnectionVerifier,
  type OnboardingStatus,
} from "@recurs/app";
import {
  providerTransportCapability,
} from "@recurs/providers";

import { verifyReviewedDelegatedConnection } from "./delegated-connection.js";

export interface ProviderSummary {
  readonly id: string;
  readonly displayName: string;
  readonly status: OnboardingStatus;
  readonly supportStatus: SupportStatus;
  readonly adapterKind: AdapterKind;
  readonly accessKind: AccessKind;
  readonly protocol: ProviderProtocol;
  readonly connectionOwner:
    | ProviderManifest["credentialOwner"]
    | "process_environment";
  readonly billing: {
    readonly primarySource: BillingSource;
    readonly possibleAdditionalSources: readonly BillingSource[];
    readonly providerFallback: "none" | "user_configured" | "automatic" | "unknown";
    readonly availableSelections: readonly (
      | "provider_default"
      | "strict_primary_only"
      | "allow_declared_additional"
    )[];
  };
  readonly restrictions: readonly string[];
  readonly requiredPolicyClaims: readonly string[];
}

export type AccountSummary = ConnectionSummary;

export type ProviderCapabilityCategory =
  | "cataloged"
  | "activatable"
  | "live-tested"
  | "conditional"
  | "blocked"
  | "unsupported";

export type MissingProviderCapability =
  | "authentication"
  | "model_discovery_readiness_probe"
  | "streaming"
  | "tools"
  | "usage"
  | "errors"
  | "onboarding_backend";

export interface ProviderLiveVerification {
  readonly providerId: string;
  readonly status: "passed" | "failed";
  readonly checkedAt: string;
}

export interface ProviderCapability {
  readonly providerId: string;
  readonly displayName: string;
  readonly category: ProviderCapabilityCategory;
  readonly adapterId: string | null;
  readonly missingCapabilities: readonly MissingProviderCapability[];
  readonly implementationCoverage: "complete" | "partial" | "none";
  readonly liveVerification: {
    readonly status: "passed" | "failed" | "stale" | "not_run";
    readonly checkedAt?: string;
  };
}

export interface ListProviderCapabilitiesOptions {
  readonly providerIds?: readonly string[];
  readonly liveVerification?: readonly ProviderLiveVerification[];
  readonly now?: Date;
}

export type ProviderSummaryGroup = "plans" | "api" | "local";

export function providerSummaryGroup(
  provider: Pick<ProviderSummary, "accessKind">,
): ProviderSummaryGroup {
  if (provider.accessKind === "local") return "local";
  if (
    provider.accessKind === "subscription" ||
    provider.accessKind === "coding_plan"
  ) {
    return "plans";
  }
  return "api";
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const MAX_CAPABILITY_INPUTS = 128;
const LIVE_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const CAPABILITY_ORDER = Object.freeze([
  "authentication",
  "model_discovery_readiness_probe",
  "streaming",
  "tools",
  "usage",
  "errors",
  "onboarding_backend",
] as const satisfies readonly MissingProviderCapability[]);

interface ExecutableProviderFacts {
  readonly adapterId: string | null;
  readonly authentication: boolean;
  readonly modelDiscoveryReadinessProbe: boolean;
  readonly streaming: boolean;
  readonly tools: boolean;
  readonly usage: boolean;
  readonly errors: boolean;
  readonly onboardingBackend: boolean;
}

function executableFacts(
  providerId: string,
  onboardingStatus: OnboardingStatus | undefined,
): ExecutableProviderFacts {
  if (providerId === "openai-codex-chatgpt") {
    return {
      adapterId: "codex-app-server",
      authentication: true,
      modelDiscoveryReadinessProbe: true,
      streaming: true,
      tools: true,
      usage: true,
      errors: true,
      onboardingBackend: onboardingStatus === "runnable",
    };
  }
  if (providerId === "github-copilot-subscription") {
    const transport = providerTransportCapability(providerId);
    return {
      adapterId: transport.adapterId,
      authentication: transport.authentication,
      modelDiscoveryReadinessProbe: transport.modelDiscoveryReadinessProbe,
      streaming: transport.streaming,
      tools: transport.tools,
      usage: transport.usage,
      errors: transport.errors,
      onboardingBackend: onboardingStatus === "runnable",
    };
  }
  if (providerId === "ollama-local" || providerId === "lm-studio-local") {
    return {
      adapterId: "openai-chat-completions",
      authentication: true,
      modelDiscoveryReadinessProbe: true,
      streaming: true,
      tools: true,
      usage: true,
      errors: true,
      onboardingBackend: onboardingStatus === "runnable",
    };
  }
  const transport = providerTransportCapability(providerId);
  return {
    adapterId: transport.adapterId,
    authentication: transport.authentication,
    modelDiscoveryReadinessProbe:
      transport.modelDiscoveryReadinessProbe,
    streaming: transport.streaming,
    tools: transport.tools,
    usage: transport.usage,
    errors: transport.errors,
    onboardingBackend: onboardingStatus === "runnable_byok",
  };
}

function missingCapabilities(
  facts: ExecutableProviderFacts,
): readonly MissingProviderCapability[] {
  const present: Readonly<Record<MissingProviderCapability, boolean>> = {
    authentication: facts.authentication,
    model_discovery_readiness_probe:
      facts.modelDiscoveryReadinessProbe,
    streaming: facts.streaming,
    tools: facts.tools,
    usage: facts.usage,
    errors: facts.errors,
    onboarding_backend: facts.onboardingBackend,
  };
  return Object.freeze(CAPABILITY_ORDER.filter((capability) =>
    !present[capability]
  ));
}

function currentPolicy(
  entry: ReturnType<OnboardingCatalog["list"]>[number],
  now: Date,
): boolean {
  const checkedAt = now.getTime();
  const reviewedAt = Date.parse(`${entry.policy.reviewedAt}T00:00:00.000Z`);
  const expiresAt = Date.parse(entry.policy.expiresAt);
  return Number.isFinite(checkedAt) && checkedAt >= reviewedAt &&
    checkedAt < expiresAt;
}

function liveVerificationByProvider(
  evidence: readonly ProviderLiveVerification[],
): ReadonlyMap<string, ProviderLiveVerification> {
  if (evidence.length > MAX_CAPABILITY_INPUTS) {
    throw new TypeError("Provider live verification evidence is too large");
  }
  const byProvider = new Map<string, ProviderLiveVerification>();
  for (const item of evidence) {
    if (
      !PROVIDER_ID.test(item.providerId) ||
      !Number.isFinite(Date.parse(item.checkedAt)) ||
      new Date(item.checkedAt).toISOString() !== item.checkedAt ||
      byProvider.has(item.providerId)
    ) {
      throw new TypeError("Provider live verification evidence is invalid");
    }
    byProvider.set(item.providerId, item);
  }
  return byProvider;
}

function liveProjection(
  evidence: ProviderLiveVerification | undefined,
  now: Date,
): ProviderCapability["liveVerification"] {
  if (evidence === undefined) return { status: "not_run" };
  const age = now.getTime() - Date.parse(evidence.checkedAt);
  const status = age < 0 || age > LIVE_EVIDENCE_MAX_AGE_MS
    ? "stale"
    : evidence.status;
  return { status, checkedAt: evidence.checkedAt };
}

export function listProviderCapabilities(
  options: ListProviderCapabilitiesOptions = {},
): readonly ProviderCapability[] {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("Provider capability time is invalid");
  }
  const catalog = new OnboardingCatalog().list({
    includeBlocked: true,
    now,
  });
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  const requested = options.providerIds ?? catalog.map((entry) => entry.id);
  if (
    requested.length > MAX_CAPABILITY_INPUTS ||
    new Set(requested).size !== requested.length ||
    requested.some((providerId) => !PROVIDER_ID.test(providerId))
  ) {
    throw new TypeError("Provider capability selection is invalid");
  }
  const liveByProvider = liveVerificationByProvider(
    options.liveVerification ?? [],
  );
  if ([...liveByProvider.keys()].some((providerId) => !byId.has(providerId))) {
    throw new TypeError("Provider live verification evidence is invalid");
  }
  return deepFreeze(requested.map((providerId) => {
    const entry = byId.get(providerId);
    const facts = executableFacts(providerId, entry?.status);
    const missing = missingCapabilities(facts);
    const liveVerification = liveProjection(
      liveByProvider.get(providerId),
      now,
    );
    const implementationCoverage: ProviderCapability["implementationCoverage"] =
      missing.length === 0
      ? "complete"
      : missing.length === CAPABILITY_ORDER.length
      ? "none"
      : "partial";
    if (entry === undefined) {
      return {
        providerId,
        displayName: providerId,
        category: "unsupported" as const,
        adapterId: null,
        missingCapabilities: missing,
        implementationCoverage,
        liveVerification,
      };
    }
    const policyBlocked = !currentPolicy(entry, now) ||
      entry.supportStatus === "blocked" ||
      entry.supportStatus === "blocked_pending_written_approval";
    const category: ProviderCapabilityCategory = policyBlocked
      ? "blocked"
      : entry.supportStatus === "conditional"
      ? "conditional"
      : missing.length !== 0
      ? "cataloged"
      : liveVerification.status === "passed"
      ? "live-tested"
      : "activatable";
    return {
      providerId,
      displayName: entry.displayName,
      category,
      adapterId: facts.adapterId,
      missingCapabilities: missing,
      implementationCoverage,
      liveVerification,
    };
  }));
}

export function listProviderSummaries(
  includeBlocked = false,
): readonly ProviderSummary[] {
  const entries = new OnboardingCatalog().list({ includeBlocked });
  return deepFreeze(entries.map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    status: entry.status,
    supportStatus: entry.supportStatus,
    adapterKind: entry.adapterKind,
    accessKind: entry.accessKind,
    protocol: entry.protocol,
    connectionOwner: entry.connectionOwner,
    billing: {
      primarySource: entry.billing.primarySource,
      possibleAdditionalSources: [
        ...entry.billing.possibleAdditionalSources,
      ],
      providerFallback: entry.billing.providerFallback,
      availableSelections: [...entry.billing.availableSelections],
    },
    restrictions: [...entry.restrictions],
    requiredPolicyClaims: [...entry.requiredPolicyClaims],
  })));
}

export async function listAccountSummaries(
  dataDirectory: string,
): Promise<readonly AccountSummary[]> {
  return await new ConnectionLifecycleService(
    new FileConnectionRegistry(dataDirectory),
  ).list();
}

export async function setPrimaryAccount(
  dataDirectory: string,
  id: string,
  signal?: AbortSignal,
): Promise<AccountSummary> {
  return await new ConnectionLifecycleService(
    new FileConnectionRegistry(dataDirectory),
  ).setPrimary(id, signal === undefined ? {} : { signal });
}

export async function setAccountAgentRoute(
  dataDirectory: string,
  role: TeamRunRole,
  id: string | null,
  signal?: AbortSignal,
): Promise<AgentRouteAssignment> {
  return await new ConnectionLifecycleService(
    new FileConnectionRegistry(dataDirectory),
  ).setAgentRoute(role, id, signal === undefined ? {} : { signal });
}

export async function setAccountAgentRoutes(
  dataDirectory: string,
  assignments: readonly AgentRouteAssignment[],
  signal?: AbortSignal,
): Promise<readonly AgentRouteAssignment[]> {
  return await new ConnectionLifecycleService(
    new FileConnectionRegistry(dataDirectory),
  ).setAgentRoutes(
    assignments,
    signal === undefined ? {} : { signal },
  );
}

export async function disconnectAccount(
  dataDirectory: string,
  id: string,
  signal?: AbortSignal,
): Promise<ConnectionDisconnection> {
  return await new ConnectionLifecycleService(
    new FileConnectionRegistry(dataDirectory),
  ).disconnect(id, signal === undefined ? {} : { signal });
}

export function createConnectionVerifier(
  cwd: string,
  dataDirectory: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ConnectionVerifier {
  return {
    verifyLocal: (record, signal) => verifyLocalConnection(record, { signal }),
    verifyDelegated: (record, signal) => verifyReviewedDelegatedConnection(
      record,
      { cwd, dataDirectory, environment, signal },
    ),
    async verifyEnvironment(record, signal) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return verifyEnvironmentConnection(record, environment);
    },
  };
}

export interface VerifyAccountDependencies {
  readonly verifier?: ConnectionVerifier;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export async function verifyAccount(
  dataDirectory: string,
  id: string,
  cwd: string,
  signal?: AbortSignal,
  dependencies: VerifyAccountDependencies = {},
): Promise<ConnectionVerification> {
  return await new ConnectionLifecycleService(
    new FileConnectionRegistry(dataDirectory),
  ).verify(
    id,
    dependencies.verifier ?? createConnectionVerifier(
      cwd,
      dataDirectory,
      dependencies.environment ?? process.env,
    ),
    signal === undefined ? {} : { signal },
  );
}
