import { isDeepStrictEqual } from "node:util";

import {
  NATIVE_OPENAI_ONBOARDING_FAILURE_MESSAGES,
  type NativeOpenAIOnboardingFailureCode,
  type NativeOpenAIOnboardingOutcome,
  type NativeOpenAIOnboardingPort,
} from "@recurs/contracts";

import {
  FileConnectionActivationStore,
  type PendingConnectionActivation,
} from "./connection-activations.js";
import { parseConnectionActivationDocument } from "./connection-activation-model.js";
import {
  type BrokeredModelProviderConnectionRecord,
  type ConnectionRegistryDocument,
} from "./connection-registry.js";
import {
  compatibleOpenAIResponsesModelIds,
  isCompatibleOpenAIResponsesModelId,
  OPENAI_RESPONSES_CAPABILITY_PROFILE_REVISION,
} from "./openai-model-capabilities.js";
import {
  OnboardingCatalog,
  type OnboardingCatalogEntry,
} from "./onboarding-catalog.js";

const PROVIDER_ID = "openai-api";
const PROVIDER_LABEL = "OpenAI API";
const ENDPOINT = "https://api.openai.com/v1";

const PROVIDERS = Object.freeze({
  openai: Object.freeze({
    providerId: "openai-api" as const,
    label: "OpenAI API" as const,
    adapterId: "openai-responses" as const,
    activationProfileId: "openai_api_v1" as const,
  }),
  anthropic: Object.freeze({
    providerId: "anthropic-api" as const,
    label: "Anthropic API" as const,
    adapterId: "anthropic-messages" as const,
    activationProfileId: "anthropic_api_v1" as const,
  }),
});

type BrokeredProvider = keyof typeof PROVIDERS;

const APP_FAILURE_MESSAGES = Object.freeze({
  acknowledgement_required:
    "The current OpenAI policy and billing disclosure must be acknowledged.",
  policy_unavailable: "The reviewed OpenAI setup policy is unavailable.",
  model_not_compatible:
    "The selected OpenAI model is not available with the reviewed capabilities.",
  activation_conflict:
    "Another connection activation must be recovered before setup can continue.",
  persistence_failed: "The OpenAI connection state could not be saved safely.",
  inconsistent_recovery:
    "The OpenAI connection state is inconsistent and requires recovery.",
} as const);

type AppFailureCode = keyof typeof APP_FAILURE_MESSAGES;

export interface OpenAIOnboardingAcknowledgement {
  readonly policyRevision: string;
  readonly billingPolicyRevision: string;
  readonly billingDisclosureRevision: string;
  readonly mode: "strict_primary_only";
}

export interface SetupOpenAIConnectionInput {
  readonly modelId: string;
  readonly acknowledgement: OpenAIOnboardingAcknowledgement;
  readonly provider?: BrokeredProvider;
  readonly signal?: AbortSignal;
}

export interface OpenAISetupConnectionSummary {
  readonly id: string;
  readonly label: "OpenAI API" | "Anthropic API";
  readonly providerId: "openai-api" | "anthropic-api";
  readonly adapterId: "openai-responses" | "anthropic-messages";
  readonly kind: "brokered_model_provider";
  readonly modelId: string;
  readonly primary: boolean;
  readonly account: "verified (identifier redacted)";
  readonly activation: "stored_pending_runtime_gate";
  readonly billingSources: readonly ["metered_api"];
}

export type OpenAISetupPhase =
  | "preflight"
  | "begin"
  | "verify"
  | "catalog"
  | "prepare"
  | "native_commit"
  | "registry_commit"
  | "cleanup"
  | "recovery";

export type OpenAISetupRecovery =
  | "none"
  | "retry"
  | "pending_reconciliation"
  | "ready_cleanup_pending";

export type OpenAISetupFailureCode =
  | NativeOpenAIOnboardingFailureCode
  | AppFailureCode;

