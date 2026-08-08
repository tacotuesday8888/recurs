import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { ModelReasoningEffort } from "@recurs/contracts";

import {
  ConnectionRegistryError,
  FileConnectionRegistry,
} from "./connection-registry.js";
import type { DelegatedConnectionRecord } from "./connection-registry-model.js";
import { OnboardingCatalog } from "./onboarding-catalog.js";

export const GITHUB_COPILOT_ONBOARDING_ADAPTER_ID = "github-copilot-sdk";
export const GITHUB_COPILOT_ONBOARDING_PROFILE_REVISION =
  "github-copilot-sdk-1.0.8-host-tools-v1";
const PROVIDER_ID = "github-copilot-subscription";
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;
const SDK_REASONING_EFFORTS = new Set<ModelReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
]);

function isSafeLabel(value: string): boolean {
  return value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    });
}

export interface GitHubCopilotOnboardingModel {
  readonly id: string;
  readonly displayName: string;
  readonly supportedReasoningEfforts: readonly ModelReasoningEffort[];
  readonly defaultReasoningEffort?: ModelReasoningEffort;
  readonly supportsReasoningEffort: boolean;
}

export interface SetupGitHubCopilotConnectionInput {
  readonly accountSubjectFingerprint: string;
  readonly accountDisplayLabel: string;
  readonly model: GitHubCopilotOnboardingModel;
  readonly reasoningEffort?: ModelReasoningEffort;
  readonly billingSelection: "allow_declared_additional";
  readonly now?: string;
  readonly signal?: AbortSignal;
}

function validTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function reviewedPolicy(at: string): {
  readonly billing: DelegatedConnectionRecord["billingPolicy"];
  readonly providerPolicyRevision: string;
} {
  const policyAt = new Date(at);
  const entry = new OnboardingCatalog(undefined, { now: () => policyAt })
    .list({ includeBlocked: true, now: policyAt })
    .find((candidate) => candidate.id === PROVIDER_ID);
  if (
    entry === undefined ||
    entry.status !== "runnable" ||
    entry.supportStatus !== "conditional" ||
    entry.billing.primarySource !== "included_subscription" ||
    !entry.billing.possibleAdditionalSources.includes("metered_api") ||
    entry.billing.providerFallback !== "user_configured" ||
    !entry.billing.availableSelections.includes("allow_declared_additional") ||
    entry.billing.availableSelections.includes("strict_primary_only")
  ) {
    throw new Error("Reviewed GitHub Copilot subscription policy is unavailable");
  }
  return {
    billing: structuredClone(entry.billing),
    providerPolicyRevision: entry.policy.revision,
  };
}

export function matchesCurrentGitHubCopilotPolicy(
  connection: DelegatedConnectionRecord,
  now = new Date(),
): boolean {
  const entry = new OnboardingCatalog(undefined, { now: () => now })
    .list({ includeBlocked: true, now })
    .find((candidate) => candidate.id === PROVIDER_ID);
  return entry !== undefined &&
    entry.status === "runnable" &&
    connection.providerId === PROVIDER_ID &&
    connection.adapterId === GITHUB_COPILOT_ONBOARDING_ADAPTER_ID &&
    connection.runtimeCapabilityProfileRevision ===
      GITHUB_COPILOT_ONBOARDING_PROFILE_REVISION &&
    connection.policyRevision === entry.policy.revision &&
    isDeepStrictEqual(connection.billingPolicy, entry.billing) &&
    connection.billingSelection.mode === "allow_declared_additional" &&
    connection.billingSelection.policyRevision === entry.billing.revision &&
    connection.billingSelection.disclosureRevision ===
      entry.billing.disclosureRevision &&
    isDeepStrictEqual(connection.billingSelection.allowedSources, [
      entry.billing.primarySource,
      ...entry.billing.possibleAdditionalSources,
    ]);
}

