import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";

import type { BillingSelectionMode } from "@recurs/contracts";

import {
  ConnectionRegistryError,
  FileConnectionRegistry,
  type DelegatedConnectionRecord,
} from "./connection-registry.js";
import { OnboardingCatalog } from "./onboarding-catalog.js";

const PROVIDER_ID = "openai-codex-chatgpt";
export const CODEX_ONBOARDING_ADAPTER_ID = "codex-acp";
export const CODEX_ONBOARDING_ADAPTER_VERSION = "1.1.2";
export const CODEX_ONBOARDING_CAPABILITY_PROFILE_REVISION =
  "codex-acp-1.1.2-codex-0.144.0-plan-only-v1";
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;

export type CodexOnboardingErrorCode =
  | "billing_acknowledgement_required"
  | "interaction_required"
  | "chatgpt_login_unavailable"
  | "wrong_account_kind"
  | "account_identity_unavailable"
  | "adapter_unavailable"
  | "authentication_failed"
  | "capability_probe_failed"
  | "policy_unavailable"
  | "workspace_invalid"
  | "persistence_failed"
  | "cancelled";

export class CodexOnboardingError extends Error {
  constructor(
    public readonly code: CodexOnboardingErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexOnboardingError";
  }
}

export interface CodexRuntimeInspection {
  readonly protocolVersion: number;
  readonly agentInfo: {
    readonly name: string;
    readonly version: string;
    readonly title?: string;
  } | null;
  readonly authMethods: readonly {
    readonly id: string;
    readonly name: string;
    readonly type: "agent" | "env_var" | "terminal";
  }[];
  readonly sessionCapabilities: {
    readonly resume: boolean;
    readonly close: boolean;
  };
}

export type CodexAuthenticationStatus =
  | { readonly type: "unauthenticated" }
  | { readonly type: "api-key" }
  | { readonly type: "chat-gpt"; readonly email: string }
  | { readonly type: "gateway"; readonly name: string };

export interface CodexRuntimeVerification {
  readonly inspection: CodexRuntimeInspection;
  readonly status: CodexAuthenticationStatus;
}

export interface CodexRuntimeProbeResult {
  readonly modelId: string;
  readonly modeId: "read-only";
  readonly executionMode: "plan";
}

export interface CodexOnboardingRuntime {
  readonly adapterId: typeof CODEX_ONBOARDING_ADAPTER_ID;
  readonly adapterVersion: typeof CODEX_ONBOARDING_ADAPTER_VERSION;
  readonly capabilityProfileRevision:
    typeof CODEX_ONBOARDING_CAPABILITY_PROFILE_REVISION;
  inspect(signal: AbortSignal): Promise<CodexRuntimeVerification>;
  authenticateChatGpt(signal: AbortSignal): Promise<void>;
  probe(
    input: { readonly cwd: string; readonly modelId?: string },
    signal: AbortSignal,
  ): Promise<CodexRuntimeProbeResult>;
}

export interface SetupCodexConnectionInput {
  readonly cwd: string;
  readonly interactive: boolean;
  readonly billingSelection: "allow_declared_additional";
  readonly modelId?: string;
  readonly signal?: AbortSignal;
  readonly now?: string;
}

export interface SetupCodexConnectionDependencies {
  readonly runtime?: CodexOnboardingRuntime;
  readonly createRuntime?: (connectionId: string) => CodexOnboardingRuntime;
  readonly createId?: () => string;
}

export interface CodexConnectionConfiguration {
  readonly schemaVersion: 1;
  readonly kind: "delegated_agent";
  readonly id: string;
  readonly providerId: typeof PROVIDER_ID;
  readonly adapterId: typeof CODEX_ONBOARDING_ADAPTER_ID;
  readonly label: string;
  readonly accountLabel: string;
  readonly organizationLabel: null;
  readonly modelId: string;
  readonly accountSubjectFingerprint: string;
  readonly policyRevision: string;
  readonly billingPolicy: DelegatedConnectionRecord["billingPolicy"];
  readonly billingSelection: DelegatedConnectionRecord["billingSelection"];
  readonly runtimeCapabilityProfileRevision:
    typeof CODEX_ONBOARDING_CAPABILITY_PROFILE_REVISION;
  readonly executionMode: "plan";
  readonly planOnly: true;
  readonly verifiedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new CodexOnboardingError(
      "cancelled",
      "Codex setup was cancelled",
    );
  }
}

function validTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value;
}

