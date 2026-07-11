import type {
  BillingPolicy,
  BillingSelectionMode,
  PolicyCondition,
  ProviderEndpoint,
  ProviderManifest,
  ProviderRegionAvailability,
  ProviderUsagePolicy,
  TrustedRunContext,
  UsagePolicyRule,
} from "@recurs/contracts";

const ADAPTER_KINDS = ["model_provider", "agent_runtime"] as const;
const ACCESS_KINDS = [
  "api",
  "coding_plan",
  "subscription",
  "cloud_identity",
  "local",
] as const;
const AUTH_KINDS = [
  "api_key",
  "coding_plan_key",
  "oauth_pkce",
  "device_code",
  "cloud_identity",
  "official_runtime",
  "local_endpoint",
] as const;
const CREDENTIAL_OWNERS = ["recurs_broker", "vendor_runtime", "none"] as const;
const PROTOCOLS = [
  "openai_responses",
  "openai_chat",
  "anthropic_messages",
  "gemini_generate_content",
  "bedrock",
  "azure_openai",
  "acp",
  "sdk",
  "local_openai",
] as const;
const SUPPORT_STATUSES = [
  "supported",
  "conditional",
  "blocked_pending_written_approval",
  "blocked",
] as const;
const POLICY_DECISIONS = ["allowed", "conditional", "denied", "unknown"] as const;
const BILLING_SELECTION_MODES = [
  "provider_default",
  "strict_primary_only",
  "allow_declared_additional",
] as const;
const BILLING_SOURCES = [
  "metered_api",
  "included_subscription",
  "prepaid_credits",
  "cloud_account",
  "local_compute",
] as const;
const PROVIDER_FALLBACKS = [
  "none",
  "user_configured",
  "automatic",
  "unknown",
] as const;
const REGION_CATALOGS = ["aws", "gcp", "azure"] as const;

const MANIFEST_FIELDS = [
  "schemaVersion",
  "id",
  "displayName",
  "adapterKind",
  "accessKind",
  "authKinds",
  "credentialOwner",
  "protocol",
  "endpoints",
  "endpointEvidence",
  "regionAvailability",
  "billingPolicy",
  "supportStatus",
  "runnable",
  "usagePolicy",
] as const;
const BILLING_POLICY_FIELDS = [
  "revision",
  "disclosureRevision",
  "primarySource",
  "possibleAdditionalSources",
  "providerFallback",
  "availableSelections",
] as const;
const POLICY_FIELDS = [
  "revision",
  "reviewedAt",
  "expiresAt",
  "defaultDecision",
  "rules",
  "officialRuntimeRequired",
  "accountSharingForbidden",
  "sourceUrls",
  "evidenceSummary",
] as const;
const RULE_FIELDS = ["when", "decision", "condition", "reason"] as const;
const CONTEXT_FIELDS = [
  "invocation",
  "presence",
  "location",
  "automation",
  "embedding",
] as const;

type UnknownRecord = Record<string, unknown>;

function fail(message: string): never {
  throw new TypeError(message);
}

function record(value: unknown, label: string): UnknownRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

