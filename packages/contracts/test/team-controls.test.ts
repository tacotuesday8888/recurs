import { describe, expect, it } from "vitest";

import * as contracts from "../src/index.js";
import { companyBlueprintV2Fixture } from "./company-v2-fixture.js";

type TeamControlApi = {
  readonly parseTeamControlPolicyV1: (value: unknown) => unknown;
  readonly parseEffectiveTeamControlPolicyV1: (value: unknown) => unknown;
  readonly recommendedTeamControlPolicy: (
    operatingModeId: string,
    revision?: number,
  ) => unknown;
  readonly validateTeamControlPolicyAgainstMode: (
    policy: unknown,
    operatingModeId: string,
  ) => void;
  readonly effectiveTeamControlPolicy: (
    policy: unknown,
    blueprint: unknown,
  ) => unknown;
};

const api = contracts as unknown as TeamControlApi;

function balancedPolicy(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    revision: 3,
    operatingModeId: "balanced_v6",
    operatingModeVersion: 6,
    topology: "hierarchical",
    maxActiveAgents: 6,
    maxConcurrentAgents: 3,
    maxDelegationDepth: 2,
    escalation: "manager_only",
    independentReview: "required",
    maxRepairRounds: 1,
    maxRequests: 64,
    maxReportedCostUsd: 2.5,
    ...overrides,
  };
}

describe("team-control contracts", () => {
  it("parses every stable user-governed topology", () => {
    for (const topology of [
      "recommended",
      "focused",
      "parallel",
      "hierarchical",
      "research_heavy",
      "review_heavy",
    ]) {
      expect(api.parseTeamControlPolicyV1(
        balancedPolicy({ topology }),
      )).toEqual(balancedPolicy({ topology }));
    }
  });

  it("rejects unknown fields, versions, enums, and invalid numeric bounds", () => {
    for (const invalid of [
      balancedPolicy({ extra: true }),
      balancedPolicy({ version: 2 }),
      balancedPolicy({ revision: 0 }),
      balancedPolicy({ operatingModeVersion: 5 }),
      balancedPolicy({ topology: "swarm" }),
      balancedPolicy({ escalation: "anyone" }),
      balancedPolicy({ independentReview: "disabled" }),
      balancedPolicy({ maxActiveAgents: 0 }),
      balancedPolicy({ maxConcurrentAgents: 7 }),
      balancedPolicy({ maxDelegationDepth: 0 }),
      balancedPolicy({ maxRepairRounds: -1 }),
      balancedPolicy({ maxRequests: 0 }),
      balancedPolicy({ maxReportedCostUsd: 0 }),
    ]) {
      expect(() => api.parseTeamControlPolicyV1(invalid)).toThrow(TypeError);
    }
  });

  it("deep-freezes parsed policies", () => {
    const parsed = api.parseTeamControlPolicyV1(balancedPolicy());

    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("derives deterministic recommended policies from current company modes", () => {
    expect(api.recommendedTeamControlPolicy("economy_v6")).toEqual({
      version: 1,
      revision: 1,
      operatingModeId: "economy_v6",
      operatingModeVersion: 6,
      topology: "recommended",
      maxActiveAgents: 3,
      maxConcurrentAgents: 1,
      maxDelegationDepth: 1,
      escalation: "manager_only",
      independentReview: "required",
      maxRepairRounds: 0,
      maxRequests: 12,
      maxReportedCostUsd: 0.25,
    });
    expect(api.recommendedTeamControlPolicy("max_v6", 4)).toEqual({
      version: 1,
      revision: 4,
      operatingModeId: "max_v6",
      operatingModeVersion: 6,
      topology: "recommended",
      maxActiveAgents: 16,
      maxConcurrentAgents: 6,
      maxDelegationDepth: 3,
      escalation: "manager_only",
      independentReview: "required",
      maxRepairRounds: 2,
      maxRequests: 260,
      maxReportedCostUsd: 25,
    });
  });

  it("rejects mode mismatches and every attempted authority widening", () => {
    const attempts = [
      balancedPolicy({ operatingModeId: "performance_v6" }),
      balancedPolicy({ maxActiveAgents: 9 }),
      balancedPolicy({ maxConcurrentAgents: 4 }),
      balancedPolicy({ maxDelegationDepth: 3 }),
      balancedPolicy({ maxRepairRounds: 2 }),
      balancedPolicy({ maxRequests: 81 }),
      balancedPolicy({ maxReportedCostUsd: 3.01 }),
    ];

    for (const attempt of attempts) {
      expect(() => {
        const parsed = api.parseTeamControlPolicyV1(attempt);
        api.validateTeamControlPolicyAgainstMode(parsed, "balanced_v6");
      }).toThrow(TypeError);
    }
  });

  it("intersects saved preferences with the exact approved blueprint", () => {
    const blueprint = companyBlueprintV2Fixture();
    const effective = api.effectiveTeamControlPolicy(
      api.parseTeamControlPolicyV1(balancedPolicy({
        independentReview: "when_planned",
      })),
      blueprint,
    );

    expect(effective).toEqual({
      version: 1,
      sourceRevision: 3,
      operatingModeId: "balanced_v6",
      operatingModeVersion: 6,
      blueprintId: "company-v2-fixture",
      blueprintRevision: 1,
      topology: "hierarchical",
      maxActiveAgents: 3,
      maxConcurrentAgents: 3,
      maxDelegationDepth: 1,
      escalation: "manager_only",
      independentReview: "required",
      maxRepairRounds: 1,
      maxRequests: 64,
      maxReportedCostUsd: 2.5,
    });
    expect(Object.isFrozen(effective)).toBe(true);
  });

  it("requires exact, non-widening effective snapshots", () => {
    const effective = api.effectiveTeamControlPolicy(
      api.parseTeamControlPolicyV1(balancedPolicy()),
      companyBlueprintV2Fixture(),
    ) as Record<string, unknown>;

    expect(api.parseEffectiveTeamControlPolicyV1(effective)).toEqual(effective);
    expect(() => api.parseEffectiveTeamControlPolicyV1({
      ...effective,
      maxActiveAgents: 9,
    })).toThrow(TypeError);
    expect(() => api.parseEffectiveTeamControlPolicyV1({
      ...effective,
      blueprintRevision: 0,
    })).toThrow(TypeError);
  });
});
