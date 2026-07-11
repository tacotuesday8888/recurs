import { describe, expect, it } from "vitest";

import type {
  BillingPolicy,
  BillingSelectionMode,
  BillingSource,
  ProviderManifest,
} from "@recurs/contracts";

import {
  BUNDLED_PROVIDER_MANIFESTS,
  ProviderManifestRegistry,
  validateProviderManifest,
} from "../src/index.js";

const REVIEWED_AT = "2026-07-11";
const EXPIRES_AT = "2026-10-11T00:00:00.000Z";

function expectedBillingPolicy(
  id: string,
  primarySource: BillingSource,
  options: {
    possibleAdditionalSources?: readonly BillingSource[];
    providerFallback?: BillingPolicy["providerFallback"];
    availableSelections?: readonly BillingSelectionMode[];
  } = {},
): BillingPolicy {
  return {
    revision: `billing:${id}:2026-07-11`,
    disclosureRevision: `billing-disclosure:${id}:2026-07-11`,
    primarySource,
    possibleAdditionalSources: options.possibleAdditionalSources ?? [],
    providerFallback: options.providerFallback ?? "none",
    availableSelections: options.availableSelections ?? ["strict_primary_only"],
  };
}

const REGION_AND_BILLING_MATRIX = [
  {
    id: "openai-api",
    regionAvailability: { kind: "global" },
    billingPolicy: expectedBillingPolicy("openai-api", "metered_api"),
  },
  {
    id: "openai-codex-chatgpt",
    regionAvailability: { kind: "global" },
    billingPolicy: expectedBillingPolicy(
      "openai-codex-chatgpt",
      "included_subscription",
    ),
  },
  {
    id: "anthropic-api",
    regionAvailability: { kind: "global" },
    billingPolicy: expectedBillingPolicy("anthropic-api", "metered_api"),
  },
  {
    id: "anthropic-claude-subscription",
    regionAvailability: { kind: "global" },
    billingPolicy: expectedBillingPolicy(
      "anthropic-claude-subscription",
      "included_subscription",
    ),
  },
  {
    id: "github-copilot-subscription",
    regionAvailability: { kind: "global" },
    billingPolicy: expectedBillingPolicy(
      "github-copilot-subscription",
      "included_subscription",
    ),
  },
  {
    id: "openrouter-api",
    regionAvailability: { kind: "global" },
    billingPolicy: expectedBillingPolicy("openrouter-api", "prepaid_credits"),
  },
  {
    id: "opencode-zen",
    regionAvailability: { kind: "global" },
    billingPolicy: expectedBillingPolicy("opencode-zen", "prepaid_credits"),
  },
  {
    id: "opencode-go",
    regionAvailability: {
      kind: "fixed",
      regions: ["us", "eu", "singapore"],
    },
    billingPolicy: expectedBillingPolicy(
      "opencode-go",
      "included_subscription",
      {
        possibleAdditionalSources: ["prepaid_credits"],
        providerFallback: "user_configured",
        availableSelections: [
          "strict_primary_only",
          "allow_declared_additional",
        ],
      },
    ),
  },
  {
    id: "kilo-gateway",
    regionAvailability: { kind: "global" },
    billingPolicy: expectedBillingPolicy("kilo-gateway", "prepaid_credits"),
  },
  {
    id: "nous-portal",
    regionAvailability: { kind: "global" },
    billingPolicy: expectedBillingPolicy(
      "nous-portal",
      "included_subscription",
    ),
  },
  {
    id: "alibaba-model-studio-api",
    regionAvailability: { kind: "fixed", regions: ["international"] },
    billingPolicy: expectedBillingPolicy(
      "alibaba-model-studio-api",
      "metered_api",
    ),
  },
  {
    id: "alibaba-coding-plan",
    regionAvailability: { kind: "fixed", regions: ["international"] },
    billingPolicy: expectedBillingPolicy(
      "alibaba-coding-plan",
      "included_subscription",
    ),
  },
  {
    id: "kimi-platform-api",
    regionAvailability: { kind: "fixed", regions: ["international"] },
    billingPolicy: expectedBillingPolicy("kimi-platform-api", "metered_api"),
  },
  {
    id: "kimi-code",
    regionAvailability: { kind: "fixed", regions: ["international"] },
    billingPolicy: expectedBillingPolicy(
      "kimi-code",
      "included_subscription",
    ),
  },
  {
    id: "minimax-api",
    regionAvailability: { kind: "fixed", regions: ["international"] },
    billingPolicy: expectedBillingPolicy("minimax-api", "metered_api"),
  },
  {
    id: "minimax-token-plan",
    regionAvailability: { kind: "fixed", regions: ["international"] },
    billingPolicy: expectedBillingPolicy(
      "minimax-token-plan",
      "included_subscription",
      {
        possibleAdditionalSources: ["prepaid_credits"],
        providerFallback: "automatic",
        availableSelections: ["allow_declared_additional"],
      },
    ),
  },
  {
    id: "zai-api",
    regionAvailability: { kind: "fixed", regions: ["international"] },
    billingPolicy: expectedBillingPolicy("zai-api", "metered_api"),
  },
  {
    id: "zai-glm-coding-plan",
    regionAvailability: { kind: "fixed", regions: ["international"] },
    billingPolicy: expectedBillingPolicy(
      "zai-glm-coding-plan",
      "included_subscription",
    ),
  },
  {
    id: "deepseek-api",
    regionAvailability: { kind: "global" },
    billingPolicy: expectedBillingPolicy("deepseek-api", "metered_api"),
  },
  {
    id: "aws-bedrock",
    regionAvailability: { kind: "provider_catalog", catalog: "aws" },
    billingPolicy: expectedBillingPolicy("aws-bedrock", "cloud_account"),
  },
  {
    id: "google-gemini-api",
    regionAvailability: { kind: "global" },
    billingPolicy: expectedBillingPolicy("google-gemini-api", "metered_api"),
  },
  {
    id: "google-vertex-ai",
    regionAvailability: { kind: "provider_catalog", catalog: "gcp" },
    billingPolicy: expectedBillingPolicy("google-vertex-ai", "cloud_account"),
  },
  {
    id: "azure-openai",
    regionAvailability: { kind: "provider_catalog", catalog: "azure" },
    billingPolicy: expectedBillingPolicy("azure-openai", "cloud_account"),
  },
  {
    id: "ollama-local",
    regionAvailability: { kind: "local" },
    billingPolicy: expectedBillingPolicy("ollama-local", "local_compute"),
  },
  {
    id: "lm-studio-local",
    regionAvailability: { kind: "local" },
    billingPolicy: expectedBillingPolicy("lm-studio-local", "local_compute"),
  },
] as const;

