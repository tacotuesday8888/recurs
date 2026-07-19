import type { ProviderManifest } from "@recurs/contracts";
import { readFile } from "node:fs/promises";
import {
  BUNDLED_PROVIDER_MANIFESTS,
  ProviderManifestRegistry,
} from "@recurs/providers";
import { describe, expect, it } from "vitest";

import { OnboardingCatalog } from "../src/index.js";

const FRESH = new Date("2026-07-11T12:00:00.000Z");

function catalogAt(now: Date): OnboardingCatalog {
  return new OnboardingCatalog(new ProviderManifestRegistry(), {
    now: () => now,
  });
}

describe("OnboardingCatalog", () => {
  it("derives truthful statuses for all 25 validated manifests", () => {
    const entries = catalogAt(FRESH).list({ includeBlocked: true });
    expect(entries).toHaveLength(25);
    expect(entries.map((entry) => entry.id)).toEqual([
      "openai-codex-chatgpt",
      "ollama-local",
      "lm-studio-local",
      "openai-api",
      "anthropic-api",
      "openrouter-api",
      "opencode-go",
      "kilo-gateway",
      "alibaba-model-studio-api",
      "kimi-platform-api",
      "kimi-code",
      "minimax-api",
      "zai-api",
      "deepseek-api",
      "opencode-zen",
      "alibaba-coding-plan",
      "minimax-token-plan",
      "aws-bedrock",
      "google-gemini-api",
      "google-vertex-ai",
      "azure-openai",
      "anthropic-claude-subscription",
      "github-copilot-subscription",
      "nous-portal",
      "zai-glm-coding-plan",
    ]);

    const statuses = Object.fromEntries(
      entries.map((entry) => [entry.id, entry.status]),
    );
    expect(statuses).toEqual({
      "openai-api": "runnable_byok",
      "openai-codex-chatgpt": "runnable",
      "anthropic-api": "runnable_byok",
      "anthropic-claude-subscription": "blocked",
      "github-copilot-subscription": "blocked",
      "openrouter-api": "runnable_byok",
      "opencode-zen": "requires_native_broker",
      "opencode-go": "runnable_byok",
      "kilo-gateway": "runnable_byok",
      "nous-portal": "blocked",
      "alibaba-model-studio-api": "runnable_byok",
      "alibaba-coding-plan": "requires_native_broker",
      "kimi-platform-api": "runnable_byok",
      "kimi-code": "runnable_byok",
      "minimax-api": "runnable_byok",
      "minimax-token-plan": "requires_native_broker",
      "zai-api": "runnable_byok",
      "zai-glm-coding-plan": "blocked",
      "deepseek-api": "runnable_byok",
      "aws-bedrock": "requires_native_broker",
      "google-gemini-api": "requires_native_broker",
      "google-vertex-ai": "requires_native_broker",
      "azure-openai": "requires_native_broker",
      "ollama-local": "runnable",
      "lm-studio-local": "runnable",
    });
    expect(entries.filter((entry) => entry.status === "runnable").map((entry) => entry.id)).toEqual([
      "openai-codex-chatgpt",
      "ollama-local",
      "lm-studio-local",
    ]);
  });

  it("hides blocked entries by default and preserves stable manifest ordering", () => {
    const catalog = catalogAt(FRESH);
    const visible = catalog.list();
    const all = catalog.list({ includeBlocked: true });

    expect(visible.every((entry) => entry.status !== "blocked")).toBe(true);
    expect(visible.map((entry) => entry.id)).toEqual(
      all.filter((entry) => entry.status !== "blocked").map((entry) => entry.id),
    );
    expect(visible).not.toBe(catalog.list());
    expect(Object.isFrozen(visible)).toBe(true);
    expect(Object.isFrozen(visible[0])).toBe(true);
  });

  it("fails closed at the exact policy expiry boundary", () => {
    const before = catalogAt(new Date("2026-10-10T23:59:59.999Z"))
      .list({ includeBlocked: true });
    const boundary = catalogAt(new Date("2026-10-11T00:00:00.000Z"))
      .list({ includeBlocked: true });

    expect(before.find((entry) => entry.id === "openai-codex-chatgpt")?.status)
      .toBe("runnable");
    expect(boundary.every((entry) => entry.status === "blocked")).toBe(true);
    expect(
      boundary.find((entry) => entry.id === "openai-codex-chatgpt")?.restrictions,
    ).toContain("The reviewed usage policy is expired or not yet current.");
  });

  it("blocks a broker-owned path whose usable endpoint is missing", () => {
    const nous = catalogAt(FRESH)
      .list({ includeBlocked: true })
      .find((entry) => entry.id === "nous-portal");

    expect(nous).toMatchObject({
      connectionOwner: "recurs_broker",
      endpoints: [],
      status: "blocked",
    });
  });

  it("blocks an otherwise activatable path with unknown fallback billing", () => {
    const source = BUNDLED_PROVIDER_MANIFESTS.find(
      (manifest) => manifest.id === "alibaba-coding-plan",
    );
    expect(source).toBeDefined();
    const fixture = structuredClone(source) as ProviderManifest;
    fixture.billingPolicy.providerFallback = "unknown";
    fixture.billingPolicy.availableSelections = [];
    const catalog = new OnboardingCatalog(
      new ProviderManifestRegistry([fixture]),
      { now: () => FRESH },
    );

    expect(catalog.list({ includeBlocked: true })[0]?.status).toBe("blocked");
  });

  it("projects complete structured region, billing, restriction, and policy evidence", () => {
    const entries = catalogAt(FRESH).list({ includeBlocked: true });
    for (const entry of entries) {
      expect(entry.regionAvailability).toBeDefined();
      expect(entry.connectionOwner).toMatch(
        /^(recurs_broker|vendor_runtime|process_environment|none)$/,
      );
      expect(entry.billing.revision).not.toBe("");
      expect(entry.billing.disclosureRevision).not.toBe("");
      expect(entry.billing.primarySource).not.toBe("");
      expect(entry.billing.providerFallback).not.toBe("");
      expect(entry.billing.availableSelections.length).toBeGreaterThan(0);
      expect(entry.restrictions.length).toBeGreaterThan(0);
      expect(entry.policy.revision).not.toBe("");
      expect(entry.policy.reviewedAt).toBe("2026-07-11");
      expect(entry.policy.expiresAt).toBe("2026-10-11T00:00:00.000Z");
      expect(entry.policy.sourceUrls.length).toBeGreaterThan(0);
      expect(entry.policy.evidenceSummary).not.toBe("");
    }
  });

  it("makes MiniMax additional spend and Alibaba/Codex restrictions explicit", () => {
    const entries = catalogAt(FRESH).list({ includeBlocked: true });
    const minimax = entries.find((entry) => entry.id === "minimax-token-plan");
    expect(minimax?.billing).toMatchObject({
      primarySource: "included_subscription",
      possibleAdditionalSources: ["prepaid_credits"],
      providerFallback: "automatic",
      availableSelections: ["allow_declared_additional"],
    });
    expect(minimax?.restrictions.join(" ")).toContain(
      "explicitly allow the documented prepaid-credit source",
    );

    const alibaba = entries.find((entry) => entry.id === "alibaba-coding-plan");
    expect(alibaba?.restrictions.join(" ")).toContain(
      "foreground interactive programming tools",
    );
    expect(alibaba?.policy.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        when: expect.objectContaining({
          presence: "present",
          location: "local",
          automation: "manual",
        }),
      }),
    ]));

    const codex = entries.find((entry) => entry.id === "openai-codex-chatgpt");
    expect(codex?.billing).toEqual({
      revision: "billing:openai-codex-chatgpt:2026-07-11",
      disclosureRevision:
        "billing-disclosure:openai-codex-chatgpt:2026-07-11",
      primarySource: "included_subscription",
      possibleAdditionalSources: ["prepaid_credits"],
      providerFallback: "automatic",
      availableSelections: ["allow_declared_additional"],
    });
    expect(codex?.restrictions.join(" ")).toContain("local user-present workflows");
    expect(codex?.restrictions.join(" ")).toContain(
      "plan tier is not reported by the adapter",
    );
    expect(codex?.restrictions.join(" ")).toContain(
      "explicit acceptance of possible prepaid-credit use",
    );
    expect(codex?.policy.officialRuntimeRequired).toBe(true);
    expect(codex?.policy.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        condition: expect.objectContaining({
          type: "all",
          conditions: expect.arrayContaining([
            {
              type: "entitlement_claim",
              claimId: "openai.codex.chatgpt_session_usable",
              allowedValues: [true],
            },
            {
              type: "billing_selection",
              allowedModes: ["allow_declared_additional"],
            },
          ]),
        }),
      }),
    ]));
    expect(JSON.stringify(codex)).not.toContain("chatgpt_plan_active");
  });

  it("contains no credential entry surface or secret material", () => {
    const entries = catalogAt(FRESH).list({ includeBlocked: true });
    const serialized = JSON.stringify(entries);

    expect(serialized).not.toContain("sk-proj-");
    expect(serialized).not.toContain("ghp_");
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("authKinds");
      expect(entry).not.toHaveProperty("settings");
      expect(entry).not.toHaveProperty("headers");
      expect(entry).not.toHaveProperty("environment");
      expect(entry).not.toHaveProperty("promptForCredential");
    }
  });
});

describe("application package boundary", () => {
  it("is transport-agnostic while CLI depends on app", async () => {
    const app = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const cli = JSON.parse(
      await readFile(new URL("../../cli/package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(app.dependencies).toEqual({
      "@recurs/contracts": "0.0.0",
      "@recurs/providers": "0.0.0",
    });
    expect(app.dependencies).not.toHaveProperty("@recurs/auth");
    expect(app.dependencies).not.toHaveProperty("@recurs/cli");
    expect(cli.dependencies).toHaveProperty("@recurs/app", "0.0.0");
  });
});
