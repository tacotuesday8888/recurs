import { describe, expect, it } from "vitest";

import {
  agentProfilePolicies,
  DEFAULT_OPERATING_MODE_ID,
  getAgentProfilePolicy,
  getOperatingModePolicy,
  narrowAgentPermissionMode,
  operatingModePolicies,
  parseAgentProfileId,
  parseOperatingModeId,
} from "../src/index.js";

describe("agent profile contracts", () => {
  it("defines three stable specialized profiles", () => {
    expect(agentProfilePolicies.map((profile) => profile.id)).toEqual([
      "explore_v1",
      "implement_v1",
      "review_v1",
    ]);
    expect(getAgentProfilePolicy("explore_v1")).toMatchObject({
      version: 1,
      displayName: "Explore",
      executionMode: "plan",
      tools: {
        readOnly: true,
        evidenceFromSources: true,
        allowedCategories: ["read"],
        maxRisk: "normal",
      },
    });
    expect(getAgentProfilePolicy("explore_v1").tools.allowedNames).toEqual([
      "read_file",
      "list_files",
      "search_text",
      "git_status",
      "git_diff",
    ]);
    expect(getAgentProfilePolicy("implement_v1")).toMatchObject({
      displayName: "Implement",
      executionMode: "act",
      tools: {
        readOnly: false,
        allowedCategories: ["read", "write", "shell"],
        maxRisk: "elevated",
      },
    });
    expect(getAgentProfilePolicy("implement_v1").tools.allowedNames).toEqual([
      "read_file",
      "list_files",
      "search_text",
      "apply_patch",
      "run_command",
      "run_verification",
      "git_status",
      "git_diff",
    ]);
    expect(getAgentProfilePolicy("review_v1")).toMatchObject({
      displayName: "Review",
      executionMode: "act",
      tools: {
        readOnly: false,
        allowedCategories: ["read", "shell"],
        maxRisk: "normal",
      },
    });
    expect(getAgentProfilePolicy("review_v1").tools.allowedNames).toEqual([
      "read_file",
      "list_files",
      "search_text",
      "run_verification",
      "git_status",
      "git_diff",
    ]);
  });

  it("parses exact profile names and stable ids without prefixes", () => {
    expect(parseAgentProfileId("explore")).toBe("explore_v1");
    expect(parseAgentProfileId("Implement")).toBe("implement_v1");
    expect(parseAgentProfileId("review_v1")).toBe("review_v1");
    expect(parseAgentProfileId("rev")).toBeNull();
    expect(parseAgentProfileId("review extra")).toBeNull();
  });

  it("exposes immutable profile policy values", () => {
    expect(Object.isFrozen(agentProfilePolicies)).toBe(true);
    for (const profile of agentProfilePolicies) {
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.tools)).toBe(true);
      expect(Object.isFrozen(profile.tools.allowedNames)).toBe(true);
      expect(Object.isFrozen(profile.tools.allowedCategories)).toBe(true);
    }
  });
});

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
      expect(policy.workflow.maxChildrenPerRun).toBeGreaterThan(0);
    }
    expect(operatingModePolicies.map((policy) =>
      policy.workflow.maxChildrenPerRun
    )).toEqual([2, 3, 4, 6, 8]);
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
    expect(Object.isFrozen(balanced.workflow)).toBe(true);
  });
});
