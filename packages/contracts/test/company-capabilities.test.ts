import { describe, expect, it } from "vitest";

import {
  parseCompanyCapabilityBindingSet,
  validateCompanyCapabilityBindingsAgainstBlueprint,
  type CompanyCapabilityBindingSetV1,
} from "../src/index.js";
import { companyBlueprintV2Fixture } from "./company-v2-fixture.js";

const at = "2026-07-22T10:00:00.000Z";

function fixture(): CompanyCapabilityBindingSetV1 {
  return {
    companyId: "company-v2-fixture",
    version: 1,
    revision: 2,
    blueprintId: "company-v2-fixture",
    blueprintRevision: 1,
    updatedAt: at,
    bindings: [{
      id: "capability-release-skill",
      bundleId: "quality_v1",
      source: {
        type: "agent_skill",
        id: "release-check",
        scope: "user",
      },
      approvedAt: at,
    }, {
      id: "capability-issue-tracker",
      bundleId: "project_context_v1",
      source: {
        type: "mcp_server",
        id: "issue-tracker",
        scope: "project",
      },
      approvedAt: at,
    }],
  };
}

describe("company capability bindings", () => {
  it("parses an exact immutable binding set", () => {
    const parsed = parseCompanyCapabilityBindingSet(fixture());

    expect(parsed).toEqual(fixture());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.bindings)).toBe(true);
    expect(Object.isFrozen(parsed.bindings[0]?.source)).toBe(true);
  });

  it("rejects unknown fields, unsafe identities, and unsupported sources", () => {
    expect(() => parseCompanyCapabilityBindingSet({
      ...fixture(),
      unexpected: true,
    })).toThrow(/exactly/iu);
    expect(() => parseCompanyCapabilityBindingSet({
      ...fixture(),
      bindings: [{
        ...fixture().bindings[0],
        source: { type: "agent_skill", id: "../secret", scope: "user" },
      }],
    })).toThrow(/invalid/iu);
    expect(() => parseCompanyCapabilityBindingSet({
      ...fixture(),
      bindings: [{
        ...fixture().bindings[0],
        source: { type: "binary", id: "release-check", scope: "user" },
      }],
    })).toThrow(/type/iu);
  });

  it("rejects duplicate IDs and duplicate semantic grants", () => {
    const first = fixture().bindings[0]!;
    expect(() => parseCompanyCapabilityBindingSet({
      ...fixture(),
      bindings: [first, { ...first }],
    })).toThrow(/unique/iu);
    expect(() => parseCompanyCapabilityBindingSet({
      ...fixture(),
      bindings: [first, { ...first, id: "capability-duplicate" }],
    })).toThrow(/duplicate/iu);
  });

  it("requires the exact approved blueprint revision and an approved bundle", () => {
    const blueprint = companyBlueprintV2Fixture();
    expect(validateCompanyCapabilityBindingsAgainstBlueprint(
      parseCompanyCapabilityBindingSet(fixture()),
      blueprint,
    )).toBeUndefined();

    expect(() => validateCompanyCapabilityBindingsAgainstBlueprint(
      parseCompanyCapabilityBindingSet({ ...fixture(), blueprintRevision: 2 }),
      blueprint,
    )).toThrow(/revision/iu);
    expect(() => validateCompanyCapabilityBindingsAgainstBlueprint(
      parseCompanyCapabilityBindingSet({
        ...fixture(),
        bindings: [{
          ...fixture().bindings[0],
          bundleId: "release_v1",
        }],
      }),
      blueprint,
    )).toThrow(/bundle/iu);
    expect(() => validateCompanyCapabilityBindingsAgainstBlueprint(
      parseCompanyCapabilityBindingSet(fixture()),
      { ...blueprint, state: "proposed" },
    )).toThrow(/approved/iu);
  });
});
