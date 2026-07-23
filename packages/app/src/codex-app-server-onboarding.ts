import { randomUUID } from "node:crypto";

import type { ModelReasoningEffort, TeamRunRole } from "@recurs/contracts";

import {
  ConnectionRegistryError,
  FileConnectionRegistry,
} from "./connection-registry.js";
import type { DelegatedConnectionRecord } from "./connection-registry-model.js";
import { OnboardingCatalog } from "./onboarding-catalog.js";

const PROVIDER_ID = "openai-codex-chatgpt";
export const CODEX_APP_SERVER_ONBOARDING_ADAPTER_ID = "codex-app-server";
export const CODEX_APP_SERVER_ONBOARDING_PROFILE_REVISION =
  "codex-app-server-0.144.0-host-tools-v1";
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;

export interface CodexAppServerOnboardingModel {
  readonly id: string;
  readonly displayName: string;
  readonly defaultReasoningEffort: ModelReasoningEffort;
  readonly supportedReasoningEfforts: readonly ModelReasoningEffort[];
}

export interface SetupCodexAppServerConnectionsInput {
  readonly accountSubjectFingerprint: string;
  readonly accountDisplayLabel: string;
  readonly models: readonly CodexAppServerOnboardingModel[];
  readonly billingSelection: "allow_declared_additional";
  readonly now?: string;
  readonly signal?: AbortSignal;
}

export interface CodexAppServerSetupResult {
  readonly connections: readonly DelegatedConnectionRecord[];
  readonly primaryConnectionId: string | null;
  readonly agentRoutes: Readonly<Record<TeamRunRole, string | null>>;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function preferredEffort(
  model: CodexAppServerOnboardingModel,
  preferred: ModelReasoningEffort,
): ModelReasoningEffort {
  return model.supportedReasoningEfforts.includes(preferred)
    ? preferred
    : model.defaultReasoningEffort;
}

function desiredModels(
  models: readonly CodexAppServerOnboardingModel[],
): readonly {
  readonly model: CodexAppServerOnboardingModel;
  readonly effort: ModelReasoningEffort;
  readonly roles: readonly TeamRunRole[];
  readonly parent: boolean;
}[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  const sol = byId.get("gpt-5.6-sol") ?? models[0];
  if (sol === undefined) return [];
  const terra = byId.get("gpt-5.6-terra") ?? sol;
  const luna = byId.get("gpt-5.6-luna") ?? terra;
  const selected = new Map<string, {
    model: CodexAppServerOnboardingModel;
    effort: ModelReasoningEffort;
    roles: TeamRunRole[];
    parent: boolean;
  }>();
  const add = (
    model: CodexAppServerOnboardingModel,
    effort: ModelReasoningEffort,
    role: TeamRunRole | null,
    parent: boolean,
  ): void => {
    const current = selected.get(model.id) ?? {
      model,
      effort,
      roles: [],
      parent: false,
    };
    if (role !== null && !current.roles.includes(role)) current.roles.push(role);
    current.parent ||= parent;
    selected.set(model.id, current);
  };
  add(sol, preferredEffort(sol, "high"), null, true);
  add(terra, preferredEffort(terra, "medium"), "implement", false);
  add(terra, preferredEffort(terra, "medium"), "repair", false);
  add(luna, preferredEffort(luna, "medium"), "review", false);
  return Object.freeze([...selected.values()].map((entry) => Object.freeze({
    ...entry,
    roles: Object.freeze(entry.roles),
  })));
}

function validTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Codex setup was cancelled");
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
    entry.billing.primarySource !== "included_subscription" ||
    !entry.billing.possibleAdditionalSources.includes("prepaid_credits") ||
    !entry.billing.availableSelections.includes("allow_declared_additional")
  ) {
    throw new Error("Reviewed Codex subscription policy is unavailable");
  }
  return {
    billing: structuredClone(entry.billing),
    providerPolicyRevision: entry.policy.revision,
  };
}

