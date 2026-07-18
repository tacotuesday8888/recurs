import { describe, expect, it } from "vitest";

import {
  agentProfilePolicies,
  DEFAULT_OPERATING_MODE_ID,
  getAgentProfilePolicy,
  getOperatingModePolicy,
  LEGACY_OPERATING_MODE_ID,
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
        readOnly: true,
        allowedCategories: ["read"],
        maxRisk: "normal",
      },
    });
    expect(getAgentProfilePolicy("review_v1").tools.allowedNames).toEqual([
      "read_file",
      "list_files",
      "search_text",
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

  it("keeps Review unable to execute repository code", () => {
    const review = getAgentProfilePolicy("review_v1");

    expect(review.tools.readOnly).toBe(true);
    expect(review.tools.allowedNames).not.toContain("run_verification");
    expect(review.tools.allowedCategories).toEqual(["read"]);
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
  it("preserves v1/v2 policies and adds stable v3 team policies", () => {
    expect(operatingModePolicies.map((policy) => policy.id)).toEqual([
      "economy_v1",
      "standard_v1",
      "balanced_v1",
      "performance_v1",
      "max_v1",
      "economy_v2",
      "standard_v2",
      "balanced_v2",
      "performance_v2",
      "max_v2",
      "economy_v3",
      "standard_v3",
      "balanced_v3",
      "performance_v3",
      "max_v3",
    ]);
    expect(operatingModePolicies.map((policy) => policy.displayName)).toEqual([
      "Economy",
      "Standard",
      "Balanced",
      "Performance",
      "Max",
      "Economy",
      "Standard",
      "Balanced",
      "Performance",
      "Max",
      "Economy",
      "Standard",
      "Balanced",
      "Performance",
      "Max",
    ]);
    expect(operatingModePolicies.map((policy) => policy.version)).toEqual([
      1, 1, 1, 1, 1,
      2, 2, 2, 2, 2,
      3, 3, 3, 3, 3,
    ]);
  });

  it("defaults new sessions to v3 while retaining an explicit legacy default", () => {
    expect(DEFAULT_OPERATING_MODE_ID).toBe("balanced_v3");
    expect(LEGACY_OPERATING_MODE_ID).toBe("balanced_v1");
    expect(getOperatingModePolicy(DEFAULT_OPERATING_MODE_ID).displayName).toBe("Balanced");
    expect(getOperatingModePolicy(LEGACY_OPERATING_MODE_ID).version).toBe(1);
  });

  it("parses display names to latest policies and every exact stable id", () => {
    expect(parseOperatingModeId("economy")).toBe("economy_v3");
    expect(parseOperatingModeId("Performance")).toBe("performance_v3");
    expect(parseOperatingModeId("max_v1")).toBe("max_v1");
    expect(parseOperatingModeId("max_v2")).toBe("max_v2");
    expect(parseOperatingModeId("max_v3")).toBe("max_v3");
    expect(parseOperatingModeId("bal")).toBeNull();
    expect(parseOperatingModeId("max extra")).toBeNull();
  });

  it("keeps every mode bounded and honest about model selection", () => {
    for (const policy of operatingModePolicies) {
      expect(policy.model.selection).toBe("inherit_parent");
      expect(policy.orchestration.maxDepth).toBe(1);
      expect(policy.orchestration.maxRetries).toBe(0);
      expect(policy.orchestration.maxRequests).toBeGreaterThan(0);
      expect(policy.orchestration.maxReportedCostUsd).toBeGreaterThan(0);
      expect(policy.workflow.maxChildrenPerRun).toBeGreaterThan(0);
    }
    expect(operatingModePolicies.slice(0, 5).map((policy) =>
      policy.orchestration.maxConcurrentChildren
    )).toEqual([1, 1, 1, 1, 1]);
    expect(operatingModePolicies.slice(5, 10).map((policy) =>
      policy.orchestration.maxConcurrentChildren
    )).toEqual([1, 2, 3, 4, 6]);
    expect(operatingModePolicies.slice(10).map((policy) =>
      policy.orchestration.maxConcurrentChildren
    )).toEqual([1, 2, 3, 4, 6]);
    expect(operatingModePolicies.map((policy) =>
      policy.workflow.maxChildrenPerRun
    )).toEqual([
      2, 3, 4, 6, 8,
      2, 3, 4, 6, 8,
      2, 3, 4, 6, 8,
    ]);
    expect(operatingModePolicies.map((policy) =>
      policy.workflow.maxRequestsPerRun
    )).toEqual([
      16, 48, 96, 192, 320,
      8, 16, 24, 32, 40,
      8, 18, 32, 60, 96,
    ]);
  });

  it("defines honest mode-bounded team width and review standards only in v3", () => {
    expect(operatingModePolicies.slice(0, 10).every(
      (policy) => policy.workflow.team === null,
    )).toBe(true);
    expect(operatingModePolicies.slice(10).map((policy) =>
      policy.workflow.team
    )).toEqual([
      {
        qualityStandard: "essential",
        maxImplementers: 1,
        initialReviewers: 1,
        maxReviewers: 1,
        approvalRule: "unanimous",
      },
      {
        qualityStandard: "standard",
        maxImplementers: 1,
        initialReviewers: 1,
        maxReviewers: 2,
        approvalRule: "unanimous",
      },
      {
        qualityStandard: "balanced",
        maxImplementers: 2,
        initialReviewers: 1,
        maxReviewers: 2,
        approvalRule: "unanimous",
      },
      {
        qualityStandard: "thorough",
        maxImplementers: 3,
        initialReviewers: 2,
        maxReviewers: 3,
        approvalRule: "unanimous",
      },
      {
        qualityStandard: "maximum",
        maxImplementers: 4,
        initialReviewers: 2,
        maxReviewers: 4,
        approvalRule: "unanimous",
      },
    ]);
    for (const policy of operatingModePolicies.slice(10)) {
      const team = policy.workflow.team;
      expect(team).not.toBeNull();
      if (team !== null) {
        expect(team.maxImplementers + team.maxReviewers)
          .toBeLessThanOrEqual(policy.workflow.maxChildrenPerRun);
        expect(team.initialReviewers).toBeLessThanOrEqual(team.maxReviewers);
        expect(Object.isFrozen(team)).toBe(true);
      }
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
    expect(Object.isFrozen(balanced.workflow)).toBe(true);
    expect(balanced.workflow.team).toBeNull();
  });
});
