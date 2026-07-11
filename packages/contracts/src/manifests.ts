import type {
  AccessKind,
  AdapterKind,
  AuthKind,
  BillingSelectionMode,
} from "./connections.js";
import type { TrustedRunContext } from "./runtime.js";

export type SupportStatus =
  | "supported"
  | "conditional"
  | "blocked_pending_written_approval"
  | "blocked";

export type ProviderProtocol =
  | "openai_responses"
  | "openai_chat"
  | "anthropic_messages"
  | "gemini_generate_content"
  | "bedrock"
  | "azure_openai"
  | "acp"
  | "sdk"
  | "local_openai";

export type ProviderEndpoint =
  | { kind: "origin"; value: string }
  | { kind: "template"; value: string };

export type PolicyDecision = "allowed" | "conditional" | "denied" | "unknown";

export type PolicyCondition =
  | {
      type: "entitlement_claim";
      claimId: string;
      allowedValues: readonly (string | number | boolean)[];
    }
  | {
      type: "billing_selection";
      allowedModes: readonly BillingSelectionMode[];
    }
  | { type: "all"; conditions: readonly PolicyCondition[] };

export interface UsagePolicyRule {
  when: Partial<TrustedRunContext>;
  decision: PolicyDecision;
  condition?: PolicyCondition;
  reason: string;
}

export interface ProviderUsagePolicy {
  revision: string;
  reviewedAt: string;
  expiresAt: string;
  defaultDecision: PolicyDecision;
  rules: readonly UsagePolicyRule[];
  officialRuntimeRequired: boolean;
  accountSharingForbidden: boolean;
  sourceUrls: readonly string[];
  evidenceSummary: string;
}

export interface ProviderManifest {
  schemaVersion: 1;
  id: string;
  displayName: string;
  adapterKind: AdapterKind;
  accessKind: AccessKind;
  authKinds: readonly AuthKind[];
  credentialOwner: "recurs_broker" | "vendor_runtime" | "none";
  protocol: ProviderProtocol;
  endpoints: readonly ProviderEndpoint[];
  endpointEvidence?: string;
  supportStatus: SupportStatus;
  runnable: boolean;
  usagePolicy: ProviderUsagePolicy;
}
