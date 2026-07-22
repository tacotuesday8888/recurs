import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ScriptedProvider } from "@recurs/providers";

import { createStandaloneCompanyOnboarding } from "../src/assembly.js";
import {
  evaluateCompanyFormation,
  renderCompanyEvaluationReport,
} from "../src/company-evaluation.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

function response(text: string, inputTokens = 10, outputTokens = 5) {
  return [
    { type: "text_delta" as const, text },
    { type: "usage" as const, inputTokens, outputTokens },
    { type: "done" as const, stopReason: "complete" as const },
  ];
}

function scriptedProvider() {
  return new ScriptedProvider([
    response(JSON.stringify({
      kind: "question",
      id: "product_outcome",
      question: "What should this company reliably deliver?",
    })),
    response(JSON.stringify({
      kind: "research",
      assignments: [{
        key: "package_shape",
        description: "Inspect the package manifest.",
        prompt: "Read package.json and identify the repository shape.",
      }],
    })),
    [
      {
        type: "tool_call",
        call: {
          id: "read-package",
          name: "read_file",
          arguments: { path: "package.json" },
        },
      },
      { type: "done", stopReason: "tool_calls" },
    ],
    response("The repository is a TypeScript workspace with a CLI package."),
    response(JSON.stringify({
      kind: "propose",
      project: {
        type: "existing_project",
        stage: "active",
        purpose: "Build Recurs as a dependable open-source coding-agent company for software maintainers.",
        users: ["Software maintainers"],
        successCriteria: [
          "Every implementation is independently reviewed with attributable evidence.",
        ],
        constraints: [
          "Delegated agents must remain within inherited authority and shared budgets.",
        ],
        risks: ["Unbounded or misleading delegation"],
        architecturePreferences: ["Reuse durable runtime and provider seams."],
        deploymentTargets: ["Recurs CLI"],
        repository: {
          inspected: true,
          markers: ["package.json"],
          evidence: [{
            path: "package.json",
            finding: "The repository is a TypeScript workspace with a CLI package.",
          }],
        },
      },
      initialGoal: "Deliver one bounded, independently reviewed company-directed coding change.",
      roadmap: [
        "Understand the current repository and authority boundaries.",
        "Implement and independently review the first bounded goal.",
      ],
    })),
  ], "scripted-evaluation");
}

async function fixture(provider: ScriptedProvider) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-company-evaluation-")),
  );
  roots.push(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "evaluation-fixture",
    workspaces: ["packages/*"],
  }));
  const service = await createStandaloneCompanyOnboarding({
    permissionMode: "approved_for_me",
    operatingModeId: "balanced_v6",
    repositoryConsent: true,
  }, {
    cwd: root,
    dataDirectory: path.join(root, "data"),
    skillHomeDirectory: path.join(root, "skill-home"),
    provider,
  });
  return { root, service };
}

describe("company formation evaluation", () => {
  it("runs the real restricted onboarding path and returns a safe report", async () => {
    const provider = scriptedProvider();
    const setup = await fixture(provider);
    const timestamps = [
      "2026-07-22T00:00:00.000Z",
      "2026-07-22T00:00:01.250Z",
    ];
    const report = await evaluateCompanyFormation({
      service: setup.service,
      mode: "offline",
      backend: { providerId: provider.id, modelId: "offline-baseline" },
      now: () => timestamps.shift()!,
    });

    expect(report).toMatchObject({
      status: "passed",
      latencyMs: 1_250,
      usage: { requestsUsed: 5, reportedCostUsd: 0, source: "provider" },
    });
    expect(report.rubric.find((item) => item.dimension === "synthesis"))
      .toMatchObject({ status: "not_applicable" });
    expect(provider.requests).toHaveLength(5);
    expect(provider.requests.every((request) => request.tools.every((tool) =>
      !["apply_patch", "run_command", "web_fetch"].includes(tool.name)
    ))).toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("What should this company");
    expect(serialized).not.toContain("Build Recurs as");
    expect(renderCompanyEvaluationReport(report)).toContain("Status: passed");
  });

  it("fails safely on invalid model output without persisting raw output", async () => {
    const secret = `sk-proj-${"q".repeat(30)}`;
    const provider = new ScriptedProvider([
      response(`not-json ${secret}`),
    ], "scripted-evaluation");
    const setup = await fixture(provider);
    const timestamps = [
      "2026-07-22T00:00:00.000Z",
      "2026-07-22T00:00:00.100Z",
    ];

    const report = await evaluateCompanyFormation({
      service: setup.service,
      mode: "offline",
      backend: { providerId: provider.id, modelId: "offline-baseline" },
      now: () => timestamps.shift()!,
    });

    expect(report.status).toBe("failed");
    expect(report.failures).toEqual([
      expect.objectContaining({ code: "evaluation_failed" }),
    ]);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("reports pre-start cancellation truthfully", async () => {
    const provider = scriptedProvider();
    const setup = await fixture(provider);
    const controller = new AbortController();
    controller.abort();
    const timestamps = [
      "2026-07-22T00:00:00.000Z",
      "2026-07-22T00:00:00.000Z",
    ];

    const report = await evaluateCompanyFormation({
      service: setup.service,
      mode: "configured",
      backend: { providerId: provider.id, modelId: "configured-model" },
      signal: controller.signal,
      now: () => timestamps.shift()!,
    });

    expect(report).toMatchObject({
      status: "cancelled",
      usage: { requestsUsed: 0, reportedCostUsd: null, source: "unknown" },
      failures: [{ code: "cancelled" }],
    });
    expect(provider.requests).toHaveLength(0);
  });
});