function validateAdapter(
  runtime: CodexOnboardingRuntime,
  inspection: CodexRuntimeVerification,
): void {
  const info = inspection.inspection.agentInfo;
  if (
    runtime.adapterId !== CODEX_ONBOARDING_ADAPTER_ID ||
    runtime.adapterVersion !== CODEX_ONBOARDING_ADAPTER_VERSION ||
    runtime.capabilityProfileRevision !==
      CODEX_ONBOARDING_CAPABILITY_PROFILE_REVISION ||
    inspection.inspection.protocolVersion !== 1 ||
    info?.name !== "@agentclientprotocol/codex-acp" ||
    info.version !== CODEX_ONBOARDING_ADAPTER_VERSION ||
    !inspection.inspection.sessionCapabilities.resume ||
    !inspection.inspection.sessionCapabilities.close
  ) {
    throw new CodexOnboardingError(
      "adapter_unavailable",
      "The installed Codex adapter did not expose the reviewed capabilities",
    );
  }
}

function normalizeAccountLabel(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed !== value ||
    trimmed.length === 0 ||
    trimmed.length > 256 ||
    [...trimmed].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new CodexOnboardingError(
      "account_identity_unavailable",
      "Codex did not return a stable ChatGPT account label",
    );
  }
  return trimmed;
}

function accountFingerprint(accountLabel: string): string {
  const digest = createHash("sha256")
    .update(`${PROVIDER_ID}\0${accountLabel.toLocaleLowerCase("en-US")}`)
    .digest("hex");
  return `sha256:${digest}`;
}

function configuration(
  record: DelegatedConnectionRecord,
): CodexConnectionConfiguration {
  return deepFreeze({
    schemaVersion: 1,
    ...structuredClone(record),
    providerId: PROVIDER_ID,
    adapterId: CODEX_ONBOARDING_ADAPTER_ID,
    organizationLabel: null,
    runtimeCapabilityProfileRevision:
      CODEX_ONBOARDING_CAPABILITY_PROFILE_REVISION,
    executionMode: "plan",
    planOnly: true,
  });
}

async function safeInspect(
  runtime: CodexOnboardingRuntime,
  signal: AbortSignal,
): Promise<CodexRuntimeVerification> {
  try {
    const inspected = await runtime.inspect(signal);
    validateAdapter(runtime, inspected);
    return inspected;
  } catch (error) {
    if (error instanceof CodexOnboardingError) throw error;
    if (signal.aborted) throwIfAborted(signal);
    throw new CodexOnboardingError(
      "adapter_unavailable",
      "The official Codex adapter could not be verified",
    );
  }
}

function assertBillingSelection(
  value: BillingSelectionMode,
): asserts value is "allow_declared_additional" {
  if (value !== "allow_declared_additional") {
    throw new CodexOnboardingError(
      "billing_acknowledgement_required",
      "Codex setup requires acceptance of possible automatic prepaid-credit usage",
    );
  }
}

