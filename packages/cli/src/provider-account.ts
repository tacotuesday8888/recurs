import type {
  AccessKind,
  AdapterKind,
  BillingSource,
  ProviderManifest,
  ProviderProtocol,
  SupportStatus,
} from "@recurs/contracts";
import {
  FileConnectionRegistry,
  OnboardingCatalog,
  type OnboardingStatus,
} from "@recurs/app";

export interface ProviderSummary {
  readonly id: string;
  readonly displayName: string;
  readonly status: OnboardingStatus;
  readonly supportStatus: SupportStatus;
  readonly adapterKind: AdapterKind;
  readonly accessKind: AccessKind;
  readonly protocol: ProviderProtocol;
  readonly connectionOwner: ProviderManifest["credentialOwner"];
  readonly billing: {
    readonly primarySource: BillingSource;
    readonly possibleAdditionalSources: readonly BillingSource[];
    readonly providerFallback: "none" | "user_configured" | "automatic" | "unknown";
  };
  readonly restrictions: readonly string[];
}

export interface AccountSummary {
  readonly id: string;
  readonly label: string;
  readonly providerId: string;
  readonly adapterId: string;
  readonly kind: "local_openai_compatible" | "delegated_agent";
  readonly modelId: string;
  readonly primary: boolean;
  readonly account:
    | "verified (identifier redacted)"
    | "local endpoint (no credential)";
  readonly execution: "Plan-only" | "Act + Plan";
  readonly billingSources: readonly BillingSource[];
}

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
  const document = await new FileConnectionRegistry(
    dataDirectory,
  ).migrateLegacyLocal();
  const summaries = document.connections.map((connection): AccountSummary => {
    if (connection.kind === "local_openai_compatible") {
      return {
        id: connection.id,
        label: connection.label,
        providerId: connection.providerId,
        adapterId: connection.adapterId,
        kind: connection.kind,
        modelId: connection.modelId,
        primary: document.primaryConnectionId === connection.id,
        account: "local endpoint (no credential)",
        execution: "Act + Plan",
        billingSources: ["local_compute"],
      };
    }
    return {
      id: connection.id,
      label: connection.label,
      providerId: connection.providerId,
      adapterId: connection.adapterId,
      kind: connection.kind,
      modelId: connection.modelId,
      primary: document.primaryConnectionId === connection.id,
      account: "verified (identifier redacted)",
      execution: connection.adapterId === "codex-acp"
        ? "Plan-only"
        : "Act + Plan",
      billingSources: [...connection.billingSelection.allowedSources],
    };
  });
  summaries.sort((left, right) =>
    Number(right.primary) - Number(left.primary) ||
    left.id.localeCompare(right.id)
  );
  return deepFreeze(summaries);
}