export async function setupCodexAppServerConnections(
  dataDirectory: string,
  input: SetupCodexAppServerConnectionsInput,
  dependencies: { readonly createId?: () => string } = {},
): Promise<CodexAppServerSetupResult> {
  const signal = input.signal ?? new AbortController().signal;
  throwIfAborted(signal);
  const now = input.now ?? new Date().toISOString();
  if (
    input.billingSelection !== "allow_declared_additional" ||
    !validTimestamp(now) ||
    !FINGERPRINT.test(input.accountSubjectFingerprint) ||
    input.accountDisplayLabel.length === 0 ||
    input.accountDisplayLabel.length > 256 ||
    input.models.length === 0 ||
    input.models.length > 128 ||
    input.models.some((model) =>
      !SAFE_MODEL_ID.test(model.id) ||
      model.displayName.length === 0 ||
      model.displayName.length > 256 ||
      model.supportedReasoningEfforts.length === 0 ||
      !model.supportedReasoningEfforts.includes(model.defaultReasoningEffort)
    )
  ) {
    throw new TypeError("Codex app-server setup input is invalid");
  }
  const desired = desiredModels(input.models);
  if (desired.length === 0) throw new TypeError("No Codex model is selectable");
  const reviewed = reviewedPolicy(now);
  const policy = reviewed.billing;
  const selection: DelegatedConnectionRecord["billingSelection"] = {
    mode: "allow_declared_additional",
    policyRevision: policy.revision,
    disclosureRevision: policy.disclosureRevision,
    allowedSources: [policy.primarySource, ...policy.possibleAdditionalSources],
    acknowledgedAt: now,
  };
  const registry = new FileConnectionRegistry(dataDirectory);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    throwIfAborted(signal);
    const current = await registry.migrateLegacyLocal({ signal });
    const records = desired.map(({ model, effort }) => {
      const previous = current.connections.find((connection) =>
        connection.kind === "delegated_agent" &&
        connection.adapterId === CODEX_APP_SERVER_ONBOARDING_ADAPTER_ID &&
        connection.accountSubjectFingerprint === input.accountSubjectFingerprint &&
        connection.modelId === model.id
      );
      return {
        kind: "delegated_agent" as const,
        id: previous?.id ?? `codex-${dependencies.createId?.() ?? randomUUID()}`,
        providerId: PROVIDER_ID,
        adapterId: CODEX_APP_SERVER_ONBOARDING_ADAPTER_ID,
        label: `${model.displayName} · ChatGPT`,
        accountLabel: input.accountDisplayLabel,
        organizationLabel: null,
        modelId: model.id,
        reasoningEffort: effort,
        runtimeCapabilityProfileRevision:
          CODEX_APP_SERVER_ONBOARDING_PROFILE_REVISION,
        accountSubjectFingerprint: input.accountSubjectFingerprint,
        policyRevision: reviewed.providerPolicyRevision,
        billingPolicy: structuredClone(policy),
        billingSelection: structuredClone(selection),
        verifiedAt: now,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      } satisfies DelegatedConnectionRecord;
    });
    const byModel = new Map(records.map((record) => [record.modelId, record]));
    const parent = byModel.get(desired.find((entry) => entry.parent)!.model.id)!;
    try {
      const committed = await registry.commit(current.revision, (draft) => {
        for (const record of records) {
          const index = draft.connections.findIndex((item) => item.id === record.id);
          if (index === -1) draft.connections.push(record);
          else draft.connections[index] = record;
        }
        const existingPrimary = draft.connections.find(
          (connection) => connection.id === draft.primaryConnectionId,
        );
        if (
          draft.primaryConnectionId === null ||
          (existingPrimary?.kind === "delegated_agent" &&
            existingPrimary.providerId === PROVIDER_ID &&
            existingPrimary.accountSubjectFingerprint ===
              input.accountSubjectFingerprint)
        ) {
          draft.primaryConnectionId = parent.id;
        }
        for (const entry of desired) {
          const record = byModel.get(entry.model.id)!;
          for (const role of entry.roles) {
            if (draft.agentRoutes[role] === null) {
              draft.agentRoutes = { ...draft.agentRoutes, [role]: record.id };
            }
          }
        }
      }, { signal });
      return deepFreeze({
        connections: records.map((record) => structuredClone(record)),
        primaryConnectionId: committed.primaryConnectionId,
        agentRoutes: { ...committed.agentRoutes },
      });
    } catch (error) {
      if (
        error instanceof ConnectionRegistryError &&
        error.code === "revision_conflict" &&
        attempt < 2
      ) continue;
      throw error;
    }
  }
  throw new Error("Codex app-server connections could not be saved");
}
