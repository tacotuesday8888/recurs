import type { JsonValue } from "./json.js";
import type { ModelReasoningEffort } from "./model.js";

export type AdapterKind = "model_provider" | "agent_runtime";
export type AccessKind =
  | "api"
  | "coding_plan"
  | "subscription"
  | "cloud_identity"
  | "local";
export type BillingSource =
  | "metered_api"
  | "included_subscription"
  | "prepaid_credits"
  | "cloud_account"
  | "local_compute";
export type AuthKind =
  | "api_key"
  | "coding_plan_key"
  | "oauth_pkce"
  | "device_code"
  | "cloud_identity"
  | "official_runtime"
  | "local_endpoint";

export type BillingSelectionMode =
  | "provider_default"
  | "strict_primary_only"
  | "allow_declared_additional";

export interface BillingPolicy {
  revision: string;
  disclosureRevision: string;
  primarySource: BillingSource;
  possibleAdditionalSources: readonly BillingSource[];
  providerFallback: "none" | "user_configured" | "automatic" | "unknown";
  availableSelections: readonly BillingSelectionMode[];
}

export interface BillingSelection {
  mode: BillingSelectionMode;
  policyRevision: string;
  disclosureRevision: string;
  allowedSources: readonly BillingSource[];
  acknowledgedAt: string;
}

export interface VerifiedAccountIdentity {
  subjectFingerprint: string;
  displayLabel: string;
  organizationLabel?: string;
  stability: "provider_verified" | "credential_bound";
}

export type ConnectionState =
  | { status: "ready" }
  | { status: "needs_verification"; reason: string }
  | { status: "needs_reauthentication"; reason: string }
  | {
      status: "disabled";
      reason: "no_compatible_model" | "policy" | "adapter" | "user";
    }
  | { status: "unavailable"; reason: string };

export interface ConnectionMetadata {
  schemaVersion: 1;
  id: string;
  providerId: string;
  adapterId: string;
  label: string;
  region: string;
  accessKind: AccessKind;
  authKind: AuthKind;
  accountIdentity: VerifiedAccountIdentity;
  billingPolicy: BillingPolicy;
  billingSelection: BillingSelection;
  settings: Readonly<Record<string, JsonValue>>;
  policyRevision: string;
  state: ConnectionState;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VerifiedModelLimits {
  source: "authenticated_provider_catalog";
  maxInputTokens: number;
  maxOutputTokens: number | null;
  verifiedAt: string;
}

export interface SessionBackendPin {
  kind: AdapterKind;
  providerId: string;
  adapterId: string;
  connectionId: string;
  modelId: string;
  modelIdentityKind: "versioned" | "mutable_alias" | "router";
  providerResolvedModelRevisionAtCreation: string | null;
  catalogRevision: string | null;
  policyRevisionAtCreation: string;
  billingPolicyRevisionAtCreation: string;
  primaryBillingSourceAtCreation: BillingSource;
  billingSelectionAtCreation: BillingSelection;
  accountSubjectFingerprint: string;
  reasoningEffortAtCreation?: ModelReasoningEffort;
  modelLimitsAtCreation?: VerifiedModelLimits;
  runtimeCapabilityProfileRevisionAtCreation?: string;
}
