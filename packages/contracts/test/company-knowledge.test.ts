import { describe, expect, it } from "vitest";

import {
  parseCompanyAmendment,
  parseCompanyKnowledge,
  type CompanyKnowledgeV1,
} from "../src/index.js";
import { companyBlueprintV2Fixture } from "./company-v2-fixture.js";

function knowledgeFixture(): CompanyKnowledgeV1 {
  return {
    companyId: "company-v2-fixture",
    version: 1,
    revision: 2,
    updatedAt: "2026-07-22T02:02:00.000Z",
    entries: [{
      id: "knowledge-1",
      kind: "preference",
      statement: "Keep implementations concise and maintainable.",
      source: {
        type: "user",
        id: "message-1",
        evidence: "The user explicitly requested concise, maintainable code.",
      },
      confidence: "high",
      createdAt: "2026-07-22T02:00:00.000Z",
      supersedes: null,
    }, {
      id: "knowledge-2",
      kind: "decision",
      statement: "Use goal-scoped company autonomy.",
      source: {
        type: "user",
        id: "message-2",
        evidence: "The user selected goal-scoped autonomy.",
      },
      confidence: "high",
      createdAt: "2026-07-22T02:01:00.000Z",
      supersedes: null,
    }],
  };
}

describe("company knowledge and amendment contracts", () => {
  it("requires attributable, ordered, immutable project knowledge", () => {
    const knowledge = parseCompanyKnowledge(knowledgeFixture());
    expect(knowledge).toEqual(knowledgeFixture());
    expect(Object.isFrozen(knowledge.entries)).toBe(true);
    expect(() => parseCompanyKnowledge({
      ...knowledgeFixture(),
      entries: [{
        ...knowledgeFixture().entries[0],
        supersedes: "missing-entry",
      }],
    })).toThrow(/earlier/iu);
  });

  it("accepts only a proposal based on the exact next blueprint revision", () => {
    const proposal = companyBlueprintV2Fixture({
      id: "company-v2-revision-2",
      revision: 2,
      previousBlueprintId: "company-v2-fixture",
      state: "proposed",
    });
    const amendment = parseCompanyAmendment({
      id: "amendment-1",
      version: 1,
      companyId: "company-v2-fixture",
      baseBlueprintId: "company-v2-fixture",
      baseBlueprintRevision: 1,
      state: "proposed",
      createdAt: "2026-07-22T02:03:00.000Z",
      decidedAt: null,
      reason: "Add a specialist after repeated evidence shows it is needed.",
      proposedBlueprint: proposal,
      resultingBlueprintId: null,
      decisionReason: null,
    });
    expect(amendment.proposedBlueprint.revision).toBe(2);
    expect(Object.isFrozen(amendment)).toBe(true);
    expect(() => parseCompanyAmendment({
      ...amendment,
      baseBlueprintRevision: 2,
    })).toThrow(/lineage/iu);
  });

  it("requires an explicit, truthful amendment decision", () => {
    const proposal = companyBlueprintV2Fixture({
      id: "company-v2-revision-2",
      revision: 2,
      previousBlueprintId: "company-v2-fixture",
      state: "proposed",
    });
    expect(() => parseCompanyAmendment({
      id: "amendment-1",
      version: 1,
      companyId: "company-v2-fixture",
      baseBlueprintId: "company-v2-fixture",
      baseBlueprintRevision: 1,
      state: "approved",
      createdAt: "2026-07-22T02:03:00.000Z",
      decidedAt: "2026-07-22T02:04:00.000Z",
      reason: "Add a specialist.",
      proposedBlueprint: proposal,
      resultingBlueprintId: null,
      decisionReason: "Approved after review.",
    })).toThrow(/decision state/iu);
  });
});
