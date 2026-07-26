import { describe, expect, it } from "vitest";

import {
  createCompanyBenchmarkBlueprint,
  getCompanyBenchmarkScenario,
} from "../src/index.js";

describe("company benchmark blueprint", () => {
  it("is deterministic, approved, bounded, and repair-capable", () => {
    const first = createCompanyBenchmarkBlueprint();
    const second = createCompanyBenchmarkBlueprint();
    const scenario = getCompanyBenchmarkScenario("alias_registry", 1);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      state: "approved",
      authority: { operatingModeId: "balanced_v6" },
      initialGoal: scenario.objective,
    });
    expect(first.authorityAnchors.independentReviewRoleIds).toHaveLength(1);
    expect(first.roles.some((role) =>
      role.executionProfileId === "implement_v2" &&
      role.capabilities.includes("repair")
    )).toBe(true);
  });
});