export async function setupCodexConnection(
  dataDirectory: string,
  input: SetupCodexConnectionInput,
  dependencies: SetupCodexConnectionDependencies = {},
): Promise<CodexConnectionConfiguration> {
  assertBillingSelection(input.billingSelection);
  const signal = input.signal ?? new AbortController().signal;
  throwIfAborted(signal);
  const now = input.now ?? new Date().toISOString();
  if (!validTimestamp(now)) {
    throw new CodexOnboardingError(
      "persistence_failed",
      "Codex setup received an invalid timestamp",
    );
  }

  const policyAt = new Date(now);
  const catalogEntry = new OnboardingCatalog(undefined, {
    now: () => policyAt,
  }).list({ includeBlocked: true, now: policyAt }).find(
    (entry) => entry.id === PROVIDER_ID,
  );
  if (
    catalogEntry === undefined ||
    catalogEntry.status !== "runnable" ||
    catalogEntry.billing.primarySource !== "included_subscription" ||
    catalogEntry.billing.providerFallback !== "automatic" ||
    !catalogEntry.billing.possibleAdditionalSources.includes("prepaid_credits") ||
    !catalogEntry.billing.availableSelections.includes(
      "allow_declared_additional",
    )
  ) {
    throw new CodexOnboardingError(
      "policy_unavailable",
      "The reviewed Codex subscription policy is not currently usable",
    );
  }

  let cwd: string;
  try {
    cwd = await realpath(input.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new TypeError("not a directory");
  } catch (error) {
    throw new CodexOnboardingError(
      "workspace_invalid",
      "Codex setup requires an existing workspace directory",
      { cause: error },
    );
  }
  throwIfAborted(signal);

  const proposedId = `codex-${dependencies.createId?.() ?? randomUUID()}`;
  let runtime: CodexOnboardingRuntime | undefined;
  try {
    runtime = dependencies.runtime ?? dependencies.createRuntime?.(proposedId);
  } catch {
    throw new CodexOnboardingError(
      "adapter_unavailable",
      "The official Codex onboarding runtime could not be prepared",
    );
  }
  if (runtime === undefined) {
    throw new CodexOnboardingError(
      "adapter_unavailable",
      "The official Codex onboarding runtime was not provided",
    );
  }
  let inspected = await safeInspect(runtime, signal);
  if (
    inspected.status.type === "api-key" ||
    inspected.status.type === "gateway"
  ) {
    throw new CodexOnboardingError(
      "wrong_account_kind",
      "Codex is authenticated with a non-ChatGPT account; use a separate connection path",
    );
  }
  if (inspected.status.type === "unauthenticated") {
    if (!input.interactive) {
      throw new CodexOnboardingError(
        "interaction_required",
        "ChatGPT sign-in requires an interactive local terminal",
      );
    }
    const method = inspected.inspection.authMethods.find(
      (candidate) => candidate.id === "chat-gpt" && candidate.type === "agent",
    );
    if (method === undefined) {
      throw new CodexOnboardingError(
        "chatgpt_login_unavailable",
        "The official adapter did not advertise browser-based ChatGPT sign-in",
      );
    }
    try {
      await runtime.authenticateChatGpt(signal);
    } catch {
      if (signal.aborted) throwIfAborted(signal);
      throw new CodexOnboardingError(
        "authentication_failed",
        "ChatGPT sign-in did not complete",
      );
    }
    throwIfAborted(signal);
    inspected = await safeInspect(runtime, signal);
  }
  if (inspected.status.type !== "chat-gpt") {
    throw new CodexOnboardingError(
      "authentication_failed",
      "The adapter did not verify a ChatGPT account after sign-in",
    );
  }
  const accountLabel = normalizeAccountLabel(inspected.status.email);
  const fingerprint = accountFingerprint(accountLabel);

  let probe: CodexRuntimeProbeResult;
  try {
    probe = await runtime.probe({
      cwd,
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    }, signal);
  } catch {
    if (signal.aborted) throwIfAborted(signal);
    throw new CodexOnboardingError(
      "capability_probe_failed",
      "Codex could not verify a Plan-only model session",
    );
  }
  if (
    probe.executionMode !== "plan" ||
    probe.modeId !== "read-only" ||
    !SAFE_MODEL_ID.test(probe.modelId)
  ) {
    throw new CodexOnboardingError(
      "capability_probe_failed",
      "Codex did not enforce the reviewed Plan-only session profile",
    );
  }
  throwIfAborted(signal);

  const billingPolicy = structuredClone(catalogEntry.billing);
  const billingSelection: DelegatedConnectionRecord["billingSelection"] = {
    mode: "allow_declared_additional",
    policyRevision: billingPolicy.revision,
    disclosureRevision: billingPolicy.disclosureRevision,
    allowedSources: [
      billingPolicy.primarySource,
      ...billingPolicy.possibleAdditionalSources,
    ],
    acknowledgedAt: now,
  };
  const registry = new FileConnectionRegistry(dataDirectory);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      throwIfAborted(signal);
      const current = await registry.migrateLegacyLocal({ signal });
      const matches = current.connections.filter(
        (connection): connection is DelegatedConnectionRecord =>
          connection.kind === "delegated_agent" &&
          connection.providerId === PROVIDER_ID &&
          connection.accountSubjectFingerprint === fingerprint,
      );
      if (matches.length > 1) {
        throw new CodexOnboardingError(
          "persistence_failed",
          "The connection registry contains duplicate Codex account records",
        );
      }
      const previous = matches[0];
      const record: DelegatedConnectionRecord = {
        kind: "delegated_agent",
        id: previous?.id ?? proposedId,
        providerId: PROVIDER_ID,
        adapterId: CODEX_ONBOARDING_ADAPTER_ID,
        label: "Codex with ChatGPT",
        accountLabel,
        organizationLabel: null,
        modelId: probe.modelId,
        accountSubjectFingerprint: fingerprint,
        policyRevision: catalogEntry.policy.revision,
        billingPolicy,
        billingSelection,
        verifiedAt: now,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      try {
        await registry.commit(current.revision, (draft) => {
          const index = draft.connections.findIndex(
            (connection) => connection.id === record.id,
          );
          if (index === -1) draft.connections.push(record);
          else draft.connections[index] = record;
          draft.primaryConnectionId = record.id;
        }, { signal });
        return configuration(record);
      } catch (error) {
        if (
          error instanceof ConnectionRegistryError &&
          error.code === "revision_conflict" &&
          attempt < 2
        ) {
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof CodexOnboardingError) throw error;
    if (signal.aborted) throwIfAborted(signal);
    throw new CodexOnboardingError(
      "persistence_failed",
      "The verified Codex connection could not be saved",
      { cause: error },
    );
  }
  throw new CodexOnboardingError(
    "persistence_failed",
    "The verified Codex connection could not be saved",
  );
}
