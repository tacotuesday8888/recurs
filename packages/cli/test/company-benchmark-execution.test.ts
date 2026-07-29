import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  companyBenchmarkTrialSlotId,
  parseCompanyBenchmarkCampaign,
  type CompanyBenchmarkRouteV1,
  type ProviderEvent,
  type ProviderRequest,
} from "@recurs/contracts";
import {
  CompanyBenchmarkRunner,
  FileCompanyBenchmarkSlotReservationStore,
  FileCompanyBenchmarkSlotSettlementStore,
  FileCompanyBenchmarkSummaryStore,
  FileCompanyBenchmarkTrialStore,
  AgentLoopError,
  CoordinatedRunError,
  createCompanyBenchmarkBlueprint,
  getCompanyBenchmarkScenario,
} from "@recurs/core";
import type { ModelProvider } from "@recurs/providers";
import { runProcess, type PermissionIntent } from "@recurs/tools";

import {
  RuntimeCompanyBenchmarkAdapter,
  assertCompanyBenchmarkScenarioAuthority,
  companyBenchmarkApprovalHandler,
  companyBenchmarkBlueprintDigest,
  companyBenchmarkExecutionFailureCode,
} from "../src/company-benchmark-execution.js";
import { RuntimeError } from "../src/runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

const correctAliasPath = `
const NAME = /^[a-z][a-z0-9_-]{0,31}$/u;

export function normalizeAliasPath(value) {
  if (typeof value !== "string" || value.includes("\\\\") ||
      value.includes("\\0") || !value.startsWith("@")) {
    throw new TypeError("invalid alias path");
  }
  const [rawName = "", ...rawParts] = value.slice(1).split("/");
  if (!NAME.test(rawName)) throw new TypeError("invalid alias name");
  const parts = [];
  for (const part of rawParts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new TypeError("alias traversal");
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return \`@\${rawName}\${parts.length === 0 ? "" : \`/\${parts.join("/")}\`}\`;
}
`.trimStart();

const flawedAliasPath = correctAliasPath.replace(
  "/^[a-z][a-z0-9_-]{0,31}$/u",
  "/^[A-Za-z][A-Za-z0-9_-]{0,31}$/u",
);

const correctRegistry = `
import { normalizeAliasPath } from "./alias-path.js";

function targetPath(value) {
  if (typeof value !== "string" || value.startsWith("/") ||
      value.includes("\\\\") || value.includes("\\0")) {
    throw new TypeError("invalid target");
  }
  const parts = [];
  for (const part of value.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new TypeError("target traversal");
    parts.push(part);
  }
  if (parts.length === 0) throw new TypeError("empty target");
  return parts.join("/");
}

export function createAliasRegistry(entries) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  const routes = entries.map(({ alias, target }) => ({
    alias: normalizeAliasPath(alias),
    target: targetPath(target),
  }));
  if (new Set(routes.map(({ alias }) => alias)).size !== routes.length) {
    throw new TypeError("duplicate alias");
  }
  routes.sort((left, right) => right.alias.length - left.alias.length);
  return Object.freeze({
    resolve(value) {
      const input = normalizeAliasPath(value);
      const route = routes.find(({ alias }) =>
        input === alias || input.startsWith(\`\${alias}/\`)
      );
      if (route === undefined) return null;
      const remainder = input.slice(route.alias.length).replace(/^\\//u, "");
      return remainder.length === 0 ? route.target : \`\${route.target}/\${remainder}\`;
    },
  });
}
`.trimStart();