export type OpenAISetupOutcome =
  | Readonly<{
      state: "ready";
      disposition: "created" | "recovered";
      connection: OpenAISetupConnectionSummary;
      cleanupPending: boolean;
    }>
  | Readonly<{ state: "cancelled"; cleanup: "confirmed" }>
  | Readonly<{
      state: "failed";
      phase: OpenAISetupPhase;
      code: OpenAISetupFailureCode;
      safeMessage: string;
      recovery: OpenAISetupRecovery;
      connectionId?: string;
    }>;

export type OpenAIRecoveryOutcome =
  | Readonly<{ state: "none" }>
  | Readonly<{ state: "discarded"; connectionId: string }>
  | OpenAISetupOutcome;

export interface OpenAIOnboardingDisclosure {
  readonly providerId: typeof PROVIDER_ID;
  readonly displayName: typeof PROVIDER_LABEL;
  readonly credentialOwner: "recurs_broker";
  readonly endpoint: typeof ENDPOINT;
  readonly policyRevision: string;
  readonly billingPolicyRevision: string;
  readonly billingDisclosureRevision: string;
  readonly primaryBillingSource: "metered_api";
  readonly billingNotice:
    "OpenAI API billing is separate from ChatGPT subscriptions.";
  readonly systemProxyTrust: "trusted_in_v1";
  readonly supportedRunContexts: readonly ["local_cli_user_present"];
  readonly capabilityProfileRevision:
    typeof OPENAI_RESPONSES_CAPABILITY_PROFILE_REVISION;
  readonly restrictions: readonly string[];
}