export async function setupGitHubCopilotConnection(
  dataDirectory: string,
  input: SetupGitHubCopilotConnectionInput,
  dependencies: { readonly createId?: () => string } = {},
): Promise<DelegatedConnectionRecord> {
  const now = input.now ?? new Date().toISOString();
  const signal = input.signal ?? new AbortController().signal;
  const model = input.model;
  const connectionLabel = `${model.displayName} · GitHub Copilot`;
  const efforts = model.supportedReasoningEfforts;
  const uniqueEfforts = new Set(efforts);
  const validEffortMetadata =
    efforts.every((effort) => SDK_REASONING_EFFORTS.has(effort)) &&
    uniqueEfforts.size === efforts.length &&
    (model.defaultReasoningEffort === undefined ||
      uniqueEfforts.has(model.defaultReasoningEffort));
  const validEffortSelection = model.supportsReasoningEffort
    ? efforts.length > 0 &&
      input.reasoningEffort !== undefined &&
      uniqueEfforts.has(input.reasoningEffort)
    : efforts.length === 0 &&
      model.defaultReasoningEffort === undefined &&
      input.reasoningEffort === undefined;
  if (
    signal.aborted ||
    input.billingSelection !== "allow_declared_additional" ||
    !validTimestamp(now) ||
    !FINGERPRINT.test(input.accountSubjectFingerprint) ||
    !isSafeLabel(input.accountDisplayLabel) ||
    !SAFE_MODEL_ID.test(model.id) ||
    !isSafeLabel(model.displayName) ||
    !isSafeLabel(connectionLabel) ||
    !validEffortMetadata ||
    !validEffortSelection
  ) {
    throw new TypeError("GitHub Copilot setup input is invalid");
  }
  const reviewed = reviewedPolicy(now);
  const selection: DelegatedConnectionRecord["billingSelection"] = {
    mode: "allow_declared_additional",
    policyRevision: reviewed.billing.revision,
    disclosureRevision: reviewed.billing.disclosureRevision,
    allowedSources: [
      reviewed.billing.primarySource,
      ...reviewed.billing.possibleAdditionalSources,
    ],
    acknowledgedAt: now,
  };
  const registry = new FileConnectionRegistry(dataDirectory);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (signal.aborted) throw new Error("GitHub Copilot setup was cancelled");
    const current = await registry.migrateLegacyLocal({ signal });
    const previous = current.connections.find((connection) =>
      connection.kind === "delegated_agent" &&
      connection.providerId === PROVIDER_ID &&
      connection.adapterId === GITHUB_COPILOT_ONBOARDING_ADAPTER_ID &&
      connection.accountSubjectFingerprint === input.accountSubjectFingerprint &&
      connection.modelId === model.id &&
      connection.reasoningEffort === input.reasoningEffort
    );
    const record: DelegatedConnectionRecord = {
      kind: "delegated_agent",
      id: previous?.id ?? `copilot-${dependencies.createId?.() ?? randomUUID()}`,
      providerId: PROVIDER_ID,
      adapterId: GITHUB_COPILOT_ONBOARDING_ADAPTER_ID,
      label: connectionLabel,
      accountLabel: input.accountDisplayLabel,
      organizationLabel: null,
      modelId: model.id,
      ...(input.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: input.reasoningEffort }),
      runtimeCapabilityProfileRevision:
        GITHUB_COPILOT_ONBOARDING_PROFILE_REVISION,
      accountSubjectFingerprint: input.accountSubjectFingerprint,
      policyRevision: reviewed.providerPolicyRevision,
      billingPolicy: structuredClone(reviewed.billing),
      billingSelection: structuredClone(selection),
      verifiedAt: now,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    try {
      await registry.commit(current.revision, (draft) => {
        const index = draft.connections.findIndex((item) => item.id === record.id);
        if (index === -1) draft.connections.push(record);
        else draft.connections[index] = record;
        if (draft.primaryConnectionId === null) draft.primaryConnectionId = record.id;
      }, { signal });
      return Object.freeze(structuredClone(record));
    } catch (error) {
      if (
        error instanceof ConnectionRegistryError &&
        error.code === "revision_conflict" &&
        attempt < 2
      ) continue;
      throw error;
    }
  }
  throw new Error("GitHub Copilot connection could not be saved");
}