const CANONICAL_MATRIX = [
  {
    id: "openai-api",
    adapterKind: "model_provider",
    accessKind: "api",
    protocol: "openai_responses",
    endpoints: [{ kind: "origin", value: "https://api.openai.com/v1" }],
    supportStatus: "supported",
  },
  {
    id: "openai-codex-chatgpt",
    adapterKind: "agent_runtime",
    accessKind: "subscription",
    protocol: "acp",
    endpoints: [],
    supportStatus: "conditional",
  },
  {
    id: "anthropic-api",
    adapterKind: "model_provider",
    accessKind: "api",
    protocol: "anthropic_messages",
    endpoints: [{ kind: "origin", value: "https://api.anthropic.com/v1" }],
    supportStatus: "supported",
  },
  {
    id: "anthropic-claude-subscription",
    adapterKind: "agent_runtime",
    accessKind: "subscription",
    protocol: "sdk",
    endpoints: [],
    supportStatus: "blocked",
  },
  {
    id: "github-copilot-subscription",
    adapterKind: "agent_runtime",
    accessKind: "subscription",
    protocol: "sdk",
    endpoints: [],
    supportStatus: "conditional",
  },
  {
    id: "openrouter-api",
    adapterKind: "model_provider",
    accessKind: "api",
    protocol: "openai_chat",
    endpoints: [{ kind: "origin", value: "https://openrouter.ai/api/v1" }],
    supportStatus: "supported",
  },
  {
    id: "opencode-zen",
    adapterKind: "model_provider",
    accessKind: "api",
    protocol: "openai_responses",
    endpoints: [{ kind: "origin", value: "https://opencode.ai/zen/v1" }],
    supportStatus: "supported",
  },
  {
    id: "opencode-go",
    adapterKind: "model_provider",
    accessKind: "subscription",
    protocol: "openai_chat",
    endpoints: [{ kind: "origin", value: "https://opencode.ai/zen/go/v1" }],
    supportStatus: "supported",
  },
  {
    id: "kilo-gateway",
    adapterKind: "model_provider",
    accessKind: "api",
    protocol: "openai_chat",
    endpoints: [{ kind: "origin", value: "https://api.kilo.ai/api/gateway" }],
    supportStatus: "supported",
  },
  {
    id: "nous-portal",
    adapterKind: "model_provider",
    accessKind: "subscription",
    protocol: "openai_chat",
    endpoints: [],
    supportStatus: "conditional",
  },
  {
    id: "alibaba-model-studio-api",
    adapterKind: "model_provider",
    accessKind: "api",
    protocol: "openai_chat",
    endpoints: [
      {
        kind: "origin",
        value: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      },
    ],
    supportStatus: "supported",
  },
  {
    id: "alibaba-coding-plan",
    adapterKind: "model_provider",
    accessKind: "coding_plan",
    protocol: "openai_chat",
    endpoints: [
      {
        kind: "origin",
        value: "https://coding-intl.dashscope.aliyuncs.com/v1",
      },
      {
        kind: "origin",
        value: "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic",
      },
    ],
    supportStatus: "conditional",
  },
  {
    id: "kimi-platform-api",
    adapterKind: "model_provider",
    accessKind: "api",
    protocol: "openai_chat",
    endpoints: [{ kind: "origin", value: "https://api.moonshot.ai/v1" }],
    supportStatus: "supported",
  },
  {
    id: "kimi-code",
    adapterKind: "model_provider",
    accessKind: "coding_plan",
    protocol: "openai_chat",
    endpoints: [
      { kind: "origin", value: "https://api.kimi.com/coding/v1" },
      { kind: "origin", value: "https://api.kimi.com/coding/" },
    ],
    supportStatus: "supported",
  },
  {
    id: "minimax-api",
    adapterKind: "model_provider",
    accessKind: "api",
    protocol: "openai_chat",
    endpoints: [
      { kind: "origin", value: "https://api.minimax.io/v1" },
      { kind: "origin", value: "https://api.minimax.io/anthropic" },
    ],
    supportStatus: "supported",
  },
  {
    id: "minimax-token-plan",
    adapterKind: "model_provider",
    accessKind: "coding_plan",
    protocol: "anthropic_messages",
    endpoints: [
      { kind: "origin", value: "https://api.minimax.io/v1" },
      { kind: "origin", value: "https://api.minimax.io/anthropic" },
    ],
    supportStatus: "conditional",
  },
  {
    id: "zai-api",
    adapterKind: "model_provider",
    accessKind: "api",
    protocol: "openai_chat",
    endpoints: [{ kind: "origin", value: "https://api.z.ai/api/paas/v4" }],
    supportStatus: "supported",
  },
  {
    id: "zai-glm-coding-plan",
    adapterKind: "model_provider",
    accessKind: "coding_plan",
    protocol: "openai_chat",
    endpoints: [
      { kind: "origin", value: "https://api.z.ai/api/coding/paas/v4" },
      { kind: "origin", value: "https://api.z.ai/api/anthropic" },
    ],
    supportStatus: "blocked_pending_written_approval",
  },
  {
    id: "deepseek-api",
    adapterKind: "model_provider",
    accessKind: "api",
    protocol: "openai_chat",
    endpoints: [
      { kind: "origin", value: "https://api.deepseek.com" },
      { kind: "origin", value: "https://api.deepseek.com/anthropic" },
    ],
    supportStatus: "supported",
  },
  {
    id: "aws-bedrock",
    adapterKind: "model_provider",
    accessKind: "cloud_identity",
    protocol: "bedrock",
    endpoints: [
      {
        kind: "template",
        value: "https://bedrock-mantle.{region}.api.aws/v1",
      },
    ],
    supportStatus: "supported",
  },
  {
    id: "google-gemini-api",
    adapterKind: "model_provider",
    accessKind: "api",
    protocol: "gemini_generate_content",
    endpoints: [
      {
        kind: "origin",
        value: "https://generativelanguage.googleapis.com/v1beta",
      },
    ],
    supportStatus: "supported",
  },
  {
    id: "google-vertex-ai",
    adapterKind: "model_provider",
    accessKind: "cloud_identity",
    protocol: "gemini_generate_content",
    endpoints: [
      { kind: "origin", value: "https://aiplatform.googleapis.com/v1" },
    ],
    supportStatus: "supported",
  },
  {
    id: "azure-openai",
    adapterKind: "model_provider",
    accessKind: "cloud_identity",
    protocol: "azure_openai",
    endpoints: [
      {
        kind: "template",
        value: "https://{resource}.openai.azure.com/openai/v1",
      },
    ],
    supportStatus: "supported",
  },
  {
    id: "ollama-local",
    adapterKind: "model_provider",
    accessKind: "local",
    protocol: "local_openai",
    endpoints: [{ kind: "origin", value: "http://127.0.0.1:11434/v1" }],
    supportStatus: "supported",
  },
  {
    id: "lm-studio-local",
    adapterKind: "model_provider",
    accessKind: "local",
    protocol: "local_openai",
    endpoints: [{ kind: "origin", value: "http://127.0.0.1:1234/v1" }],
    supportStatus: "supported",
  },
] as const;

