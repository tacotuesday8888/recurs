import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createCompanyBenchmarkBlueprint,
  assertCompanyBenchmarkBlueprintFitsOperatingMode,
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

  it("bounds new independent worker scopes while preserving the original pilot authority", () => {
    const original = createCompanyBenchmarkBlueprint(getCompanyBenchmarkScenario("workspace_maintenance", 1));
    expect(original.roles.filter((role) => role.kind === "worker")).toHaveLength(3);
    expect(() => assertCompanyBenchmarkBlueprintFitsOperatingMode(original)).toThrow("permits 2");
    const blueprint = createCompanyBenchmarkBlueprint(getCompanyBenchmarkScenario("workspace_maintenance"));
    const workers = blueprint.roles.filter((role) => role.kind === "worker");
    expect(workers).toHaveLength(2);
    expect(() => assertCompanyBenchmarkBlueprintFitsOperatingMode(blueprint)).not.toThrow();
    expect(workers.map((role) => role.responsibility)).toEqual([
      "Implement only src/paths.js, src/redact.js.", "Implement only src/env.js.",
    ]);
    expect(blueprint.authorityAnchors.independentReviewRoleIds).toHaveLength(1);
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
