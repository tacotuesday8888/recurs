import type { SessionBackendPin } from "@recurs/contracts";

export const testAt = "2026-07-10T00:00:00.000Z";

export function testBackendPin(
  modelId = "scripted",
  connectionId = "test-connection",
): SessionBackendPin {
  return {
    kind: "model_provider",
    providerId: "scripted",
    adapterId: "scripted-v1",
    connectionId,
    modelId,
    modelIdentityKind: "versioned",
    providerResolvedModelRevisionAtCreation: `${modelId}-1`,
    catalogRevision: "test-catalog-1",
    policyRevisionAtCreation: "test-policy-1",
    billingPolicyRevisionAtCreation: "test-billing-1",
    primaryBillingSourceAtCreation: "local_compute",
    billingSelectionAtCreation: {
      mode: "strict_primary_only",
      policyRevision: "test-policy-1",
      disclosureRevision: "test-disclosure-1",
      allowedSources: ["local_compute"],
      acknowledgedAt: testAt,
    },
    accountSubjectFingerprint: "test-account",
  };
}