export interface OpenAIActivationStorePort {
  read(options?: {
    signal?: AbortSignal;
  }): Promise<{ readonly activation: PendingConnectionActivation | null }>;
  prepare(
    activation: PendingConnectionActivation,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  commitToRegistry(
    activation: PendingConnectionActivation,
    options?: { signal?: AbortSignal },
  ): Promise<ConnectionRegistryDocument>;
  discard(
    activation: PendingConnectionActivation,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  discardIfRegistryMissing(
    activation: PendingConnectionActivation,
    options?: { signal?: AbortSignal },
  ): Promise<"discarded" | "registry_present">;
}

export interface OpenAISetupDependencies {
  readonly nativeAuthority: NativeOpenAIOnboardingPort;
  readonly activationStore?: OpenAIActivationStorePort;
  readonly catalog?: OnboardingCatalog;
  readonly now?: () => Date;
}

export function openAIOnboardingDisclosure(
  options: { readonly catalog?: OnboardingCatalog; readonly now?: () => Date } =
    {},
): OpenAIOnboardingDisclosure {
  const now = currentDate(options.now);
  const entry = openAIEntry(options.catalog ?? new OnboardingCatalog(), now);
  return deepFreeze({
    providerId: PROVIDER_ID,
    displayName: PROVIDER_LABEL,
    credentialOwner: "recurs_broker",
    endpoint: ENDPOINT,
    policyRevision: entry.policy.revision,
    billingPolicyRevision: entry.billing.revision,
    billingDisclosureRevision: entry.billing.disclosureRevision,
    primaryBillingSource: "metered_api",
    billingNotice:
      "OpenAI API billing is separate from ChatGPT subscriptions.",
    systemProxyTrust: "trusted_in_v1",
    supportedRunContexts: ["local_cli_user_present"],
    capabilityProfileRevision:
      OPENAI_RESPONSES_CAPABILITY_PROFILE_REVISION,
    restrictions: [...entry.restrictions],
  });
}

export async function setupOpenAIConnection(
  dataDirectory: string,
  input: SetupOpenAIConnectionInput,
  dependencies: OpenAISetupDependencies,
): Promise<OpenAISetupOutcome> {
  const store = dependencies.activationStore ??
    new FileConnectionActivationStore(dataDirectory);
  const provider = input.provider ?? "openai";
  const providerConfig = PROVIDERS[provider];
  if (isAborted(input.signal)) return cancelled();

  let now: Date;
  let entry: OnboardingCatalogEntry;
  try {
    now = currentDate(dependencies.now);
    entry = providerEntry(
      dependencies.catalog ?? new OnboardingCatalog(),
      now,
      providerConfig.providerId,
    );
  } catch {
    return failure("preflight", "policy_unavailable", "none");
  }
  try {
    const pending = await store.read(signalOptions(input.signal));
    if (pending.activation !== null) {
      return failure(
        "preflight",
        "activation_conflict",
        "pending_reconciliation",
        pending.activation.connection.id,
      );
    }
  } catch {
    if (isAborted(input.signal)) return cancelled();
    return failure("preflight", "persistence_failed", "retry");
  }
  if (entry.status !== "requires_native_broker") {
    return failure("preflight", "policy_unavailable", "none");
  }
  if (!acknowledges(input.acknowledgement, entry)) {
    return failure("preflight", "acknowledgement_required", "none");
  }
  if (
    provider === "openai" &&
    !isCompatibleOpenAIResponsesModelId(input.modelId)
  ) {
    return failure("preflight", "model_not_compatible", "none");
  }

  const begun = await callNative(
    "begin",
    () =>
      dependencies.nativeAuthority.beginOpenAIOnboarding(
        input.signal,
        provider,
      ),
  );
  if (begun.state !== "succeeded") {
    return isCancelledFailure(begun.outcome) ? cancelled() : begun.outcome;
  }
  if (isAborted(input.signal)) {
    return abortBeforeCommit(
      dependencies.nativeAuthority,
      cancelled(),
      begun.value.connectionId,
    );
  }

  const verified = await callNative(
    "verify",
    () => dependencies.nativeAuthority.verifyOpenAIOnboarding(input.signal),
    begun.value.connectionId,
  );
  if (verified.state !== "succeeded") {
    return isCancelledFailure(verified.outcome)
      ? cancelled()
      : verified.outcome;
  }
  if (isAborted(input.signal)) {
    return abortBeforeCommit(
      dependencies.nativeAuthority,
      cancelled(),
      begun.value.connectionId,
    );
  }

  const modelIds = [...verified.value.modelIds];
  let page = verified.value;
  while (page.nextCursor !== null) {
    const next = await callNative(
      "catalog",
      () =>
        dependencies.nativeAuthority.openAIOnboardingCatalogPage(
          page.nextCursor as number,
          input.signal,
        ),
      begun.value.connectionId,
    );
    if (next.state !== "succeeded") {
      return isCancelledFailure(next.outcome) ? cancelled() : next.outcome;
    }
    page = next.value;
    modelIds.push(...page.modelIds);
    if (isAborted(input.signal)) {
      return abortBeforeCommit(
        dependencies.nativeAuthority,
        cancelled(),
        begun.value.connectionId,
      );
    }
  }
  const compatible = provider === "openai"
    ? compatibleOpenAIResponsesModelIds(modelIds)
    : modelIds;
  if (!compatible.includes(input.modelId)) {
    return abortBeforeCommit(
      dependencies.nativeAuthority,
      failure(
        "catalog",
        "model_not_compatible",
        "none",
        begun.value.connectionId,
      ),
      begun.value.connectionId,
    );
  }

  const timestamp = now.toISOString();
  const pending = canonicalPending({
    connection: {
      kind: "brokered_model_provider",
      id: begun.value.connectionId,
      providerId: providerConfig.providerId,
      adapterId: providerConfig.adapterId,
      activationProfileId: providerConfig.activationProfileId,
      label: providerConfig.label,
      modelId: input.modelId,
      credentialIdentityFingerprint:
        begun.value.credentialIdentityFingerprint,
      policyRevision: entry.policy.revision,
      billingPolicy: structuredClone(entry.billing),
      billingSelection: {
        mode: "strict_primary_only",
        policyRevision: entry.billing.revision,
        disclosureRevision: entry.billing.disclosureRevision,
        allowedSources: ["metered_api"],
        acknowledgedAt: timestamp,
      },
      verifiedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    stagedAt: timestamp,
  });

  try {
    await store.prepare(pending, signalOptions(input.signal));
  } catch {
    const prepared = await readPreparedState(store, pending);
    if (prepared !== "exact") {
      return abortBeforeCommit(
        dependencies.nativeAuthority,
        failure(
          "prepare",
          prepared === "conflict"
            ? "activation_conflict"
            : "persistence_failed",
          prepared === "conflict" ? "pending_reconciliation" : "retry",
          begun.value.connectionId,
        ),
        begun.value.connectionId,
      );
    }
  }
  if (isAborted(input.signal)) {
    return abortBeforeCommit(
      dependencies.nativeAuthority,
      cancelled(),
      begun.value.connectionId,
      store,
      pending,
    );
  }

  const committed = await callNative(
    "native_commit",
    () =>
      dependencies.nativeAuthority.finalizeOpenAIOnboarding(
        input.modelId,
        input.signal,
      ),
    begun.value.connectionId,
    "pending_reconciliation",
  );
  if (committed.state !== "succeeded") {
    if (isCancelledFailure(committed.outcome)) {
      return discardAfterProvenAbort(store, pending, cancelled());
    }
    return committed.outcome;
  }
  if (
    committed.value.connectionId !== begun.value.connectionId ||
    committed.value.selectedModelId !== input.modelId ||
    committed.value.verifiedModelCount !== verified.value.totalModelCount
  ) {
    return failure(
      "native_commit",
      "reconciliation_required",
      "pending_reconciliation",
      begun.value.connectionId,
    );
  }

  let registry: ConnectionRegistryDocument;
  try {
    registry = await store.commitToRegistry(pending);
  } catch {
    return failure(
      "registry_commit",
      "persistence_failed",
      "pending_reconciliation",
      begun.value.connectionId,
    );
  }
  try {
    await store.discard(pending);
  } catch {
    return readyAfterDiscardUncertainty(
      store,
      pending,
      registry,
      "created",
    );
  }
  return ready(registry, pending.connection, "created", false);
}

export async function recoverPendingOpenAIConnection(
  dataDirectory: string,
  dependencies: OpenAISetupDependencies,
  options: { readonly signal?: AbortSignal } = {},
): Promise<OpenAIRecoveryOutcome> {
  const store = dependencies.activationStore ??
    new FileConnectionActivationStore(dataDirectory);
  if (isAborted(options.signal)) return cancelled();
  let document: Awaited<ReturnType<OpenAIActivationStorePort["read"]>>;
  try {
    document = await store.read(signalOptions(options.signal));
  } catch {
    if (isAborted(options.signal)) return cancelled();
    return failure("recovery", "persistence_failed", "retry");
  }
  const pending = document.activation;
  if (pending === null) return deepFreeze({ state: "none" });

  const reconciled = await callNative(
    "recovery",
    () =>
      dependencies.nativeAuthority.reconcileOpenAIActivation(
        pending.connection.id,
        pending.connection.credentialIdentityFingerprint,
        options.signal,
      ),
    pending.connection.id,
    "pending_reconciliation",
  );
  if (reconciled.state !== "succeeded") {
    return isCancelledFailure(reconciled.outcome)
      ? cancelled()
      : reconciled.outcome;
  }

  if (reconciled.value.status === "unresolved") {
    return failure(
      "recovery",
      "reconciliation_required",
      "pending_reconciliation",
      pending.connection.id,
    );
  }
  if (reconciled.value.status === "ready_openai") {
    let committed: ConnectionRegistryDocument;
    try {
      committed = await store.commitToRegistry(pending);
    } catch {
      return failure(
        "recovery",
        "persistence_failed",
        "pending_reconciliation",
        pending.connection.id,
      );
    }
    try {
      await store.discard(pending);
    } catch {
      return readyAfterDiscardUncertainty(
        store,
        pending,
        committed,
        "recovered",
      );
    }
    return ready(committed, pending.connection, "recovered", false);
  }

  try {
    const disposition = await store.discardIfRegistryMissing(pending);
    if (disposition === "registry_present") {
      return failure(
        "recovery",
        "inconsistent_recovery",
        "pending_reconciliation",
        pending.connection.id,
      );
    }
    return deepFreeze({
      state: "discarded",
      connectionId: pending.connection.id,
    });
  } catch {
    const state = await readPreparedState(store, pending);
    if (state === "absent") {
      return deepFreeze({
        state: "discarded",
        connectionId: pending.connection.id,
      });
    }
    return failure(
      "recovery",
      state === "conflict" ? "inconsistent_recovery" : "cleanup_failed",
      "pending_reconciliation",
      pending.connection.id,
    );
  }
}

function currentDate(now: (() => Date) | undefined): Date {
  const value = (now ?? (() => new Date()))();
  if (!Number.isFinite(value.getTime())) throw new TypeError("Invalid clock");
  return new Date(value.getTime());
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function signalOptions(
  signal: AbortSignal | undefined,
): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function openAIEntry(catalog: OnboardingCatalog, now: Date): OnboardingCatalogEntry {
  return providerEntry(catalog, now, PROVIDER_ID);
}

function providerEntry(
  catalog: OnboardingCatalog,
  now: Date,
  providerId: "openai-api" | "anthropic-api",
): OnboardingCatalogEntry {
  const entry = catalog.list({ includeBlocked: true, now }).find(
    (candidate) => candidate.id === providerId,
  );
  if (entry === undefined) throw new TypeError("Provider policy unavailable");
  return entry;
}

function acknowledges(
  acknowledgement: OpenAIOnboardingAcknowledgement,
  entry: OnboardingCatalogEntry,
): boolean {
  return acknowledgement.mode === "strict_primary_only" &&
    acknowledgement.policyRevision === entry.policy.revision &&
    acknowledgement.billingPolicyRevision === entry.billing.revision &&
    acknowledgement.billingDisclosureRevision ===
      entry.billing.disclosureRevision;
}

function canonicalPending(
  pending: PendingConnectionActivation,
): PendingConnectionActivation {
  const parsed = parseConnectionActivationDocument({
    schemaVersion: 1,
    activation: pending,
  }).activation;
  if (parsed === null) throw new TypeError("Invalid activation");
  return parsed;
}

async function callNative<Value>(
  phase: OpenAISetupPhase,
  operation: () => Promise<NativeOpenAIOnboardingOutcome<Value>>,
  connectionId?: string,
  recovery: OpenAISetupRecovery = "retry",
): Promise<
  | Readonly<{ state: "succeeded"; value: Value }>
  | Readonly<{ state: "failed"; outcome: OpenAISetupOutcome }>
> {
  try {
    const outcome = await operation();
    if (outcome.state === "failed") {
      return {
        state: "failed",
        outcome: failure(
          phase,
          outcome.code,
          recovery,
          connectionId,
        ),
      };
    }
    return outcome;
  } catch {
    return {
      state: "failed",
      outcome: failure(
        phase,
        "authority_unavailable",
        recovery,
        connectionId,
      ),
    };
  }
}

async function abortBeforeCommit(
  nativeAuthority: NativeOpenAIOnboardingPort,
  original: OpenAISetupOutcome,
  connectionId: string,
  store?: OpenAIActivationStorePort,
  pending?: PendingConnectionActivation,
): Promise<OpenAISetupOutcome> {
  const aborted = await callNative(
    "cleanup",
    () => nativeAuthority.abortOpenAIOnboarding(),
    connectionId,
    "pending_reconciliation",
  );
  if (aborted.state !== "succeeded") return aborted.outcome;
  if (store !== undefined && pending !== undefined) {
    return discardAfterProvenAbort(store, pending, original);
  }
  return original;
}

function isCancelledFailure(
  outcome: OpenAISetupOutcome,
): outcome is Extract<OpenAISetupOutcome, { state: "failed" }> & {
  readonly code: "cancelled";
} {
  return outcome.state === "failed" && outcome.code === "cancelled";
}

async function readPreparedState(
  store: OpenAIActivationStorePort,
  expected: PendingConnectionActivation,
): Promise<"absent" | "exact" | "conflict" | "unknown"> {
  try {
    const current = (await store.read()).activation;
    if (current === null) return "absent";
    return isDeepStrictEqual(current, expected) ? "exact" : "conflict";
  } catch {
    return "unknown";
  }
}

async function discardAfterProvenAbort(
  store: OpenAIActivationStorePort,
  pending: PendingConnectionActivation,
  outcome: OpenAISetupOutcome,
): Promise<OpenAISetupOutcome> {
  try {
    await store.discard(pending);
    return outcome;
  } catch {
    const state = await readPreparedState(store, pending);
    if (state === "absent") return outcome;
    return failure(
      "cleanup",
      state === "conflict" ? "inconsistent_recovery" : "cleanup_failed",
      "pending_reconciliation",
      pending.connection.id,
    );
  }
}

async function readyAfterDiscardUncertainty(
  store: OpenAIActivationStorePort,
  pending: PendingConnectionActivation,
  registry: ConnectionRegistryDocument,
  disposition: "created" | "recovered",
): Promise<OpenAISetupOutcome> {
  const state = await readPreparedState(store, pending);
  if (state === "absent") {
    return ready(registry, pending.connection, disposition, false);
  }
  if (state === "exact" || state === "unknown") {
    return ready(registry, pending.connection, disposition, true);
  }
  return failure(
    "cleanup",
    "inconsistent_recovery",
    "ready_cleanup_pending",
    pending.connection.id,
  );
}

function failure(
  phase: OpenAISetupPhase,
  code: OpenAISetupFailureCode,
  recovery: OpenAISetupRecovery,
  connectionId?: string,
): Extract<OpenAISetupOutcome, { state: "failed" }> {
  const safeMessage = code in NATIVE_OPENAI_ONBOARDING_FAILURE_MESSAGES
    ? NATIVE_OPENAI_ONBOARDING_FAILURE_MESSAGES[
      code as NativeOpenAIOnboardingFailureCode
    ]
    : APP_FAILURE_MESSAGES[code as AppFailureCode];
  return deepFreeze({
    state: "failed",
    phase,
    code,
    safeMessage,
    recovery,
    ...(connectionId === undefined ? {} : { connectionId }),
  });
}

function cancelled(): Extract<OpenAISetupOutcome, { state: "cancelled" }> {
  return deepFreeze({ state: "cancelled", cleanup: "confirmed" });
}

function ready(
  registry: ConnectionRegistryDocument,
  connection: BrokeredModelProviderConnectionRecord,
  disposition: "created" | "recovered",
  cleanupPending: boolean,
): Extract<OpenAISetupOutcome, { state: "ready" }> {
  const stored = registry.connections.find(
    (candidate) => candidate.id === connection.id,
  );
  if (!isDeepStrictEqual(stored, connection)) {
    throw new TypeError("Committed activation is unavailable");
  }
  return deepFreeze({
    state: "ready",
    disposition,
    connection: {
      id: connection.id,
      label: connection.label as "OpenAI API" | "Anthropic API",
      providerId: connection.providerId,
      adapterId: connection.adapterId,
      kind: "brokered_model_provider",
      modelId: connection.modelId,
      primary: registry.primaryConnectionId === connection.id,
      account: "verified (identifier redacted)",
      activation: "stored_pending_runtime_gate",
      billingSources: ["metered_api"],
    },
    cleanupPending,
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
