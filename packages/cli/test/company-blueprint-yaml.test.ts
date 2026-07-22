import { describe, expect, it } from "vitest";

import { parseCompanyBlueprintV2 } from "@recurs/contracts";
import { companyBlueprintV2Fixture } from "../../contracts/test/company-v2-fixture.js";

import {
  CompanyBlueprintYamlError,
  diffCompanyBlueprints,
  parseCompanyBlueprintYaml,
  renderCompanyBlueprintYaml,
} from "../src/index.js";

describe("company blueprint YAML", () => {
  it("round-trips a strict canonical V2 blueprint", () => {
    const blueprint = companyBlueprintV2Fixture();
    const yaml = renderCompanyBlueprintYaml(blueprint);
    const parsed = parseCompanyBlueprintYaml(yaml);

    expect(parsed).toEqual(blueprint);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(yaml).toContain("version: 2");
    expect(yaml).toContain("companyId: company-v2-fixture");
  });

  it("rejects aliases, duplicate keys, multiple documents, and unknown fields", () => {
    expect(() => parseCompanyBlueprintYaml("value: &shared 1\ncopy: *shared\n"))
      .toThrow("aliases are not allowed");
    expect(() => parseCompanyBlueprintYaml("id: one\nid: two\n"))
      .toThrow("Company YAML is invalid");
    expect(() => parseCompanyBlueprintYaml("id: one\n---\nid: two\n"))
      .toThrow("must contain one document");

    const yaml = `${renderCompanyBlueprintYaml(companyBlueprintV2Fixture())}unexpected: true\n`;
    expect(() => parseCompanyBlueprintYaml(yaml)).toThrow("must contain exactly");
  });

  it("reports contract violations without weakening authority validation", () => {
    const blueprint = companyBlueprintV2Fixture();
    const invalid = {
      ...blueprint,
      roles: blueprint.roles.map((role) => role.id === "quality_reviewer"
        ? { ...role, permissionMode: "full_access" }
        : role),
    };

    expect(() => parseCompanyBlueprintYaml(renderUnchecked(invalid)))
      .toThrow("Company role policy is invalid");
  });

  it("bounds input size and rejects empty or NUL-containing input", () => {
    expect(() => parseCompanyBlueprintYaml("")).toThrow(CompanyBlueprintYamlError);
    expect(() => parseCompanyBlueprintYaml("id: bad\0value"))
      .toThrow(CompanyBlueprintYamlError);
    expect(() => parseCompanyBlueprintYaml("a".repeat(512 * 1024 + 1)))
      .toThrow(CompanyBlueprintYamlError);
  });

  it("describes bounded human-facing proposal changes", () => {
    const previous = companyBlueprintV2Fixture();
    const next = parseCompanyBlueprintV2({
      ...previous,
      project: { ...previous.project, purpose: "Ship a safer company runtime." },
      roles: previous.roles.map((role) => role.id === "quality_reviewer"
        ? { ...role, displayName: "Evidence Reviewer" }
        : role),
      initialGoal: "Deliver a different reviewed slice.",
    });

    expect(diffCompanyBlueprints(previous, next)).toEqual(expect.arrayContaining([
      "Project purpose changed",
      "Project brief changed",
      "Role changed: Evidence Reviewer",
      "Initial goal changed",
    ]));
  });
});

function renderUnchecked(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