function cloneManifest(manifest: ProviderManifest): Record<string, unknown> {
  return structuredClone(manifest) as unknown as Record<string, unknown>;
}

function cloneManifestWithExpectedMetadata(
  manifest: ProviderManifest,
): Record<string, unknown> {
  const clone = cloneManifest(manifest);
  const expected = REGION_AND_BILLING_MATRIX.find(
    (candidate) => candidate.id === manifest.id,
  );
  expect(expected, `missing region/billing fixture ${manifest.id}`).toBeDefined();
  clone["regionAvailability"] = structuredClone(expected!.regionAvailability);
  clone["billingPolicy"] = structuredClone(expected!.billingPolicy);
  return clone;
}

function bundled(id: string): ProviderManifest {
  const manifest = BUNDLED_PROVIDER_MANIFESTS.find((candidate) => candidate.id === id);
  expect(manifest, `missing bundled manifest ${id}`).toBeDefined();
  return manifest as ProviderManifest;
}

describe("bundled provider manifests", () => {
  it("contains every canonical path once with its exact lane, protocol, endpoints, and status", () => {
    expect(BUNDLED_PROVIDER_MANIFESTS.map((manifest) => ({
      id: manifest.id,
      adapterKind: manifest.adapterKind,
      accessKind: manifest.accessKind,
      protocol: manifest.protocol,
      endpoints: manifest.endpoints,
      supportStatus: manifest.supportStatus,
    }))).toEqual(CANONICAL_MATRIX);

    const ids = BUNDLED_PROVIDER_MANIFESTS.map((manifest) => manifest.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares the exact region availability and billing policy for all 25 paths", () => {
    expect(BUNDLED_PROVIDER_MANIFESTS.map((manifest) => ({
      id: manifest.id,
      regionAvailability: manifest.regionAvailability,
      billingPolicy: manifest.billingPolicy,
    }))).toEqual(REGION_AND_BILLING_MATRIX);
  });

  it("offers MiniMax automatic fallback only through explicit additional billing", () => {
    const minimax = bundled("minimax-token-plan");
    expect(minimax.billingPolicy.providerFallback).toBe("automatic");
    expect(minimax.billingPolicy.availableSelections).toEqual([
      "allow_declared_additional",
    ]);
    expect(minimax.usagePolicy.rules).toHaveLength(1);
    expect(minimax.usagePolicy.rules[0]?.when).toEqual({});
    expect(minimax.usagePolicy.rules[0]?.condition).toEqual({
      type: "billing_selection",
      allowedModes: ["allow_declared_additional"],
    });
  });

  it("uses only legal credential-owner, lane, access, and auth combinations", () => {
    for (const manifest of BUNDLED_PROVIDER_MANIFESTS) {
      if (manifest.adapterKind === "agent_runtime") {
        expect(manifest.accessKind).toBe("subscription");
        expect(manifest.authKinds).toEqual(["official_runtime"]);
        expect(manifest.credentialOwner).toBe("vendor_runtime");
      } else if (manifest.accessKind === "local") {
        expect(manifest.authKinds).toEqual(["local_endpoint"]);
        expect(manifest.credentialOwner).toBe("none");
      } else {
        expect(manifest.credentialOwner).toBe("recurs_broker");
        if (manifest.accessKind === "coding_plan") {
          expect(manifest.authKinds).toEqual(["coding_plan_key"]);
        } else if (manifest.accessKind === "cloud_identity") {
          expect(manifest.authKinds).toEqual(["cloud_identity"]);
        } else if (manifest.id === "openrouter-api") {
          expect(manifest.authKinds).toEqual(["api_key", "oauth_pkce"]);
        } else {
          expect(manifest.authKinds).toEqual(["api_key"]);
        }
      }

      expect(() => validateProviderManifest(manifest)).not.toThrow();
    }
  });

  it("ships current, sourced policy evidence and typed conditional gates", () => {
    for (const manifest of BUNDLED_PROVIDER_MANIFESTS) {
      expect(manifest.usagePolicy.reviewedAt).toBe(REVIEWED_AT);
      expect(manifest.usagePolicy.expiresAt).toBe(EXPIRES_AT);
      expect(manifest.usagePolicy.revision.trim()).not.toBe("");
      expect(manifest.usagePolicy.evidenceSummary.trim()).not.toBe("");
      expect(manifest.usagePolicy.sourceUrls.length).toBeGreaterThan(0);
      for (const sourceUrl of manifest.usagePolicy.sourceUrls) {
        expect(new URL(sourceUrl).protocol).toBe("https:");
      }

      if (manifest.supportStatus === "conditional") {
        expect(manifest.usagePolicy.rules.some(
          (rule) => rule.decision === "conditional" && rule.condition !== undefined,
        )).toBe(true);
      }
    }
  });

  it("allows missing endpoints only for conditional or blocked paths with evidence", () => {
    const withoutEndpoints = BUNDLED_PROVIDER_MANIFESTS.filter(
      (manifest) => manifest.endpoints.length === 0,
    );

    expect(withoutEndpoints.map((manifest) => manifest.id)).toEqual([
      "openai-codex-chatgpt",
      "anthropic-claude-subscription",
      "github-copilot-subscription",
      "nous-portal",
    ]);
    for (const manifest of withoutEndpoints) {
      expect([
        "conditional",
        "blocked_pending_written_approval",
        "blocked",
      ]).toContain(manifest.supportStatus);
      expect(manifest.endpointEvidence?.trim()).not.toBe("");
    }
  });

  it("contains neither secret-bearing fields nor live-looking credentials", () => {
    const serialized = JSON.stringify(BUNDLED_PROVIDER_MANIFESTS);
    expect(serialized).not.toMatch(
      /"(?:apiKey|accessToken|refreshToken|credentialRef|clientSecret|privateKey)"/i,
    );
    expect(serialized).not.toMatch(/\b(?:sk|key|token)-[A-Za-z0-9_-]{16,}\b/);
    expect(serialized).not.toContain("/.codex/auth.json");
  });
});

describe("validateProviderManifest", () => {
  it("rejects unknown fields at every manifest layer", () => {
    const topLevel = cloneManifest(bundled("ollama-local"));
    topLevel["apiKey"] = "not-a-real-secret";
    expect(() => validateProviderManifest(topLevel)).toThrow(/unknown field.*apiKey/i);

    const endpoint = cloneManifest(bundled("ollama-local"));
    const endpoints = endpoint["endpoints"] as Array<Record<string, unknown>>;
    endpoints[0]!["headers"] = {};
    expect(() => validateProviderManifest(endpoint)).toThrow(/unknown field.*headers/i);

    const policy = cloneManifest(bundled("openai-codex-chatgpt"));
    const usagePolicy = policy["usagePolicy"] as Record<string, unknown>;
    usagePolicy["warningOnly"] = true;
    expect(() => validateProviderManifest(policy)).toThrow(/unknown field.*warningOnly/i);

    const rules = usagePolicy["rules"] as Array<Record<string, unknown>>;
    const condition = rules.find((rule) => rule["condition"] !== undefined)?.[
      "condition"
    ] as Record<string, unknown>;
    delete usagePolicy["warningOnly"];
    condition["userCanOverride"] = true;
    expect(() => validateProviderManifest(policy)).toThrow(/unknown field.*userCanOverride/i);
  });

  it("strictly validates region availability and billing-policy fields and types", () => {
    const regionUnknown = cloneManifestWithExpectedMetadata(bundled("openai-api"));
    const region = regionUnknown["regionAvailability"] as Record<string, unknown>;
    region["fallbackRegion"] = "us";
    expect(() => validateProviderManifest(regionUnknown)).toThrow(
      /region availability.*unknown field.*fallbackRegion/i,
    );

    const emptyFixedRegions = cloneManifestWithExpectedMetadata(
      bundled("alibaba-coding-plan"),
    );
    const fixedRegion = emptyFixedRegions["regionAvailability"] as Record<
      string,
      unknown
    >;
    fixedRegion["regions"] = [];
    expect(() => validateProviderManifest(emptyFixedRegions)).toThrow(
      /fixed regions.*nonempty/i,
    );

    const billingUnknown = cloneManifestWithExpectedMetadata(bundled("openai-api"));
    const billing = billingUnknown["billingPolicy"] as Record<string, unknown>;
    billing["warningOnly"] = true;
    expect(() => validateProviderManifest(billingUnknown)).toThrow(
      /billing policy.*unknown field.*warningOnly/i,
    );

    const billingWrongType = cloneManifestWithExpectedMetadata(bundled("openai-api"));
    const wrongType = billingWrongType["billingPolicy"] as Record<string, unknown>;
    wrongType["possibleAdditionalSources"] = "prepaid_credits";
    expect(() => validateProviderManifest(billingWrongType)).toThrow(
      /possible additional sources.*array/i,
    );

    const emptyDisclosure = cloneManifestWithExpectedMetadata(bundled("openai-api"));
    const disclosure = emptyDisclosure["billingPolicy"] as Record<string, unknown>;
    disclosure["disclosureRevision"] = "";
    expect(() => validateProviderManifest(emptyDisclosure)).toThrow(
      /billing policy disclosure revision.*nonempty/i,
    );
  });

  it("binds cloud region catalogs to their protocol families", () => {
    const bedrock = cloneManifestWithExpectedMetadata(bundled("aws-bedrock"));
    const bedrockRegion = bedrock["regionAvailability"] as Record<string, unknown>;
    bedrockRegion["catalog"] = "azure";
    expect(() => validateProviderManifest(bedrock)).toThrow(
      /bedrock.*AWS region catalog/i,
    );

    const vertex = cloneManifestWithExpectedMetadata(bundled("google-vertex-ai"));
    const vertexRegion = vertex["regionAvailability"] as Record<string, unknown>;
    vertexRegion["catalog"] = "aws";
    expect(() => validateProviderManifest(vertex)).toThrow(
      /Gemini.*GCP region catalog/i,
    );

    const azure = cloneManifestWithExpectedMetadata(bundled("azure-openai"));
    const azureRegion = azure["regionAvailability"] as Record<string, unknown>;
    azureRegion["catalog"] = "gcp";
    expect(() => validateProviderManifest(azure)).toThrow(
      /Azure OpenAI.*Azure region catalog/i,
    );
  });

  it("binds primary billing sources to access lanes", () => {
    const local = cloneManifestWithExpectedMetadata(bundled("ollama-local"));
    const localBilling = local["billingPolicy"] as Record<string, unknown>;
    localBilling["primarySource"] = "metered_api";
    expect(() => validateProviderManifest(local)).toThrow(/local-compute billing/i);

    const codingPlan = cloneManifestWithExpectedMetadata(
      bundled("alibaba-coding-plan"),
    );
    const codingBilling = codingPlan["billingPolicy"] as Record<string, unknown>;
    codingBilling["primarySource"] = "metered_api";
    expect(() => validateProviderManifest(codingPlan)).toThrow(
      /coding-plan.*included-subscription billing/i,
    );

    const cloud = cloneManifestWithExpectedMetadata(bundled("aws-bedrock"));
    const cloudBilling = cloud["billingPolicy"] as Record<string, unknown>;
    cloudBilling["primarySource"] = "metered_api";
    expect(() => validateProviderManifest(cloud)).toThrow(/cloud-account billing/i);

    const api = cloneManifestWithExpectedMetadata(bundled("openai-api"));
    const apiBilling = api["billingPolicy"] as Record<string, unknown>;
    apiBilling["primarySource"] = "included_subscription";
    expect(() => validateProviderManifest(api)).toThrow(
      /metered-API or prepaid-credit billing/i,
    );
  });

  it("rejects impossible calendar review dates", () => {
    const invalidDate = cloneManifestWithExpectedMetadata(bundled("openai-api"));
    const policy = invalidDate["usagePolicy"] as Record<string, unknown>;
    policy["reviewedAt"] = "2026-02-30";

    expect(() => validateProviderManifest(invalidDate)).toThrow(
      /review date.*real calendar date/i,
    );
  });

  it("requires conditional manifests to default to denied", () => {
    const conditional = cloneManifestWithExpectedMetadata(
      bundled("openai-codex-chatgpt"),
    );
    const policy = conditional["usagePolicy"] as Record<string, unknown>;
    policy["defaultDecision"] = "allowed";

    expect(() => validateProviderManifest(conditional)).toThrow(
      /conditional provider manifests must default to denied/i,
    );
  });

  it("keeps unknown provider fallback non-runnable and default-denied", () => {
    const defaultAllowed = cloneManifestWithExpectedMetadata(bundled("openai-api"));
    const defaultAllowedBilling = defaultAllowed["billingPolicy"] as Record<
      string,
      unknown
    >;
    defaultAllowedBilling["providerFallback"] = "unknown";
    defaultAllowedBilling["availableSelections"] = [];
    expect(() => validateProviderManifest(defaultAllowed)).toThrow(
      /unknown provider fallback.*default to denied/i,
    );

    const runnable = cloneManifestWithExpectedMetadata(bundled("ollama-local"));
    const runnableBilling = runnable["billingPolicy"] as Record<string, unknown>;
    runnableBilling["providerFallback"] = "unknown";
    runnableBilling["availableSelections"] = [];
    const runnablePolicy = runnable["usagePolicy"] as Record<string, unknown>;
    runnablePolicy["defaultDecision"] = "denied";
    expect(() => validateProviderManifest(runnable)).toThrow(
      /unknown provider fallback.*cannot be runnable/i,
    );
  });

  it("makes unknown provider fallback unselectable", () => {
    const unknown = cloneManifestWithExpectedMetadata(bundled("openai-api"));
    const billing = unknown["billingPolicy"] as Record<string, unknown>;
    billing["providerFallback"] = "unknown";
    const policy = unknown["usagePolicy"] as Record<string, unknown>;
    policy["defaultDecision"] = "denied";

    expect(() => validateProviderManifest(unknown)).toThrow(
      /unknown provider fallback.*available selections/i,
    );
  });

  it("rejects fallback without declared additional billing sources", () => {
    const undeclared = cloneManifestWithExpectedMetadata(bundled("openai-api"));
    const billing = undeclared["billingPolicy"] as Record<string, unknown>;
    billing["providerFallback"] = "automatic";
    billing["availableSelections"] = ["allow_declared_additional"];
    const policy = undeclared["usagePolicy"] as Record<string, unknown>;
    policy["defaultDecision"] = "denied";

    expect(() => validateProviderManifest(undeclared)).toThrow(
      /fallback.*declared additional billing source/i,
    );
  });

  it("rejects additional billing sources without matching fallback and selection", () => {
    const noFallback = cloneManifestWithExpectedMetadata(bundled("openai-api"));
    const noFallbackBilling = noFallback["billingPolicy"] as Record<
      string,
      unknown
    >;
    noFallbackBilling["possibleAdditionalSources"] = ["prepaid_credits"];
    noFallbackBilling["availableSelections"] = [
      "strict_primary_only",
      "allow_declared_additional",
    ];
    expect(() => validateProviderManifest(noFallback)).toThrow(
      /additional billing sources.*provider fallback/i,
    );

    const noSelection = cloneManifestWithExpectedMetadata(bundled("opencode-go"));
    const noSelectionBilling = noSelection["billingPolicy"] as Record<
      string,
      unknown
    >;
    noSelectionBilling["availableSelections"] = ["strict_primary_only"];
    expect(() => validateProviderManifest(noSelection)).toThrow(
      /additional billing sources.*allow_declared_additional/i,
    );
  });

  it("requires automatic additional billing fallback to be gated by denied-by-default policy", () => {
    const automatic = cloneManifestWithExpectedMetadata(bundled("opencode-go"));
    const billing = automatic["billingPolicy"] as Record<string, unknown>;
    billing["providerFallback"] = "automatic";
    billing["availableSelections"] = ["allow_declared_additional"];

    expect(() => validateProviderManifest(automatic)).toThrow(
      /automatic billing fallback.*default to denied/i,
    );
  });

  it("rejects strict-primary selection for automatic fallback without enforceable proof", () => {
    const automatic = cloneManifestWithExpectedMetadata(
      bundled("minimax-token-plan"),
    );
    const billing = automatic["billingPolicy"] as Record<string, unknown>;
    billing["availableSelections"] = [
      "strict_primary_only",
      "allow_declared_additional",
    ];

    expect(() => validateProviderManifest(automatic)).toThrow(
      /automatic.*strict_primary_only.*enforceable proof/i,
    );
  });

  it("rejects a context-specific billing gate that does not cover another allowing rule", () => {
    for (const decision of ["allowed", "conditional"] as const) {
      const candidate = cloneManifestWithExpectedMetadata(
        bundled("minimax-token-plan"),
      );
      const policy = candidate["usagePolicy"] as Record<string, unknown>;
      policy["rules"] = [
        {
          when: { embedding: "ci" },
          decision: "conditional",
          condition: {
            type: "billing_selection",
            allowedModes: ["allow_declared_additional"],
          },
          reason: "CI requires explicit additional billing selection.",
        },
        {
          when: { embedding: "cli" },
          decision,
          ...(decision === "conditional"
            ? {
                condition: {
                  type: "entitlement_claim",
                  claimId: "minimax.token_plan.active",
                  allowedValues: [true],
                },
              }
            : {}),
          reason: "CLI can potentially allow Token Plan work.",
        },
      ];

      expect(() => validateProviderManifest(candidate)).toThrow(
        /automatic billing fallback.*every potentially allowing context.*billing-selection gate/i,
      );
    }
  });

  it("accepts a broader billing gate nested in an all condition", () => {
    const candidate = cloneManifestWithExpectedMetadata(
      bundled("minimax-token-plan"),
    );
    const policy = candidate["usagePolicy"] as Record<string, unknown>;
    policy["rules"] = [
      {
        when: {},
        decision: "conditional",
        condition: {
          type: "all",
          conditions: [
            {
              type: "entitlement_claim",
              claimId: "minimax.token_plan.active",
              allowedValues: [true],
            },
            {
              type: "all",
              conditions: [
                {
                  type: "billing_selection",
                  allowedModes: ["allow_declared_additional"],
                },
              ],
            },
          ],
        },
        reason: "All contexts require entitlement and explicit additional billing.",
      },
      {
        when: { embedding: "cli" },
        decision: "allowed",
        reason: "CLI is allowed only through the broader intersecting gate.",
      },
    ];

    expect(() => validateProviderManifest(candidate)).not.toThrow();
  });

  it("limits billing-selection conditions to selections declared by billing policy", () => {
    const mismatch = cloneManifestWithExpectedMetadata(
      bundled("minimax-token-plan"),
    );
    const policy = mismatch["usagePolicy"] as Record<string, unknown>;
    const rules = policy["rules"] as Array<Record<string, unknown>>;
    const condition = rules[0]!["condition"] as Record<string, unknown>;
    condition["allowedModes"] = ["provider_default"];

    expect(() => validateProviderManifest(mismatch)).toThrow(
      /billing-selection condition.*billing policy/i,
    );
  });

  it("rejects illegal lane ownership and conditional prose without a machine condition", () => {
    const delegated = cloneManifest(bundled("openai-codex-chatgpt"));
    delegated["credentialOwner"] = "recurs_broker";
    expect(() => validateProviderManifest(delegated)).toThrow(/credential owner/i);

    const direct = cloneManifest(bundled("openai-api"));
    direct["credentialOwner"] = "vendor_runtime";
    expect(() => validateProviderManifest(direct)).toThrow(/credential owner/i);

    const conditional = cloneManifest(bundled("minimax-token-plan"));
    const policy = conditional["usagePolicy"] as Record<string, unknown>;
    const rules = policy["rules"] as Array<Record<string, unknown>>;
    const conditionalRule = rules.find((rule) => rule["decision"] === "conditional");
    expect(conditionalRule).toBeDefined();
    delete conditionalRule?.["condition"];
    expect(() => validateProviderManifest(conditional)).toThrow(/machine.*condition/i);
  });

  it("rejects HTTP endpoints on delegated runtime manifests", () => {
    const delegated = cloneManifest(bundled("openai-codex-chatgpt"));
    delegated["endpoints"] = [
      { kind: "origin", value: "https://runtime.example.com/v1" },
    ];

    expect(() => validateProviderManifest(delegated)).toThrow(
      /delegated runtime.*HTTP endpoint/i,
    );
  });

  it("keeps broker-owned credential paths unavailable until the native broker exists", () => {
    const direct = cloneManifest(bundled("openai-api"));
    direct["runnable"] = true;

    expect(() => validateProviderManifest(direct)).toThrow(/native credential broker/i);
  });

  it("distinguishes concrete origins from cloud templates and fails closed on empty endpoints", () => {
    const originTemplate = cloneManifest(bundled("openai-api"));
    const originEndpoints = originTemplate["endpoints"] as Array<Record<string, unknown>>;
    originEndpoints[0]!["value"] = "https://{account}.example.com/v1";
    expect(() => validateProviderManifest(originTemplate)).toThrow(/concrete origin/i);

    const concreteTemplate = cloneManifest(bundled("aws-bedrock"));
    const templateEndpoints = concreteTemplate["endpoints"] as Array<Record<string, unknown>>;
    templateEndpoints[0]!["value"] = "https://bedrock.example.com/v1";
    expect(() => validateProviderManifest(concreteTemplate)).toThrow(/template.*placeholder/i);

    const emptySupported = cloneManifest(bundled("openai-api"));
    emptySupported["endpoints"] = [];
    emptySupported["endpointEvidence"] = "Missing for now";
    expect(() => validateProviderManifest(emptySupported)).toThrow(/empty endpoints/i);

    const emptyWithoutEvidence = cloneManifest(bundled("nous-portal"));
    delete emptyWithoutEvidence["endpointEvidence"];
    expect(() => validateProviderManifest(emptyWithoutEvidence)).toThrow(/endpoint evidence/i);
  });
});

describe("ProviderManifestRegistry", () => {
  it("hides blocked paths by default and reveals them explicitly", () => {
    const registry = new ProviderManifestRegistry();

    expect(registry.list().map((manifest) => manifest.id)).not.toContain(
      "anthropic-claude-subscription",
    );
    expect(registry.list().map((manifest) => manifest.id)).not.toContain(
      "zai-glm-coding-plan",
    );
    expect(registry.list({ includeBlocked: true }).map((manifest) => manifest.id))
      .toEqual(CANONICAL_MATRIX.map((entry) => entry.id));
  });

  it("reports only implemented local and official Codex paths as runnable", () => {
    const registry = new ProviderManifestRegistry();

    expect(registry.runnable().map((manifest) => manifest.id)).toEqual([
      "openai-codex-chatgpt",
      "ollama-local",
      "lm-studio-local",
    ]);
  });

  it("returns deeply immutable defensive copies", () => {
    const registry = new ProviderManifestRegistry();
    const first = registry.get("openai-api");
    const second = registry.get("openai-api");

    expect(first).toBeDefined();
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.endpoints)).toBe(true);
    expect(Object.isFrozen(first?.endpoints[0])).toBe(true);
    expect(Object.isFrozen(first?.regionAvailability)).toBe(true);
    expect(Object.isFrozen(first?.billingPolicy)).toBe(true);
    expect(Object.isFrozen(first?.billingPolicy.possibleAdditionalSources)).toBe(true);
    expect(Object.isFrozen(first?.billingPolicy.availableSelections)).toBe(true);
    expect(Object.isFrozen(first?.usagePolicy)).toBe(true);
    expect(Object.isFrozen(first?.usagePolicy.rules)).toBe(true);
    expect(() => {
      (first as { displayName: string }).displayName = "tampered";
    }).toThrow();
    expect(registry.get("openai-api")?.displayName).toBe("OpenAI API");

    const firstList = registry.list({ includeBlocked: true });
    const secondList = registry.list({ includeBlocked: true });
    expect(firstList).not.toBe(secondList);
    expect(Object.isFrozen(firstList)).toBe(true);
  });

  it("validates custom entries and rejects duplicate IDs", () => {
    const manifest = bundled("ollama-local");
    expect(() => new ProviderManifestRegistry([manifest, manifest])).toThrow(
      /duplicate provider manifest id/i,
    );

    const invalid = cloneManifest(manifest);
    invalid["unknown"] = true;
    expect(() => new ProviderManifestRegistry([invalid as never])).toThrow(
      /unknown field.*unknown/i,
    );
  });
});
