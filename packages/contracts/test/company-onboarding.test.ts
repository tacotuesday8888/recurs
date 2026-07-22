import { describe, expect, it } from "vitest";

import {
  getCompanyOnboardingDepthPolicy,
  parseCompanyOnboardingRun,
  type CompanyOnboardingRunV1,
} from "../src/index.js";
import { companyBlueprintV2Fixture } from "./company-v2-fixture.js";

function runFixture(): CompanyOnboardingRunV1 {
  return {
    id: "onboarding-fixture",
    companyId: "company-v2-fixture",
    version: 1,
    projectRoot: "/workspace/project",
    status: "proposed",
    createdAt: "2026-07-22T00:00:00.000Z",
    updatedAt: "2026-07-22T00:03:00.000Z",
    depth: "guided",
    designMode: "guardrailed_dynamic",
    authority: {
      permissionMode: "approved_for_me",
      operatingModeId: "balanced_v6",
      operatingModeVersion: 6,
    },
    backend: { fingerprint: "backend-fixture" },
    repositoryAccess: {
      scope: "project_read",
      grantedAt: "2026-07-22T00:00:30.000Z",
    },
    interview: {
      complete: true,
      pendingQuestion: null,
      answers: [{
        id: "answer-1",
        question: "What outcome should the company own?",
        answer: "A dependable CLI company foundation.",
        at: "2026-07-22T00:01:00.000Z",
      }],
    },
    research: [{
      id: "research-1",
      description: "Understand the existing harness.",
      prompt: "Inspect the agent contracts read-only.",
      status: "completed",
      evidence: ["packages/contracts/src/agents.ts defines bounded modes."],
      failure: null,
    }],
    usage: { modelRequests: 4, reportedCostUsd: 0.1 },
    proposal: {
      revision: 1,
      source: "initial",
      createdAt: "2026-07-22T00:03:00.000Z",
      blueprint: companyBlueprintV2Fixture({
        state: "proposed",
        onboardingRunId: "onboarding-fixture",
      }),
    },
    approvedBlueprintId: null,
    terminalReason: null,
  };
}

describe("company onboarding contracts", () => {
  it("defines clamped Quick, Guided, and Deep depth policies", () => {
    expect(getCompanyOnboardingDepthPolicy("quick", "balanced_v6"))
      .toMatchObject({ maxInterviewRounds: 4, maxResearchChildren: 0 });
    expect(getCompanyOnboardingDepthPolicy("guided", "economy_v6"))
      .toMatchObject({ maxResearchChildren: 1, maxConcurrentResearch: 1 });
    expect(getCompanyOnboardingDepthPolicy("deep", "max_v6"))
      .toMatchObject({ maxInterviewRounds: 20, maxResearchChildren: 8 });
  });

  it("parses and deeply freezes a resumable proposed run", () => {
    const parsed = parseCompanyOnboardingRun(runFixture());
    expect(parsed).toEqual(runFixture());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.interview.answers)).toBe(true);
    expect(Object.isFrozen(parsed.proposal?.blueprint.roles)).toBe(true);
  });

  it("rejects research without consent and depth-budget overflow", () => {
    expect(() => parseCompanyOnboardingRun({
      ...runFixture(),
      repositoryAccess: { scope: "none", grantedAt: null },
    })).toThrow(/consented/iu);
    expect(() => parseCompanyOnboardingRun({
      ...runFixture(),
      depth: "quick",
      proposal: null,
      status: "interviewing",
    })).toThrow(/depth policy/iu);
    expect(() => parseCompanyOnboardingRun({
      ...runFixture(),
      usage: { modelRequests: 25, reportedCostUsd: 0.1 },
    })).toThrow(/model requests/iu);
  });

  it("rejects proposal authority drift and dishonest terminal state", () => {
    expect(() => parseCompanyOnboardingRun({
      ...runFixture(),
      proposal: {
        ...runFixture().proposal,
        blueprint: companyBlueprintV2Fixture({
          state: "proposed",
          onboardingRunId: "different-run",
        }),
      },
    })).toThrow(/does not match/iu);
    expect(() => parseCompanyOnboardingRun({
      ...runFixture(),
      status: "approved",
    })).toThrow(/lifecycle/iu);
  });
});
