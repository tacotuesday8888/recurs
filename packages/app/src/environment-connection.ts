import { createHash } from "node:crypto";

import type {
  BillingSelection,
  BillingSelectionMode,
} from "@recurs/contracts";
import {
  createEnvironmentProviderConfiguration,
  environmentCredentialFingerprint,
} from "@recurs/providers";

import {
  ConnectionRegistryError,
  FileConnectionRegistry,
} from "./connection-registry.js";
import type {
  ConnectionRegistryDocument,
  EnvironmentModelProviderConnectionRecord,
} from "./connection-registry-model.js";
import { OnboardingCatalog } from "./onboarding-catalog.js";

const ENVIRONMENT_VARIABLE = /^[A-Z][A-Z0-9_]{0,127}$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;

export class EnvironmentConnectionError extends Error {
  constructor(
    public readonly code:
      | "configuration_invalid"
      | "credential_unavailable"
      | "provider_unsupported"
      | "billing_policy_blocked",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EnvironmentConnectionError";
  }
}

export interface SetupEnvironmentConnectionInput {
  readonly providerId: string;
  readonly modelId: string;
  readonly credentialEnvironmentVariable: string;
  readonly billingSelection: BillingSelectionMode;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly now?: string;
}

export interface EnvironmentConnectionConfiguration {
  readonly id: string;
  readonly label: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly credentialEnvironmentVariable: string;
  readonly primary: boolean;
  readonly billingSelection: BillingSelectionMode;
}

export type EnvironmentConnectionVerification =
  | { readonly status: "verified" }
  | {
    readonly status: "failed";
    readonly reason: "authentication_required" | "account_mismatch";
  };

function validCredentialEnvironmentVariable(value: string): boolean {
  if (!ENVIRONMENT_VARIABLE.test(value)) return false;
  const segments = new Set(value.split("_"));
  return segments.has("KEY") || segments.has("TOKEN") ||
    segments.has("SECRET");
}

function environmentRecords(
  document: ConnectionRegistryDocument,
): readonly EnvironmentModelProviderConnectionRecord[] {
  return document.connections.filter(
    (connection): connection is EnvironmentModelProviderConnectionRecord =>
      connection.kind === "environment_model_provider",
  );
}

function selection(
  mode: BillingSelectionMode,
  entry: ReturnType<OnboardingCatalog["list"]>[number],
  acknowledgedAt: string,
): BillingSelection {
  if (!entry.billing.availableSelections.includes(mode)) {
    throw new EnvironmentConnectionError(
      "billing_policy_blocked",
      "The selected billing mode is not available for this provider",
    );
  }
  return {
    mode,
    policyRevision: entry.billing.revision,
    disclosureRevision: entry.billing.disclosureRevision,
    allowedSources: mode === "strict_primary_only"
      ? [entry.billing.primarySource]
      : [
          entry.billing.primarySource,
          ...entry.billing.possibleAdditionalSources,
        ],
    acknowledgedAt,
  };
}

function configuration(
  record: EnvironmentModelProviderConnectionRecord,
  primaryConnectionId: string | null,
): EnvironmentConnectionConfiguration {
  return Object.freeze({
    id: record.id,
    label: record.label,
    providerId: record.providerId,
    modelId: record.modelId,
    credentialEnvironmentVariable: record.credentialEnvironmentVariable,
    primary: record.id === primaryConnectionId,
    billingSelection: record.billingSelection.mode,
  });
}

function safeFailure(error: unknown): EnvironmentConnectionError {
  if (error instanceof EnvironmentConnectionError) return error;
  return new EnvironmentConnectionError(
    "configuration_invalid",
    "BYOK connection configuration is invalid",
    { cause: error },
  );
}

