import { createHash } from "node:crypto";

import type {
  RunAuthorization,
  SessionBackendPin,
  TrustedRunContext,
} from "@recurs/contracts";
import { describe, expect, it } from "vitest";

import {
  BackendAuthorizationError,
  bindRunAuthorization,
  createBackendFingerprint,
  createBillingSelectionDigest,
  createContextDigest,
  verifyRunAuthorization,
  type RunAuthorizationBinding,
} from "../src/backend-authorization.js";

const now = new Date("2026-07-11T00:00:00.000Z");
const expiresAt = "2026-07-11T00:01:00.000Z";

const pin: SessionBackendPin = {
  kind: "agent_runtime",
  runtimeCapabilityProfileRevisionAtCreation: "capabilities-v1",
  providerId: "official-agent",
  adapterId: "official-agent-v1",
  connectionId: "connection-1",
  modelId: "model-1",
  modelIdentityKind: "versioned",
  providerResolvedModelRevisionAtCreation: "model-1.2.3",
  catalogRevision: "catalog-7",
  policyRevisionAtCreation: "policy-5",
  billingPolicyRevisionAtCreation: "billing-3",
  primaryBillingSourceAtCreation: "included_subscription",
  billingSelectionAtCreation: {
    mode: "strict_primary_only",
    policyRevision: "billing-3",
    disclosureRevision: "disclosure-2",
    allowedSources: ["included_subscription"],
    acknowledgedAt: "2026-07-10T00:00:00.000Z",
  },
  accountSubjectFingerprint: `sha256:${"a".repeat(64)}`,
};

const context: TrustedRunContext = {
  invocation: "one_shot",
  presence: "present",
  location: "local",
  automation: "manual",
  embedding: "cli",
};

function binding(
  overrides: Partial<RunAuthorizationBinding> = {},
): RunAuthorizationBinding {
  return {
    id: "authorization-1",
    operation: "run",
    sessionId: "session-1",
    operationId: "operation-1",
    turnId: "turn-1",
    pin,
    connectionRevision: 4,
    policyRevision: pin.policyRevisionAtCreation,
    context,
    maxRequests: 3,
    expiresAt,
    ...overrides,
  };
}

