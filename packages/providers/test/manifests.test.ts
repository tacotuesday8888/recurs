import { describe, expect, it } from "vitest";

import type { ProviderManifest } from "@recurs/contracts";

import {
  BUNDLED_PROVIDER_MANIFESTS,
  ProviderManifestRegistry,
  validateProviderManifest,
} from "../src/index.js";

const REVIEWED_AT = "2026-07-11";
const EXPIRES_AT = "2026-10-11T00:00:00.000Z";

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
