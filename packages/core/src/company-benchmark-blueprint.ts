import { getOperatingModePolicy, type CompanyBlueprintV2 } from "@recurs/contracts";

import {
  approveCompanyBlueprintV2,
  compileCompanyBlueprintV2,
} from "./company-blueprint-v2.js";
import type { CompanyBenchmarkScenario } from "./company-benchmark-scenario.js";

import { PRODUCT_TASK_SPECS } from "./company-benchmark-product-tasks.js";
import { TASK_FIT_SPECS } from "./company-benchmark-task-fit.js";

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
  const productTask = PRODUCT_TASK_SPECS.find((spec) => spec.id === scenario.id);
  const taskFit = productTask ?? TASK_FIT_SPECS.find((spec) => spec.id === scenario.id);
  const modulePaths = taskFit?.parallelScopes ?? [];
  const workerLimit = getOperatingModePolicy("balanced_v6").workflow.team!.maxImplementers;
  const parallelScopes = scenario.version === 1 && productTask === undefined ? modulePaths : Array.from(
    { length: Math.min(workerLimit, modulePaths.length) },
    (_, index) => modulePaths.filter((_, position) => position % workerLimit === index).join(", "),
  );
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
        instructions: parallelScopes.length === 0
          ? "Delegate only the approved implementation and review."
          : scenario.version === 1 && productTask === undefined
            ? "Delegate each independent module to its scoped worker concurrently, then run one combined independent review. Do not serialize independent implementation assignments."
            : "Delegate the approved worker scopes concurrently, with one assignment per worker. Each worker handles all files in its scope. Run one combined independent review afterward.",
        reportsToKey: null,
        capabilities: ["plan"],
        executionProfileId: null,
        permissionMode: "approved_for_me",
        toolBundles: ["project_context_v1"],
        expectedEvidence: ["A concise synthesis."],
        activation: "always",
      }, ...(parallelScopes.length === 0 ? [{
        key: "builder",
        displayName: "Scoped Builder",
        kind: "worker" as const,
        departmentKey: "delivery",
        responsibility: taskFit === undefined
          ? "Implement the two approved source files."
          : `Implement only: ${scenario.allowedChangedPaths.join(", ")}.`,
        instructions: "Stay within the approved source paths.",
        reportsToKey: "root",
        capabilities: ["implement" as const, "repair" as const],
        executionProfileId: "implement_v2" as const,
        permissionMode: "approved_for_me" as const,
        toolBundles: ["implementation_v1" as const],
        expectedEvidence: ["Changed paths and implementation evidence."],
        activation: "on_demand" as const,
      }] : []), ...parallelScopes.map((scope, index) => ({
        key: `module_${index + 1}`,
        displayName: `Module ${index + 1} Builder`,
        kind: "worker" as const,
        departmentKey: "delivery",
        responsibility: `Implement only ${scope}.`,
        instructions: `Own ${scope}. Other workers own other modules; do not edit their paths. Run relevant checks and report concise evidence.`,
        reportsToKey: "root",
        capabilities: ["implement" as const, "repair" as const],
        executionProfileId: "implement_v2" as const,
        permissionMode: "approved_for_me" as const,
        toolBundles: ["implementation_v1" as const],
        expectedEvidence: ["Changed path and test evidence."],
        activation: "on_demand" as const,
      })), {
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
      defaultActiveRoleKeys: ["root", ...(parallelScopes.length === 0 ? ["builder"] : parallelScopes.map((_, index) => `module_${index + 1}`)), "reviewer"],
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

/** New campaigns must not request a worker topology their frozen mode forbids. */
export function assertCompanyBenchmarkBlueprintFitsOperatingMode(blueprint: CompanyBlueprintV2): void {
  const policy = getOperatingModePolicy(blueprint.authority.operatingModeId);
  const active = new Set(blueprint.activation.defaultActiveRoleIds);
  const implementers = blueprint.roles.filter((role) => active.has(role.id) && role.capabilities.includes("implement"));
  const maximum = policy.workflow.team?.maxImplementers ?? 0;
  if (implementers.length > maximum) {
    throw new TypeError(`Benchmark blueprint requests ${implementers.length} Implement workers; ${policy.id} permits ${maximum}.`);
  }
}