describe("backend authorization binding", () => {
  it("uses property-order-stable domain-separated canonical digests", () => {
    const reorderedPin = {
      accountSubjectFingerprint: pin.accountSubjectFingerprint,
      billingSelectionAtCreation: {
        acknowledgedAt: pin.billingSelectionAtCreation.acknowledgedAt,
        allowedSources: [...pin.billingSelectionAtCreation.allowedSources],
        disclosureRevision: pin.billingSelectionAtCreation.disclosureRevision,
        policyRevision: pin.billingSelectionAtCreation.policyRevision,
        mode: pin.billingSelectionAtCreation.mode,
      },
      primaryBillingSourceAtCreation: pin.primaryBillingSourceAtCreation,
      billingPolicyRevisionAtCreation: pin.billingPolicyRevisionAtCreation,
      policyRevisionAtCreation: pin.policyRevisionAtCreation,
      catalogRevision: pin.catalogRevision,
      providerResolvedModelRevisionAtCreation:
        pin.providerResolvedModelRevisionAtCreation,
      modelIdentityKind: pin.modelIdentityKind,
      modelId: pin.modelId,
      connectionId: pin.connectionId,
      adapterId: pin.adapterId,
      providerId: pin.providerId,
      kind: pin.kind,
      runtimeCapabilityProfileRevisionAtCreation:
        pin.runtimeCapabilityProfileRevisionAtCreation,
    } satisfies SessionBackendPin;
    const reorderedContext = {
      embedding: context.embedding,
      automation: context.automation,
      location: context.location,
      presence: context.presence,
      invocation: context.invocation,
    } satisfies TrustedRunContext;

    expect(createBackendFingerprint(reorderedPin)).toBe(
      createBackendFingerprint(pin),
    );
    expect(createBillingSelectionDigest(reorderedPin.billingSelectionAtCreation))
      .toBe(createBillingSelectionDigest(pin.billingSelectionAtCreation));
    expect(createContextDigest(reorderedContext)).toBe(createContextDigest(context));
    expect(createBackendFingerprint({ ...pin, modelId: "model-2" })).not.toBe(
      createBackendFingerprint(pin),
    );
    expect(createBackendFingerprint({
      ...pin,
      runtimeCapabilityProfileRevisionAtCreation: "capabilities-v2",
    })).not.toBe(createBackendFingerprint(pin));
    expect(createBillingSelectionDigest({
      ...pin.billingSelectionAtCreation,
      mode: "provider_default",
    })).not.toBe(createBillingSelectionDigest(pin.billingSelectionAtCreation));
    expect(createContextDigest({ ...context, presence: "unattended" })).not.toBe(
      createContextDigest(context),
    );
  });

  it("binds and verifies every visible authorization field", () => {
    const expectedBinding = binding();
    const authorization = bindRunAuthorization(expectedBinding, now);

    expect(authorization).toEqual({
      kind: "run",
      id: expectedBinding.id,
      operation: expectedBinding.operation,
      sessionId: expectedBinding.sessionId,
      operationId: expectedBinding.operationId,
      turnId: expectedBinding.turnId,
      connectionId: pin.connectionId,
      modelId: pin.modelId,
      backendFingerprint: createBackendFingerprint(pin),
      connectionRevision: expectedBinding.connectionRevision,
      policyRevision: expectedBinding.policyRevision,
      billingMode: pin.billingSelectionAtCreation.mode,
      billingSelectionDigest: createBillingSelectionDigest(
        pin.billingSelectionAtCreation,
      ),
      contextDigest: createContextDigest(context),
      maxRequests: expectedBinding.maxRequests,
      expiresAt,
    });
    expect(verifyRunAuthorization(authorization, expectedBinding, now)).toBe(
      authorization,
    );

    for (const key of Object.keys(authorization) as (keyof RunAuthorization)[]) {
      const changed = { ...authorization } as RunAuthorization;
      (changed as unknown as Record<string, unknown>)[key] = key === "turnId"
        ? "other-turn"
        : key === "connectionRevision" || key === "maxRequests"
          ? (authorization[key] as number) + 1
          : `${String(authorization[key])}-changed`;
      expect(
        () => verifyRunAuthorization(changed, expectedBinding, now),
        key,
      ).toThrow(BackendAuthorizationError);
    }
  });

  it("enforces operation turn nullability, safe budgets, and canonical future expiry", () => {
    expect(() => bindRunAuthorization(binding({ turnId: null }), now)).toThrow();
    expect(() => bindRunAuthorization(binding({ operation: "compact" }), now))
      .toThrow();
    expect(() => bindRunAuthorization(binding({
      operation: "compact",
      turnId: null,
    }), now)).not.toThrow();
    expect(() => bindRunAuthorization(binding({
      operation: "runtime_reconcile",
      turnId: null,
    }), now)).not.toThrow();
    expect(() => bindRunAuthorization(binding({
      policyRevision: "different-policy",
    }), now)).toThrow(BackendAuthorizationError);
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => bindRunAuthorization(binding({ maxRequests: invalid }), now))
        .toThrow();
    }
    expect(() => bindRunAuthorization(binding({ connectionRevision: 0 }), now))
      .not.toThrow();
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => bindRunAuthorization(
        binding({ connectionRevision: invalid }),
        now,
      )).toThrow();
    }
    expect(() => bindRunAuthorization(binding({ expiresAt: now.toISOString() }), now))
      .toThrow();
    expect(() => bindRunAuthorization(
      binding({ expiresAt: "2026-07-11T00:01:00Z" }),
      now,
    )).toThrow();
  });

  it("rejects legacy raw JSON fingerprints without exposing compared values", () => {
    const expectedBinding = binding();
    const authorization = bindRunAuthorization(expectedBinding, now);
    const rawFingerprint = createHash("sha256")
      .update(JSON.stringify(pin))
      .digest("hex");

    let error: unknown;
    try {
      verifyRunAuthorization(
        { ...authorization, backendFingerprint: rawFingerprint },
        expectedBinding,
        now,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(BackendAuthorizationError);
    expect(String(error)).not.toContain(rawFingerprint);
    expect(String(error)).not.toContain(pin.connectionId);
  });
});
