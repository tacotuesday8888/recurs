import { describe, expect, it } from "vitest";

import {
  approveCompanyBlueprint,
  companyContextInstructions,
  compileCompanyBlueprint,
} from "../src/index.js";

const project = {
  type: "web_app" as const,
  stage: "prototype" as const,
  purpose: "Build a dependable company-style coding harness.",
  constraints: ["Keep permissions monotonic."],
  repository: {
    inspected: true,
    markers: [".git", "package.json"] as const,
  },
};

describe("company blueprint compiler", () => {
  it("creates the complete tailored layered roster without starting work", () => {
    const blueprint = compileCompanyBlueprint({
      id: "company-1",
      createdAt: "2026-07-21T00:00:00.000Z",
      project,
      developmentStyle: "layered_company",
      permissionMode: "approved_for_me",
      operatingModeId: "balanced_v5",
    });

    expect(blueprint.state).toBe("proposed");
    expect(blueprint.approvedAt).toBeNull();
    expect(blueprint.roles.map((role) => role.id)).toEqual([
      "orchestrator_v1",
      "product_planner_v1",
      "tool_curator_v1",
      "architect_v1",
      "implementation_lead_v1",
      "scoped_builder_v1",
      "qa_reviewer_v1",
      "security_release_reviewer_v1",
    ]);
    expect(blueprint.quality).toMatchObject({
      standard: "balanced",
      maxImplementers: 2,
      initialReviewers: 1,
      maxReviewers: 2,
      maxRepairRounds: 1,
    });
    expect(blueprint.roles.find((role) => role.id === "architect_v1")?.instructions)
      .toContain(project.purpose);
    expect(blueprint.roles.find((role) => role.id === "architect_v1")?.instructions)
      .toContain("package.json");
  });

  it("uses smaller real rosters for orchestrator and single-agent styles", () => {
    const base = {
      id: "company-1",
      createdAt: "2026-07-21T00:00:00.000Z",
      project,
      permissionMode: "ask_always" as const,
      operatingModeId: "standard_v5" as const,
    };
    expect(compileCompanyBlueprint({
      ...base,
      developmentStyle: "orchestrator",
    }).roles.map((role) => role.id)).toEqual([
      "orchestrator_v1",
      "scoped_builder_v1",
      "qa_reviewer_v1",
    ]);
    expect(compileCompanyBlueprint({
      ...base,
      developmentStyle: "single_agent",
    }).roles.map((role) => role.id)).toEqual(["orchestrator_v1"]);
  });

  it("approves immutably and renders bounded root-only operating context", () => {
    const proposed = compileCompanyBlueprint({
      id: "company-1",
      createdAt: "2026-07-21T00:00:00.000Z",
      project,
      developmentStyle: "layered_company",
      permissionMode: "approved_for_me",
      operatingModeId: "balanced_v5",
    });
    const approved = approveCompanyBlueprint(
      proposed,
      "2026-07-21T00:01:00.000Z",
    );
    const context = companyContextInstructions(approved);

    expect(approved).toMatchObject({
      state: "approved",
      approvedAt: "2026-07-21T00:01:00.000Z",
    });
    expect(proposed.state).toBe("proposed");
    expect(context.join("\n")).toContain("delegate_company_task");
    expect(context.join("\n")).toContain("scoped_builder_v1");
    expect(context.join("\n")).toContain("does not authorize automatic work");
    expect(context.join("\n").length).toBeLessThan(8_192);
  });

  it("is deterministic for injected identity, time, and intake", () => {
    const input = {
      id: "company-1",
      createdAt: "2026-07-21T00:00:00.000Z",
      project,
      developmentStyle: "layered_company" as const,
      permissionMode: "approved_for_me" as const,
      operatingModeId: "balanced_v5" as const,
    };
    expect(compileCompanyBlueprint(input)).toEqual(compileCompanyBlueprint(input));
  });
});
