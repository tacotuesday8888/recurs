import type {
  AccessKind,
  AdapterKind,
  BillingSource,
  ProviderManifest,
  ProviderProtocol,
  SupportStatus,
} from "@recurs/contracts";
import {
  ConnectionLifecycleService,
  FileConnectionRegistry,
  OnboardingCatalog,
  verifyEnvironmentConnection,
  verifyLocalConnection,
  type ConnectionDisconnection,
  type ConnectionSummary,
  type ConnectionVerification,
  type ConnectionVerifier,
  type OnboardingStatus,
} from "@recurs/app";

import { verifyCodexSubscriptionConnection } from "./codex-connection.js";

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
  };
  readonly restrictions: readonly string[];
}

export type AccountSummary = ConnectionSummary;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
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
    },
    restrictions: [...entry.restrictions],
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
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ConnectionVerifier {
  return {
    verifyLocal: (record, signal) => verifyLocalConnection(record, { signal }),
    verifyDelegated: (record, signal) =>
      verifyCodexSubscriptionConnection(record, cwd, signal),
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
      dependencies.environment ?? process.env,
    ),
    signal === undefined ? {} : { signal },
  );
}