export async function setupEnvironmentConnection(
  dataDirectory: string,
  input: SetupEnvironmentConnectionInput,
): Promise<EnvironmentConnectionConfiguration> {
  if (
    !MODEL_ID.test(input.modelId) ||
    !validCredentialEnvironmentVariable(input.credentialEnvironmentVariable)
  ) {
    throw new EnvironmentConnectionError(
      "configuration_invalid",
      "BYOK model or credential environment-variable name is invalid",
    );
  }
  const entry = new OnboardingCatalog().list({ includeBlocked: true }).find(
    (candidate) => candidate.id === input.providerId,
  );
  if (
    entry === undefined ||
    entry.status !== "runnable_byok" ||
    entry.connectionOwner !== "process_environment"
  ) {
    throw new EnvironmentConnectionError(
      "provider_unsupported",
      "Provider is not a reviewed public BYOK path",
    );
  }
  const apiKey = input.environment[input.credentialEnvironmentVariable];
  if (apiKey === undefined || apiKey.length === 0) {
    throw new EnvironmentConnectionError(
      "credential_unavailable",
      `Credential environment variable ${input.credentialEnvironmentVariable} is not set`,
    );
  }
  let bound;
  try {
    bound = await createEnvironmentProviderConfiguration({
      providerId: input.providerId,
      modelId: input.modelId,
      apiKey,
    });
  } catch (error) {
    throw new EnvironmentConnectionError(
      "configuration_invalid",
      "BYOK credential or provider configuration is invalid",
      { cause: error },
    );
  }
  const now = input.now ?? new Date().toISOString();
  const billingSelection = selection(input.billingSelection, entry, now);
  const stableSuffix = createHash("sha256")
    .update(
      `recurs:environment-connection-id:v1\0${input.providerId}\0${input.credentialEnvironmentVariable}`,
    )
    .digest("hex")
    .slice(0, 16);
  const proposedId = `byok:${input.providerId}:${stableSuffix}`;
  const registry = new FileConnectionRegistry(dataDirectory);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await registry.migrateLegacyLocal();
      const matches = environmentRecords(current).filter(
        (record) => record.providerId === input.providerId &&
          record.credentialEnvironmentVariable ===
            input.credentialEnvironmentVariable,
      );
      if (matches.length > 1) {
        throw new EnvironmentConnectionError(
          "configuration_invalid",
          "Connection registry contains duplicate BYOK records",
        );
      }
      const previous = matches[0];
      const record: EnvironmentModelProviderConnectionRecord = {
        kind: "environment_model_provider",
        id: previous?.id ?? proposedId,
        providerId: input.providerId,
        adapterId: "openai-chat-completions",
        label: `${entry.displayName} BYOK`,
        modelId: input.modelId,
        credentialEnvironmentVariable: input.credentialEnvironmentVariable,
        credentialIdentityFingerprint: bound.credentialFingerprint,
        policyRevision: entry.policy.revision,
        billingPolicy: structuredClone(entry.billing),
        billingSelection,
        configuredAt: now,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      const makePrimary = previous === undefined &&
        current.connections.length === 0 &&
        current.primaryConnectionId === null;
      try {
        const committed = await registry.commit(current.revision, (draft) => {
          const index = draft.connections.findIndex(
            (candidate) => candidate.id === record.id,
          );
          if (index === -1) draft.connections.push(record);
          else draft.connections[index] = record;
          if (makePrimary) draft.primaryConnectionId = record.id;
        });
        return configuration(record, committed.primaryConnectionId);
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
    throw new ConnectionRegistryError(
      "revision_conflict",
      "Connection registry revision changed",
    );
  } catch (error) {
    throw safeFailure(error);
  }
}

export async function verifyEnvironmentConnection(
  record: Readonly<EnvironmentModelProviderConnectionRecord>,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<EnvironmentConnectionVerification> {
  const apiKey = environment[record.credentialEnvironmentVariable];
  if (apiKey === undefined || apiKey.length === 0) {
    return { status: "failed", reason: "authentication_required" };
  }
  return await environmentCredentialFingerprint(record.providerId, apiKey) ===
      record.credentialIdentityFingerprint
    ? { status: "verified" }
    : { status: "failed", reason: "account_mismatch" };
}