function replacePatch(
  oldPath: string,
  oldContent: string,
  newContent: string,
): string {
  const oldLines = oldContent.trimEnd().split("\n");
  const newLines = newContent.trimEnd().split("\n");
  return [
    `diff --git a/${oldPath} b/${oldPath}`,
    `--- a/${oldPath}`,
    `+++ b/${oldPath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

function toolResponse(
  call: { readonly id: string; readonly name: string; readonly arguments: unknown },
): readonly ProviderEvent[] {
  return [
    { type: "tool_call", call },
    { type: "usage", inputTokens: 10, outputTokens: 2 },
    { type: "done", stopReason: "tool_calls" },
  ];
}

function textResponse(text: string): readonly ProviderEvent[] {
  return [
    { type: "text_delta", text },
    { type: "usage", inputTokens: 10, outputTokens: 2 },
    { type: "done", stopReason: "complete" },
  ];
}

class BenchmarkProvider implements ModelProvider {
  readonly id = "benchmark-scripted";
  readonly #steps = new Map<string, number>();
  #reviewRound = 0;
  reviewBranchCount = 0;
  companyToolResult = "";

  constructor(
    readonly blueprint: ReturnType<typeof createCompanyBenchmarkBlueprint>,
  ) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const sessionId = request.directContext!.authorization.sessionId;
    const step = this.#steps.get(sessionId) ?? 0;
    this.#steps.set(sessionId, step + 1);
    const context = JSON.stringify(request.messages);
    const tools = new Set(request.tools.map((tool) => tool.name));

    let response: readonly ProviderEvent[];
    if (tools.has("delegate_company_goal")) {
      if (step === 0) {
        const builder = this.blueprint.roles.find(
          (role) => role.executionProfileId === "implement_v2",
        )!;
        const reviewer = this.blueprint.roles.find(
          (role) => role.executionProfileId === "review_v2",
        )!;
        response = toolResponse({
          id: "delegate-goal",
          name: "delegate_company_goal",
          arguments: {
            objective: getCompanyBenchmarkScenario("alias_registry", 1).objective,
            assignments: [{
              id: "implementation",
              roleId: builder.id,
              parentAssignmentId: null,
              dependsOn: [],
              description: "Implement the bounded alias registry",
              prompt: "Implement both approved source files and return evidence.",
              acceptance: ["Both approved source files implement the contract."],
            }, {
              id: "independent-review",
              roleId: reviewer.id,
              parentAssignmentId: null,
              dependsOn: ["implementation"],
              description: "Review the complete staged alias registry",
              prompt: "Review the staged candidate and require concrete repairs.",
              acceptance: ["Approve only after every finding is repaired."],
            }],
          },
        });
      } else {
        this.companyToolResult = context;
        response = textResponse("The bounded company completed with review evidence.");
      }
    } else if (context.includes("Recurs Review agent")) {
      this.reviewBranchCount += 1;
      if (step === 0) {
        response = toolResponse({
          id: `read-review-${sessionId}`,
          name: "read_file",
          arguments: { path: "src/alias-path.js" },
        });
      } else {
        const requestChanges = this.#reviewRound++ === 0;
        response = textResponse(JSON.stringify(requestChanges
          ? {
              verdict: "request_changes",
              summary: "Uppercase alias names are accepted.",
              findings: [{
                path: "src/alias-path.js",
                problem: "The alias-name expression accepts uppercase names.",
                acceptance: "Accept lowercase ASCII alias names only.",
                evidence: ["The staged NAME expression contains A-Z."],
              }],
              evidence: ["Inspected the complete staged candidate."],
            }
          : {
              verdict: "approve",
              summary: "The lowercase-only repair satisfies the contract.",
              findings: [],
              evidence: ["Inspected the repaired staged candidate."],
            }));
      }
    } else if (context.includes("Recurs Repair agent")) {
      response = step === 0
        ? toolResponse({
            id: `read-repair-${sessionId}`,
            name: "read_file",
            arguments: { path: "src/alias-path.js" },
          })
        : step === 1
          ? toolResponse({
              id: `patch-repair-${sessionId}`,
              name: "apply_patch",
              arguments: {
                patch: replacePatch(
                  "src/alias-path.js",
                  flawedAliasPath,
                  correctAliasPath,
                ),
                files: [{
                  path: "src/alias-path.js",
                  expected_hash: "observed",
                }],
              },
            })
          : textResponse("Repaired the lowercase-only alias boundary.");
    } else {
      const companyImplement = context.includes("Recurs Implement agent");
      const aliasSource = companyImplement ? flawedAliasPath : correctAliasPath;
      if (step === 0) {
        response = [
          {
            type: "tool_call",
            call: {
              id: `read-path-${sessionId}`,
              name: "read_file",
              arguments: { path: "src/alias-path.js" },
            },
          },
          {
            type: "tool_call",
            call: {
              id: `read-registry-${sessionId}`,
              name: "read_file",
              arguments: { path: "src/alias-registry.js" },
            },
          },
          { type: "usage", inputTokens: 10, outputTokens: 2 },
          { type: "done", stopReason: "tool_calls" },
        ];
      } else if (step === 1) {
        const scenario = getCompanyBenchmarkScenario("alias_registry", 1);
        response = toolResponse({
          id: `patch-implementation-${sessionId}`,
          name: "apply_patch",
          arguments: {
            patch: [
              replacePatch(
                "src/alias-path.js",
                scenario.files.find((file) =>
                  file.path === "src/alias-path.js"
                )!.content,
                aliasSource,
              ),
              replacePatch(
                "src/alias-registry.js",
                scenario.files.find((file) =>
                  file.path === "src/alias-registry.js"
                )!.content,
                correctRegistry,
              ),
            ].join(""),
            files: [{
              path: "src/alias-path.js",
              expected_hash: "observed",
            }, {
              path: "src/alias-registry.js",
              expected_hash: "observed",
            }],
          },
        });
      } else {
        response = textResponse("Implemented the bounded alias registry.");
      }
    }
    for (const event of response) yield event;
  }
}

function route(
  role: CompanyBenchmarkRouteV1["role"],
): CompanyBenchmarkRouteV1 {
  return {
    role,
    providerId: "benchmark-scripted",
    adapterId: "injected:benchmark-scripted",
    connectionId: "injected:benchmark-scripted",
    modelId: "benchmark-model",
    reasoningEffort: null,
  };
}

describe("RuntimeCompanyBenchmarkAdapter", () => {
  it("classifies only typed execution failures without retaining messages", () => {
    const secret = "do-not-retain";
    expect(companyBenchmarkExecutionFailureCode(
      new RuntimeError("busy", secret),
    )).toBe("runtime_busy");
    expect(companyBenchmarkExecutionFailureCode(
      new AgentLoopError("provider_failed", secret),
    )).toBe("agent_provider_failed");
    expect(companyBenchmarkExecutionFailureCode(
      new CoordinatedRunError({
        domain: "provider",
        phase: "started",
        code: "rate_limited",
        safeMessage: secret,
        diagnosticId: secret,
        retryable: true,
      }),
    )).toBe("coordinated_rate_limited");
    expect(companyBenchmarkExecutionFailureCode(new Error(secret))).toBeNull();
  });

  it("fails closed when a saved campaign no longer matches scenario authority", () => {
    const scenario = getCompanyBenchmarkScenario("alias_registry", 1);
    const reference = {
      id: scenario.id,
      version: scenario.version,
      taskClass: scenario.taskClass,
      difficulty: scenario.difficulty,
      fixtureSha256: scenario.fixtureSha256,
      verifierId: scenario.verifierId,
      objectiveRevision: scenario.objectiveRevision,
    };

    expect(() =>
      assertCompanyBenchmarkScenarioAuthority(scenario, reference)
    ).not.toThrow();
    expect(() =>
      assertCompanyBenchmarkScenarioAuthority(scenario, {
        ...reference,
        verifierId: "alias_registry_hidden_v1",
      })
    ).toThrow("scenario does not match campaign authority");
    expect(() =>
      assertCompanyBenchmarkScenarioAuthority(scenario, {
        ...reference,
        fixtureSha256: "0".repeat(64),
      })
    ).toThrow("scenario does not match campaign authority");
  });

  it.each([
    [{ category: "write", resource: "team candidate apply", risk: "elevated" }, "allow_once"],
    [{ category: "shell", resource: "fixed Git worktree orchestration", risk: "normal" }, "allow_once"],
    [{ category: "shell", resource: "npm test", risk: "normal" }, "allow_once"],
    // Each approved triple rejects every one-field mutation.
    [{ category: "shell", resource: "team candidate apply", risk: "elevated" }, "deny"],
    [{ category: "write", resource: "team candidate apply extra", risk: "elevated" }, "deny"],
    [{ category: "write", resource: "team candidate apply", risk: "normal" }, "deny"],
    [{ category: "write", resource: "fixed Git worktree orchestration", risk: "normal" }, "deny"],
    [{ category: "shell", resource: "fixed Git worktree orchestration extra", risk: "normal" }, "deny"],
    [{ category: "shell", resource: "fixed Git worktree orchestration", risk: "elevated" }, "deny"],
    [{ category: "write", resource: "npm test", risk: "normal" }, "deny"],
    [{ category: "shell", resource: "npm test extra", risk: "normal" }, "deny"],
    [{ category: "shell", resource: "npm test", risk: "elevated" }, "deny"],
    [{ category: "read", resource: "src/alias-path.js", risk: "normal" }, "deny"],
    [{ category: "shell", resource: "npm test > results.txt", risk: "normal" }, "deny"],
    [{ category: "shell", resource: "npm test $(whoami)", risk: "destructive" }, "deny"],
    [{ category: "shell", resource: "sh -c npm test", risk: "destructive" }, "deny"],
    [{ category: "shell", resource: "git reset --hard", risk: "destructive" }, "deny"],
    [{ category: "shell", resource: "rm -rf .", risk: "destructive" }, "deny"],
    [{ category: "credential", resource: "env", risk: "elevated" }, "deny"],
    [{ category: "network", resource: "npm install", risk: "elevated" }, "deny"],
    [{ category: "network", resource: "https://example.com", risk: "elevated" }, "deny"],
    [{ category: "external_path", resource: "/Users/example", risk: "elevated" }, "deny"],
    [{ category: "shell", resource: "node --test", risk: "normal" }, "deny"],
    [{ category: "shell", resource: "npm test -- --watch", risk: "normal" }, "deny"],
    [{ category: "shell", resource: "Allow shell access to npm test?", risk: "normal" }, "deny"],
  ] satisfies readonly [PermissionIntent, "allow_once" | "deny"][])(
    "admits only the exact immutable benchmark intent %#",
    async (intent, expected) => {
      expect(await companyBenchmarkApprovalHandler.request(intent)).toBe(expected);
    },
  );

  it("runs byte-identical single and company arms through review, repair, synthesis, and hidden verification", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "recurs-company-benchmark-e2e-")),
    );
    roots.push(root);
    const scenario = getCompanyBenchmarkScenario("alias_registry", 1);
    const blueprint = createCompanyBenchmarkBlueprint(scenario);
    const campaign = parseCompanyBenchmarkCampaign({
      id: "campaign-e2e",
      version: 1,
      createdAt: "2026-07-24T00:00:02.000Z",
      scenario: {
        id: scenario.id,
        version: scenario.version,
        taskClass: scenario.taskClass,
        difficulty: scenario.difficulty,
        fixtureSha256: scenario.fixtureSha256,
        verifierId: scenario.verifierId,
        objectiveRevision: scenario.objectiveRevision,
      },
      harnessRevision: "recurs-alpha",
      launchProtocolRevision: "company-benchmark-launch-v1",
      operatingModeId: "balanced_v6",
      operatingModeVersion: 6,
      permissionMode: "approved_for_me",
      repetitions: 1,
      ceilings: {
        maxTrialSlots: 2,
        maxRequests: 40,
        maxReportedCostUsd: 0,
      },
      blueprint: {
        id: blueprint.id,
        revision: blueprint.revision,
        sha256: companyBenchmarkBlueprintDigest(blueprint),
      },
      baseline: {
        id: "baseline",
        kind: "single_agent",
        configuredRoutes: [route("parent")],
      },
      companyArms: [{
        id: "company-standard",
        kind: "company",
        configuredRoutes: [
          route("parent"),
          route("implement"),
          route("review"),
          route("repair"),
        ],
      }],
      armOrder: [{
        slotId: companyBenchmarkTrialSlotId("baseline", 1),
        armId: "baseline",
        repetition: 1,
      }, {
        slotId: companyBenchmarkTrialSlotId("company-standard", 1),
        armId: "company-standard",
        repetition: 1,
      }],
    });
    const provider = new BenchmarkProvider(blueprint);
    let adapterError: unknown;
    const adapter = new RuntimeCompanyBenchmarkAdapter({
      blueprint,
      createProvider: () => provider,
      processRunner: (command, args, options) => runProcess(
        command,
        args,
        { ...options, sandbox: undefined },
      ),
    });
    const trials = new FileCompanyBenchmarkTrialStore(
      path.join(root, "trials"),
    );
    const runner = new CompanyBenchmarkRunner({
      trials,
      summaries: new FileCompanyBenchmarkSummaryStore(
        path.join(root, "summaries"),
      ),
      reservations: new FileCompanyBenchmarkSlotReservationStore(
        path.join(root, "reservations"),
      ),
      settlements: new FileCompanyBenchmarkSlotSettlementStore(
        path.join(root, "settlements"),
      ),
      adapter: {
        async execute(input) {
          try {
            return await adapter.execute(input);
          } catch (error) {
            adapterError = error;
            throw error;
          }
        },
      },
    });

    const summary = await runner.run(campaign);
    const results = await trials.list();
    const baseline = results.find((trial) => trial.armKind === "single_agent")!;
    const company = results.find((trial) => trial.armKind === "company")!;

    expect(
      summary.comparablePairs,
      `${String(adapterError)}\nreview branches ${provider.reviewBranchCount}\n${provider.companyToolResult}\n${
        JSON.stringify(results, null, 2)
      }`,
    ).toHaveLength(1);
    expect(baseline.verification.status).toBe("passed");
    expect(company.verification.status).toBe("passed");
    expect(company.review).toMatchObject({
      attempts: 2,
      changesRequested: 1,
      approved: 1,
      finalVerdict: "approved",
      findings: 1,
    });
    expect(company.roles.find((role) => role.role === "review")?.attempts).toBe(
      3,
    );
    expect(company.repairRounds).toBe(1);
    expect(company.activatedRoutes.map((item) => item.role)).toEqual([
      "parent", "implement", "review", "repair",
    ]);
    expect(company.overlap.repairTouchedImplementationPaths).toEqual([
      "src/alias-path.js",
    ]);
    expect(company.usage.requestsUsed).toBeGreaterThan(
      baseline.usage.requestsUsed,
    );
    expect(company.usage.costCoverage).toBe("none");
    expect(company.interventions.userInputRequests).toBe(0);
    expect(summary.correctnessEligibility).toBe("insufficient_evidence");
    expect("winner" in summary).toBe(false);
  }, 90_000);
});
