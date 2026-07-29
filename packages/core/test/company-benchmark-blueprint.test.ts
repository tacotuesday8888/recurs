import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createCompanyBenchmarkBlueprint,
  getCompanyBenchmarkScenario,
} from "../src/index.js";

describe("company benchmark blueprint", () => {
  it("is deterministic, approved, bounded, and repair-capable", () => {
    const scenario = getCompanyBenchmarkScenario("alias_registry", 1);
    const first = createCompanyBenchmarkBlueprint(scenario);
    const second = createCompanyBenchmarkBlueprint(scenario);

    expect(first).toEqual(second);
    expect(createHash("sha256").update(JSON.stringify(first)).digest("hex"))
      .toBe("6d9605d47f09fb1ff3c09b7025480ba21544b23a9aa5bccf8b1980fb2ccb59c8");
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

  it("binds company authority to the selected scenario", () => {
    const alias = getCompanyBenchmarkScenario("alias_registry", 1);
    const layered = getCompanyBenchmarkScenario("layered_config", 1);
    const aliasBlueprint = createCompanyBenchmarkBlueprint(alias);
    const layeredBlueprint = createCompanyBenchmarkBlueprint(layered);

    expect(layeredBlueprint.initialGoal).toBe(layered.objective);
    expect(layeredBlueprint.id).not.toBe(aliasBlueprint.id);
    expect(layeredBlueprint.project.purpose).toBe(layered.objective);
    expect(layeredBlueprint.project.constraints).toContain(
      `Change only: ${layered.allowedChangedPaths.join(", ")}.`,
    );
  });
});
