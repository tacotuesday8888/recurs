import type { CompanyBlueprintV2 } from "@recurs/contracts";

import {
  approveCompanyBlueprintV2,
  compileCompanyBlueprintV2,
} from "./company-blueprint-v2.js";
import type { CompanyBenchmarkScenario } from "./company-benchmark-scenario.js";

const CREATED_AT = "2026-07-24T00:00:00.000Z";
const APPROVED_AT = "2026-07-24T00:00:01.000Z";

/**
 * Returns the immutable company used by the built-in proof campaign. Keeping
 * this authority deterministic makes repeated arms comparable and prevents
 * a model-written organization from changing the experiment.
 */
export function createCompanyBenchmarkBlueprint(
  scenario: CompanyBenchmarkScenario,
): CompanyBlueprintV2 {
  const legacyAlias = scenario.id === "alias_registry" &&
    scenario.version === 1;
  const authorityId = `company-benchmark-${scenario.id}-v${scenario.version}`;
  return approveCompanyBlueprintV2(compileCompanyBlueprintV2({
    id: legacyAlias
      ? "company-benchmark-blueprint-v1"
      : `${authorityId}-blueprint`,
    companyId: legacyAlias ? "company-benchmark-v1" : authorityId,
    revision: 1,
    previousBlueprintId: null,
    createdAt: CREATED_AT,
    onboardingRunId: legacyAlias
      ? "company-benchmark-onboarding-v1"
      : `${authorityId}-onboarding`,
    onboardingDepth: "guided",
    generatedBy: "deterministic",
    designMode: "guardrailed_dynamic",
    project: {
      type: "existing_project",
      stage: "active",
      purpose: legacyAlias
        ? "Implement the bounded alias-registry benchmark."
        : scenario.objective,
      users: ["Maintainers"],
      successCriteria: [
        "The hidden verifier passes after independent review.",
      ],
      constraints: legacyAlias
        ? ["Change only the two approved source files."]
        : [`Change only: ${scenario.allowedChangedPaths.join(", ")}.`],
      risks: legacyAlias
        ? ["Traversal or alias-boundary behavior may be incomplete."]
        : ["Cross-file contract behavior may be incomplete."],
      architecturePreferences: ["Remain dependency-free."],
      deploymentTargets: ["CLI"],
      repository: {
        inspected: true,
        markers: ["package.json"],
        evidence: [{
          path: "package.json",
          finding: legacyAlias
            ? "The benchmark is a dependency-free Node.js fixture."
            : `The ${scenario.id} benchmark is a dependency-free Node.js fixture.`,
        }],
      },
    },
    permissionMode: "approved_for_me",
    operatingModeId: "balanced_v6",
    organization: {
      departments: [{
        key: "delivery",
        displayName: "Delivery",
        purpose: "Implement the bounded change.",
      }, {
        key: "quality",
        displayName: "Quality",
        purpose: "Review every staged candidate independently.",
      }],
      roles: [{
        key: "root",
        displayName: "Root Orchestrator",
        kind: "orchestrator",
        departmentKey: "delivery",
        responsibility: "Own the exact benchmark objective.",
        instructions: "Delegate only the approved implementation and review.",
        reportsToKey: null,
        capabilities: ["plan"],
        executionProfileId: null,
        permissionMode: "approved_for_me",
        toolBundles: ["project_context_v1"],
        expectedEvidence: ["A concise synthesis."],
        activation: "always",
      }, {
        key: "builder",
        displayName: "Scoped Builder",
        kind: "worker",
        departmentKey: "delivery",
        responsibility: "Implement the two approved source files.",
        instructions: "Stay within the approved source paths.",
        reportsToKey: "root",
        capabilities: ["implement", "repair"],
        executionProfileId: "implement_v2",
        permissionMode: "approved_for_me",
        toolBundles: ["implementation_v1"],
        expectedEvidence: ["Changed paths and implementation evidence."],
        activation: "on_demand",
      }, {
        key: "reviewer",
        displayName: "Independent Reviewer",
        kind: "reviewer",
        departmentKey: "quality",
        responsibility: "Review the complete staged candidate.",
        instructions: "Request concrete repair or approve with evidence.",
        reportsToKey: "root",
        capabilities: ["review"],
        executionProfileId: "review_v2",
        permissionMode: "ask_always",
        toolBundles: ["quality_v1"],
        expectedEvidence: ["Structured findings and a terminal verdict."],
        activation: "always",
      }],
      rootRoleKey: "root",
      independentReviewRoleKeys: ["reviewer"],
      defaultActiveRoleKeys: ["root", "builder", "reviewer"],
    },
    availableToolBundles: [
      "project_context_v1",
      "implementation_v1",
      "quality_v1",
    ],
    initialGoal: scenario.objective,
    roadmap: ["Implement, review, repair, and verify the fixture."],
  }), APPROVED_AT);
}