function noUnknownFields(
  value: UnknownRecord,
  allowed: readonly string[],
  label: string,
): void {
  const allowedFields = new Set(allowed);
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      fail(`${label} has unknown field "${field}"`);
    }
  }
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label} must be a nonempty string`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    fail(`${label} must be a boolean`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value as T[number])) {
    fail(`${label} has unsupported value`);
  }
  return value as T[number];
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
  }
  return value;
}

function uniqueEnumArray<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
  options: { allowEmpty?: boolean } = {},
): T[number][] {
  const values = arrayValue(value, label).map((entry) =>
    enumValue(entry, allowed, label),
  );
  if (
    (options.allowEmpty !== true && values.length === 0) ||
    new Set(values).size !== values.length
  ) {
    fail(`${label} must contain unique supported values`);
  }
  return values;
}

function exactValues(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function validateRegionAvailability(
  value: unknown,
  accessKind: string,
  protocol: string,
): ProviderRegionAvailability {
  const availability = record(value, "Provider region availability");
  const kind = enumValue(
    availability["kind"],
    ["global", "fixed", "provider_catalog", "local"] as const,
    "Provider region availability kind",
  );

  if (kind === "fixed") {
    noUnknownFields(
      availability,
      ["kind", "regions"],
      "Provider region availability",
    );
    const regions = arrayValue(
      availability["regions"],
      "Provider fixed regions",
    ).map((region) => nonemptyString(region, "Provider fixed region"));
    if (regions.length === 0 || new Set(regions).size !== regions.length) {
      fail("Provider fixed regions must be nonempty and unique");
    }
    for (const region of regions) {
      if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(region)) {
        fail("Provider fixed regions must use lowercase region identifiers");
      }
    }
  } else if (kind === "provider_catalog") {
    noUnknownFields(
      availability,
      ["kind", "catalog"],
      "Provider region availability",
    );
    enumValue(
      availability["catalog"],
      REGION_CATALOGS,
      "Provider region catalog",
    );
  } else {
    noUnknownFields(availability, ["kind"], "Provider region availability");
  }

  if (accessKind === "local") {
    if (kind !== "local") {
      fail("Local manifests require local region availability");
    }
  } else if (kind === "local") {
    fail("Remote manifests cannot declare local region availability");
  }

  if (accessKind === "cloud_identity") {
    if (kind !== "provider_catalog") {
      fail("Cloud-identity manifests require provider-catalog region availability");
    }
  } else if (kind === "provider_catalog") {
    fail("Provider-catalog regions are limited to cloud-identity manifests");
  }

  if (kind === "provider_catalog") {
    const catalog = availability["catalog"];
    if (protocol === "bedrock" && catalog !== "aws") {
      fail("Bedrock manifests require the AWS region catalog");
    }
    if (protocol === "gemini_generate_content" && catalog !== "gcp") {
      fail("Gemini cloud manifests require the GCP region catalog");
    }
    if (protocol === "azure_openai" && catalog !== "azure") {
      fail("Azure OpenAI manifests require the Azure region catalog");
    }
    if (
      protocol !== "bedrock" &&
      protocol !== "gemini_generate_content" &&
      protocol !== "azure_openai"
    ) {
      fail("Cloud-identity manifest protocol has no region-catalog binding");
    }
  }

  return availability as unknown as ProviderRegionAvailability;
}

function validateBillingPolicy(value: unknown): BillingPolicy {
  const policy = record(value, "Provider billing policy");
  noUnknownFields(policy, BILLING_POLICY_FIELDS, "Provider billing policy");
  nonemptyString(policy["revision"], "Provider billing policy revision");
  nonemptyString(
    policy["disclosureRevision"],
    "Provider billing policy disclosure revision",
  );
  const primarySource = enumValue(
    policy["primarySource"],
    BILLING_SOURCES,
    "Provider billing policy primary source",
  );
  const possibleAdditionalSources = uniqueEnumArray(
    policy["possibleAdditionalSources"],
    BILLING_SOURCES,
    "Provider billing policy possible additional sources",
    { allowEmpty: true },
  );
  if (possibleAdditionalSources.includes(primarySource)) {
    fail("Provider billing policy additional sources cannot repeat its primary source");
  }
  const providerFallback = enumValue(
    policy["providerFallback"],
    PROVIDER_FALLBACKS,
    "Provider billing policy fallback",
  );
  const availableSelections = uniqueEnumArray(
    policy["availableSelections"],
    BILLING_SELECTION_MODES,
    "Provider billing policy available selections",
    { allowEmpty: true },
  );

  if (providerFallback === "unknown") {
    if (possibleAdditionalSources.length > 0) {
      fail("Unknown provider fallback cannot claim known additional billing sources");
    }
    if (availableSelections.length > 0) {
      fail("Unknown provider fallback cannot expose available selections");
    }
    return policy as unknown as BillingPolicy;
  }

  if (availableSelections.length === 0) {
    fail("Known provider billing policy must expose an available selection");
  }
  if (
    providerFallback === "automatic" &&
    availableSelections.includes("strict_primary_only")
  ) {
    fail(
      "Automatic provider fallback cannot offer strict_primary_only without enforceable proof",
    );
  }
  if (
    providerFallback === "none" &&
    possibleAdditionalSources.length > 0
  ) {
    fail("Additional billing sources require a declared provider fallback");
  }
  if (
    (providerFallback === "user_configured" || providerFallback === "automatic") &&
    possibleAdditionalSources.length === 0
  ) {
    fail("Provider fallback requires a declared additional billing source");
  }
  if (
    possibleAdditionalSources.length > 0 &&
    !availableSelections.includes("allow_declared_additional")
  ) {
    fail(
      "Additional billing sources require an allow_declared_additional selection",
    );
  }
  if (
    possibleAdditionalSources.length === 0 &&
    availableSelections.includes("allow_declared_additional")
  ) {
    fail("allow_declared_additional requires an additional billing source");
  }
  if (
    availableSelections.includes("provider_default") &&
    providerFallback !== "automatic"
  ) {
    fail("provider_default requires a documented automatic provider fallback");
  }

  return policy as unknown as BillingPolicy;
}

function validateCondition(value: unknown, ancestors = new WeakSet<object>()): void {
  const condition = record(value, "Policy condition");
  if (ancestors.has(condition)) {
    fail("Policy condition cannot be recursive");
  }
  ancestors.add(condition);
  const type = enumValue(
    condition["type"],
    ["entitlement_claim", "billing_selection", "all"] as const,
    "Policy condition type",
  );

  if (type === "entitlement_claim") {
    noUnknownFields(
      condition,
      ["type", "claimId", "allowedValues"],
      "Policy condition",
    );
    nonemptyString(condition["claimId"], "Policy claim id");
    const allowedValues = arrayValue(
      condition["allowedValues"],
      "Policy claim allowed values",
    );
    if (allowedValues.length === 0) {
      fail("Policy claim allowed values must not be empty");
    }
    for (const allowed of allowedValues) {
      if (
        typeof allowed !== "string" &&
        typeof allowed !== "boolean" &&
        (typeof allowed !== "number" || !Number.isFinite(allowed))
      ) {
        fail("Policy claim allowed values must be scalar JSON values");
      }
    }
  } else if (type === "billing_selection") {
    noUnknownFields(
      condition,
      ["type", "allowedModes"],
      "Policy condition",
    );
    uniqueEnumArray(
      condition["allowedModes"],
      BILLING_SELECTION_MODES,
      "Policy billing selection modes",
    );
  } else {
    noUnknownFields(condition, ["type", "conditions"], "Policy condition");
    const conditions = arrayValue(condition["conditions"], "Policy conditions");
    if (conditions.length === 0) {
      fail("Combined policy condition must not be empty");
    }
    for (const child of conditions) {
      validateCondition(child, ancestors);
    }
  }
  ancestors.delete(condition);
}

function validateRunContext(value: unknown): void {
  const context = record(value, "Usage policy context");
  noUnknownFields(context, CONTEXT_FIELDS, "Usage policy context");
  if (context["invocation"] !== undefined) {
    enumValue(
      context["invocation"],
      ["repl", "one_shot", "goal"] as const,
      "Usage policy invocation",
    );
  }
  if (context["presence"] !== undefined) {
    enumValue(
      context["presence"],
      ["present", "unattended"] as const,
      "Usage policy presence",
    );
  }
  if (context["location"] !== undefined) {
    enumValue(
      context["location"],
      ["local", "remote"] as const,
      "Usage policy location",
    );
  }
  if (context["automation"] !== undefined) {
    enumValue(
      context["automation"],
      ["manual", "scripted"] as const,
      "Usage policy automation",
    );
  }
  if (context["embedding"] !== undefined) {
    enumValue(
      context["embedding"],
      ["cli", "desktop", "sdk", "ci"] as const,
      "Usage policy embedding",
    );
  }
}

function validateRule(value: unknown): UsagePolicyRule {
  const rule = record(value, "Usage policy rule");
  noUnknownFields(rule, RULE_FIELDS, "Usage policy rule");
  validateRunContext(rule["when"]);
  const decision = enumValue(
    rule["decision"],
    POLICY_DECISIONS,
    "Usage policy rule decision",
  );
  nonemptyString(rule["reason"], "Usage policy rule reason");
  if (decision === "conditional") {
    if (rule["condition"] === undefined) {
      fail("Conditional usage policy rules require a machine-evaluable condition");
    }
    validateCondition(rule["condition"]);
  } else if (rule["condition"] !== undefined) {
    fail("Only conditional usage policy rules may include a condition");
  }
  return rule as unknown as UsagePolicyRule;
}

function validatePolicy(value: unknown): ProviderUsagePolicy {
  const policy = record(value, "Provider usage policy");
  noUnknownFields(policy, POLICY_FIELDS, "Provider usage policy");
  nonemptyString(policy["revision"], "Provider usage policy revision");
  const reviewedAt = nonemptyString(
    policy["reviewedAt"],
    "Provider usage policy review date",
  );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt)) {
    fail("Provider usage policy review date must use YYYY-MM-DD");
  }
  const reviewedTimestamp = Date.parse(`${reviewedAt}T00:00:00.000Z`);
  if (
    !Number.isFinite(reviewedTimestamp) ||
    new Date(reviewedTimestamp).toISOString() !== `${reviewedAt}T00:00:00.000Z`
  ) {
    fail("Provider usage policy review date must be a real calendar date");
  }
  const expiresAt = nonemptyString(
    policy["expiresAt"],
    "Provider usage policy expiry",
  );
  const expiresDate = new Date(expiresAt);
  if (!Number.isFinite(expiresDate.getTime()) || expiresDate.toISOString() !== expiresAt) {
    fail("Provider usage policy expiry must be an exact ISO timestamp");
  }
  if (expiresDate.getTime() <= reviewedTimestamp) {
    fail("Provider usage policy expiry must be after its review date");
  }
  enumValue(
    policy["defaultDecision"],
    POLICY_DECISIONS,
    "Provider usage policy default decision",
  );
  const rules = arrayValue(policy["rules"], "Provider usage policy rules");
  for (const rule of rules) {
    validateRule(rule);
  }
  booleanValue(
    policy["officialRuntimeRequired"],
    "Provider usage policy official runtime requirement",
  );
  booleanValue(
    policy["accountSharingForbidden"],
    "Provider usage policy account-sharing restriction",
  );
  const sourceUrls = arrayValue(
    policy["sourceUrls"],
    "Provider usage policy source URLs",
  ).map((source) => nonemptyString(source, "Provider usage policy source URL"));
  if (sourceUrls.length === 0 || new Set(sourceUrls).size !== sourceUrls.length) {
    fail("Provider usage policy source URLs must be nonempty and unique");
  }
  for (const sourceUrl of sourceUrls) {
    let parsed: URL;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      fail("Provider usage policy source URL must be valid HTTPS");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      fail("Provider usage policy source URL must be valid HTTPS");
    }
  }
  nonemptyString(
    policy["evidenceSummary"],
    "Provider usage policy evidence summary",
  );
  return policy as unknown as ProviderUsagePolicy;
}

function validateEndpoint(value: unknown, accessKind: string): ProviderEndpoint {
  const endpoint = record(value, "Provider endpoint");
  noUnknownFields(endpoint, ["kind", "value"], "Provider endpoint");
  const kind = enumValue(
    endpoint["kind"],
    ["origin", "template"] as const,
    "Provider endpoint kind",
  );
  const endpointValue = nonemptyString(endpoint["value"], "Provider endpoint value");

  if (kind === "origin") {
    if (/[{}]/.test(endpointValue)) {
      fail("Concrete origin endpoint must not contain template placeholders");
    }
    let parsed: URL;
    try {
      parsed = new URL(endpointValue);
    } catch {
      fail("Concrete origin endpoint must be a valid URL");
    }
    if (
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      fail("Concrete origin endpoint cannot contain credentials, query, or fragment");
    }
    if (accessKind === "local") {
      if (
        parsed.protocol !== "http:" ||
        (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]")
      ) {
        fail("Local provider origin must use plain HTTP on a literal loopback host");
      }
    } else if (parsed.protocol !== "https:") {
      fail("Remote provider origin must use HTTPS");
    }
  } else {
    if (accessKind !== "cloud_identity") {
      fail("Endpoint templates are limited to cloud-identity manifests");
    }
    const placeholders = endpointValue.match(/\{[a-z][A-Za-z0-9_]*\}/g) ?? [];
    if (placeholders.length === 0) {
      fail("Endpoint template must contain a placeholder");
    }
    const concrete = endpointValue.replace(/\{[a-z][A-Za-z0-9_]*\}/g, "template");
    if (/[{}]/.test(concrete)) {
      fail("Endpoint template contains an invalid placeholder");
    }
    let parsed: URL;
    try {
      parsed = new URL(concrete);
    } catch {
      fail("Endpoint template must resolve to a valid URL shape");
    }
    if (
      parsed.protocol !== "https:" ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      fail("Endpoint template must resolve to credential-free HTTPS");
    }
  }
  return endpoint as unknown as ProviderEndpoint;
}

function validateLaneAndCredentials(manifest: UnknownRecord): void {
  const adapterKind = manifest["adapterKind"] as string;
  const accessKind = manifest["accessKind"] as string;
  const authKinds = manifest["authKinds"] as string[];
  const credentialOwner = manifest["credentialOwner"] as string;
  const protocol = manifest["protocol"] as string;
  const policy = manifest["usagePolicy"] as UnknownRecord;

  if (adapterKind === "agent_runtime") {
    if (
      accessKind !== "subscription" ||
      credentialOwner !== "vendor_runtime" ||
      !exactValues(authKinds, ["official_runtime"]) ||
      (protocol !== "acp" && protocol !== "sdk")
    ) {
      fail("Agent-runtime manifests require a vendor-runtime credential owner");
    }
    if (policy["officialRuntimeRequired"] !== true) {
      fail("Agent-runtime manifests must require the official runtime");
    }
    return;
  }

  if (credentialOwner === "vendor_runtime") {
    fail("Model-provider manifests cannot use a vendor-runtime credential owner");
  }
  if (policy["officialRuntimeRequired"] !== false) {
    fail("Model-provider manifests cannot require an official runtime");
  }
  if (accessKind === "local") {
    if (
      credentialOwner !== "none" ||
      !exactValues(authKinds, ["local_endpoint"]) ||
      protocol !== "local_openai"
    ) {
      fail("Local manifests require no credential owner and local endpoint auth");
    }
    return;
  }
  if (credentialOwner !== "recurs_broker") {
    fail("Remote model-provider manifests require the Recurs broker credential owner");
  }
  if (protocol === "acp" || protocol === "sdk" || protocol === "local_openai") {
    fail("Remote model-provider manifests use an invalid protocol for their lane");
  }
  if (accessKind === "coding_plan" && !exactValues(authKinds, ["coding_plan_key"])) {
    fail("Coding-plan manifests require coding-plan-key authentication");
  }
  if (accessKind === "cloud_identity" && !exactValues(authKinds, ["cloud_identity"])) {
    fail("Cloud manifests require cloud-identity authentication");
  }
  if (
    (accessKind === "api" || accessKind === "subscription") &&
    (!authKinds.includes("api_key") ||
      authKinds.some((kind) => kind !== "api_key" && kind !== "oauth_pkce"))
  ) {
    fail("Direct API and keyed subscription manifests require API-key authentication");
  }
}

function billingSelectionModes(
  condition: PolicyCondition,
): readonly BillingSelectionMode[] {
  if (condition.type === "billing_selection") {
    return condition.allowedModes;
  }
  if (condition.type === "all") {
    return condition.conditions.flatMap((child) => billingSelectionModes(child));
  }
  return [];
}

function contextRuleCovers(
  gate: Partial<TrustedRunContext>,
  candidate: Partial<TrustedRunContext>,
): boolean {
  return CONTEXT_FIELDS.every((field) =>
    gate[field] === undefined || gate[field] === candidate[field]
  );
}

function validateBillingAndPolicy(
  manifest: UnknownRecord,
  billingPolicy: BillingPolicy,
  usagePolicy: ProviderUsagePolicy,
): void {
  const accessKind = manifest["accessKind"] as string;
  const runnable = manifest["runnable"] as boolean;

  if (
    (accessKind === "coding_plan" || accessKind === "subscription") &&
    billingPolicy.primarySource !== "included_subscription"
  ) {
    fail("Subscription and coding-plan manifests require included-subscription billing");
  }
  if (
    accessKind === "api" &&
    billingPolicy.primarySource !== "metered_api" &&
    billingPolicy.primarySource !== "prepaid_credits"
  ) {
    fail("API manifests require metered-API or prepaid-credit billing");
  }
  if (
    accessKind === "cloud_identity" &&
    billingPolicy.primarySource !== "cloud_account"
  ) {
    fail("Cloud-identity manifests require cloud-account billing");
  }
  if (accessKind === "local" && billingPolicy.primarySource !== "local_compute") {
    fail("Local manifests require local-compute billing");
  }

  const availableSelections = new Set(billingPolicy.availableSelections);
  const additionalBillingGates: UsagePolicyRule[] = [];
  for (const rule of usagePolicy.rules) {
    if (rule.condition === undefined) {
      continue;
    }
    const modes = billingSelectionModes(rule.condition);
    for (const mode of modes) {
      if (!availableSelections.has(mode)) {
        fail(
          "A billing-selection condition cannot allow a mode absent from the billing policy",
        );
      }
    }
    if (modes.includes("allow_declared_additional")) {
      additionalBillingGates.push(rule);
    }
  }

  if (billingPolicy.providerFallback === "unknown") {
    if (usagePolicy.defaultDecision !== "denied") {
      fail("Unknown provider fallback requires manifests to default to denied");
    }
    if (runnable) {
      fail("Unknown provider fallback cannot be runnable");
    }
  }

  if (billingPolicy.providerFallback === "automatic") {
    if (usagePolicy.defaultDecision !== "denied") {
      fail("Automatic billing fallback requires manifests to default to denied");
    }
    if (additionalBillingGates.length === 0) {
      fail(
        "Automatic billing fallback requires an explicit billing-selection condition",
      );
    }
    for (const rule of usagePolicy.rules) {
      if (
        rule.decision !== "denied" &&
        !additionalBillingGates.some((gate) =>
          contextRuleCovers(gate.when, rule.when)
        )
      ) {
        fail(
          "Automatic billing fallback requires every potentially allowing context to be covered by a billing-selection gate",
        );
      }
    }
  }
}

function assertNoSecretMaterial(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value === "string") {
    if (/\b(?:sk|key|token)-[A-Za-z0-9_-]{16,}\b/.test(value)) {
      fail("Provider manifests cannot contain live-looking credential material");
    }
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const entry of Array.isArray(value) ? value : Object.values(value)) {
    assertNoSecretMaterial(entry, seen);
  }
}

function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreeze(entry))) as T;
  }
  if (typeof value === "object" && value !== null) {
    const clone: UnknownRecord = {};
    for (const [key, entry] of Object.entries(value)) {
      clone[key] = cloneAndFreeze(entry);
    }
    return Object.freeze(clone) as T;
  }
  return value;
}

export function validateProviderManifest(value: unknown): ProviderManifest {
  const manifest = record(value, "Provider manifest");
  noUnknownFields(manifest, MANIFEST_FIELDS, "Provider manifest");
  if (manifest["schemaVersion"] !== 1) {
    fail("Provider manifest schema version must be 1");
  }
  const id = nonemptyString(manifest["id"], "Provider manifest id");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    fail("Provider manifest id must use lowercase kebab case");
  }
  nonemptyString(manifest["displayName"], "Provider manifest display name");
  const adapterKind = enumValue(
    manifest["adapterKind"],
    ADAPTER_KINDS,
    "Provider adapter kind",
  );
  const accessKind = enumValue(
    manifest["accessKind"],
    ACCESS_KINDS,
    "Provider access kind",
  );
  uniqueEnumArray(manifest["authKinds"], AUTH_KINDS, "Provider auth kinds");
  const credentialOwner = enumValue(
    manifest["credentialOwner"],
    CREDENTIAL_OWNERS,
    "Provider credential owner",
  );
  const protocol = enumValue(
    manifest["protocol"],
    PROTOCOLS,
    "Provider protocol",
  );
  const endpoints = arrayValue(manifest["endpoints"], "Provider endpoints").map(
    (endpoint) => validateEndpoint(endpoint, accessKind),
  );
  const endpointKeys = endpoints.map((endpoint) => `${endpoint.kind}:${endpoint.value}`);
  if (new Set(endpointKeys).size !== endpointKeys.length) {
    fail("Provider endpoints must be unique");
  }
  if (adapterKind === "agent_runtime" && endpoints.length > 0) {
    fail("A delegated runtime manifest cannot declare an HTTP endpoint");
  }
  validateRegionAvailability(
    manifest["regionAvailability"],
    accessKind,
    protocol,
  );
  const billingPolicy = validateBillingPolicy(manifest["billingPolicy"]);
  const status = enumValue(
    manifest["supportStatus"],
    SUPPORT_STATUSES,
    "Provider support status",
  );
  if (endpoints.length === 0) {
    if (status === "supported") {
      fail("Supported manifests cannot have empty endpoints");
    }
    nonemptyString(manifest["endpointEvidence"], "Provider endpoint evidence");
  } else if (manifest["endpointEvidence"] !== undefined) {
    nonemptyString(manifest["endpointEvidence"], "Provider endpoint evidence");
  }
  const runnable = booleanValue(manifest["runnable"], "Provider runnable state");
  if (
    runnable &&
    (status === "blocked" || status === "blocked_pending_written_approval")
  ) {
    fail("Blocked provider manifests cannot be runnable");
  }
  const policy = validatePolicy(manifest["usagePolicy"]);
  if (status === "conditional" && policy.defaultDecision !== "denied") {
    fail("Conditional provider manifests must default to denied");
  }
  if (
    status === "conditional" &&
    !policy.rules.some(
      (rule) => rule.decision === "conditional" && rule.condition !== undefined,
    )
  ) {
    fail("Conditional provider manifests require a machine-evaluable condition");
  }
  if (
    (status === "blocked" || status === "blocked_pending_written_approval") &&
    policy.defaultDecision !== "denied"
  ) {
    fail("Blocked provider manifests must default to denied");
  }
  validateLaneAndCredentials(manifest);
  validateBillingAndPolicy(manifest, billingPolicy, policy);
  if (runnable && credentialOwner === "recurs_broker") {
    fail("Broker-owned provider paths cannot run before the native credential broker exists");
  }
  assertNoSecretMaterial(manifest);
  return cloneAndFreeze(manifest) as unknown as ProviderManifest;
}
