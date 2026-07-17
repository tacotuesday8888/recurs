import { describe, expect, it } from "vitest";

import {
  DEFAULT_OPERATING_MODE_ID,
  getOperatingModePolicy,
  narrowAgentPermissionMode,
  operatingModePolicies,
  parseOperatingModeId,
} from "../src/index.js";

describe("agent operating-mode contracts", () => {
  it("uses stable non-display identifiers for the five initial policies", () => {
    expect(operatingModePolicies.map((policy) => policy.id)).toEqual([
      "economy_v1",
      "standard_v1",
      "balanced_v1",
      "performance_v1",
      "max_v1",
    ]);
    expect(operatingModePolicies.map((policy) => policy.displayName)).toEqual([
      "Economy",
      "Standard",
      "Balanced",
      "Performance",
      "Max",
    ]);
    expect(operatingModePolicies.every((policy) => policy.version === 1)).toBe(true);
  });

  it("defaults to Balanced without coupling storage to the display label", () => {
    expect(DEFAULT_OPERATING_MODE_ID).toBe("balanced_v1");
    expect(getOperatingModePolicy(DEFAULT_OPERATING_MODE_ID).displayName).toBe("Balanced");
  });

  it("parses exact supported names and stable ids without prefix matching", () => {
    expect(parseOperatingModeId("economy")).toBe("economy_v1");
    expect(parseOperatingModeId("Performance")).toBe("performance_v1");
    expect(parseOperatingModeId("max_v1")).toBe("max_v1");
    expect(parseOperatingModeId("bal")).toBeNull();
    expect(parseOperatingModeId("max extra")).toBeNull();
  });

  it("keeps every initial mode bounded and honest about model selection", () => {
    for (const policy of operatingModePolicies) {
      expect(policy.model.selection).toBe("inherit_parent");
      expect(policy.orchestration.maxDepth).toBe(1);
      expect(policy.orchestration.maxConcurrentChildren).toBe(1);
      expect(policy.orchestration.maxRetries).toBe(0);
      expect(policy.orchestration.maxRequests).toBeGreaterThan(0);
      expect(policy.orchestration.maxReportedCostUsd).toBeGreaterThan(0);
    }
  });

  it("never widens a requested child permission beyond its parent", () => {
    expect(narrowAgentPermissionMode("ask_always", "full_access")).toBe("ask_always");
    expect(narrowAgentPermissionMode("approved_for_me", "full_access")).toBe("approved_for_me");
    expect(narrowAgentPermissionMode("full_access", "approved_for_me")).toBe("approved_for_me");
    expect(narrowAgentPermissionMode("full_access", "full_access")).toBe("full_access");
  });

  it("exposes frozen policy values", () => {
    const balanced = getOperatingModePolicy("balanced_v1");
    expect(Object.isFrozen(operatingModePolicies)).toBe(true);
    expect(Object.isFrozen(balanced)).toBe(true);
    expect(Object.isFrozen(balanced.orchestration)).toBe(true);
    expect(Object.isFrozen(balanced.model)).toBe(true);
  });
});
