import { describe, expect, it } from "vitest";

import { BUNDLED_PROVIDER_MANIFESTS } from "@recurs/providers";

import {
  createProviderPolicyBinding,
  providerUsagePolicyAllows,
  requiredProviderPolicyClaimIds,
} from "../src/index.js";

const INTERACTIVE = Object.freeze({
  invocation: "repl" as const,
  presence: "present" as const,
  location: "local" as const,
  automation: "manual" as const,
  embedding: "cli" as const,
});

function manifest(id: string) {
  const value = BUNDLED_PROVIDER_MANIFESTS.find((entry) => entry.id === id);
  if (value === undefined) throw new Error(`missing ${id}`);
  return value;
}

describe("provider usage policy bindings", () => {
  it("requires the exact Alibaba entitlement and foreground CLI context", () => {
    const alibaba = manifest("alibaba-coding-plan");
    expect(requiredProviderPolicyClaimIds(alibaba.usagePolicy)).toEqual([
      "alibaba.coding_plan_active",
    ]);
    expect(() => createProviderPolicyBinding(
      alibaba,
      [],
      "strict_primary_only",
      INTERACTIVE,
      "2026-08-04T12:00:00.000Z",
    )).toThrow("incomplete");
    const binding = createProviderPolicyBinding(
      alibaba,
      [{ id: "alibaba.coding_plan_active", value: true }],
      "strict_primary_only",
      INTERACTIVE,
      "2026-08-04T12:00:00.000Z",
    );
    expect(binding).toBeDefined();
    expect(providerUsagePolicyAllows(
      alibaba.usagePolicy,
      binding,
      "strict_primary_only",
      INTERACTIVE,
    )).toBe(true);
    expect(providerUsagePolicyAllows(
      alibaba.usagePolicy,
      binding,
      "strict_primary_only",
      { ...INTERACTIVE, automation: "scripted" },
    )).toBe(false);
  });

  it("requires MiniMax additional-credit acknowledgement without inventing an entitlement", () => {
    const minimax = manifest("minimax-token-plan");
    expect(() => createProviderPolicyBinding(
      minimax,
      [],
      "strict_primary_only",
      INTERACTIVE,
      "2026-08-04T12:00:00.000Z",
    )).toThrow("not satisfied");
    const binding = createProviderPolicyBinding(
      minimax,
      [],
      "allow_declared_additional",
      INTERACTIVE,
      "2026-08-04T12:00:00.000Z",
    );
    expect(binding).toEqual({
      schemaVersion: 1,
      claims: [],
      acknowledgedAt: "2026-08-04T12:00:00.000Z",
    });
  });

  it("does not permit claims on an unconditional provider", () => {
    expect(() => createProviderPolicyBinding(
      manifest("openai-api"),
      [{ id: "invented", value: true }],
      "strict_primary_only",
      INTERACTIVE,
      "2026-08-04T12:00:00.000Z",
    )).toThrow("not expected");
  });
});
