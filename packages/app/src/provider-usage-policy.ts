import type {
  BillingSelectionMode,
  PolicyCondition,
  ProviderManifest,
  ProviderUsagePolicy,
  TrustedRunContext,
} from "@recurs/contracts";

const CLAIM_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export type ProviderPolicyClaimValue = string | number | boolean;

export interface ProviderPolicyClaim {
  readonly id: string;
  readonly value: ProviderPolicyClaimValue;
}

export interface ProviderPolicyBindingV1 {
  readonly schemaVersion: 1;
  readonly claims: readonly ProviderPolicyClaim[];
  readonly acknowledgedAt: string;
}

function claimIds(condition: PolicyCondition): readonly string[] {
  if (condition.type === "entitlement_claim") return [condition.claimId];
  if (condition.type === "billing_selection") return [];
  return condition.conditions.flatMap(claimIds);
}

export function requiredProviderPolicyClaimIds(
  policy: ProviderUsagePolicy,
): readonly string[] {
  return Object.freeze([...new Set(policy.rules.flatMap((rule) =>
    rule.condition === undefined ? [] : claimIds(rule.condition)
  ))].sort());
}

function contextMatches(
  expected: Partial<TrustedRunContext>,
  actual: TrustedRunContext,
): boolean {
  return Object.entries(expected).every(([key, value]) =>
    actual[key as keyof TrustedRunContext] === value
  );
}

function conditionSatisfied(
  condition: PolicyCondition,
  claims: ReadonlyMap<string, ProviderPolicyClaimValue>,
  billingSelection: BillingSelectionMode,
): boolean {
  if (condition.type === "billing_selection") {
    return condition.allowedModes.includes(billingSelection);
  }
  if (condition.type === "entitlement_claim") {
    const value = claims.get(condition.claimId);
    return value !== undefined && condition.allowedValues.includes(value);
  }
  return condition.conditions.every((child) =>
    conditionSatisfied(child, claims, billingSelection)
  );
}

export function providerUsagePolicyAllows(
  policy: ProviderUsagePolicy,
  binding: ProviderPolicyBindingV1 | undefined,
  billingSelection: BillingSelectionMode,
  context: TrustedRunContext,
): boolean {
  const claims = new Map(
    (binding?.claims ?? []).map((claim) => [claim.id, claim.value] as const),
  );
  const matching = policy.rules.filter((rule) =>
    contextMatches(rule.when, context)
  );
  if (matching.length === 0) return policy.defaultDecision === "allowed";
  return matching.every((rule) =>
    rule.decision === "allowed" ||
    (rule.decision === "conditional" && rule.condition !== undefined &&
      conditionSatisfied(rule.condition, claims, billingSelection))
  );
}

export function createProviderPolicyBinding(
  manifest: ProviderManifest,
  claims: readonly ProviderPolicyClaim[],
  billingSelection: BillingSelectionMode,
  context: TrustedRunContext | undefined,
  acknowledgedAt: string,
): ProviderPolicyBindingV1 | undefined {
  const required = requiredProviderPolicyClaimIds(manifest.usagePolicy);
  if (manifest.usagePolicy.rules.length === 0) {
    if (claims.length !== 0) {
      throw new TypeError("Provider policy claims are not expected");
    }
    return undefined;
  }
  if (context === undefined) {
    throw new TypeError("Provider policy context is required");
  }
  const seen = new Set<string>();
  const normalized = claims.map((claim) => {
    if (!CLAIM_ID.test(claim.id) || seen.has(claim.id)) {
      throw new TypeError("Provider policy claim is invalid");
    }
    seen.add(claim.id);
    return Object.freeze({ id: claim.id, value: claim.value });
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (
    normalized.length !== required.length ||
    normalized.some((claim, index) => claim.id !== required[index])
  ) {
    throw new TypeError("Provider policy claims are incomplete");
  }
  const binding = Object.freeze({
    schemaVersion: 1 as const,
    claims: Object.freeze(normalized),
    acknowledgedAt,
  });
  if (!providerUsagePolicyAllows(
    manifest.usagePolicy,
    binding,
    billingSelection,
    context,
  )) {
    throw new TypeError("Provider usage policy is not satisfied");
  }
  return binding;
}
