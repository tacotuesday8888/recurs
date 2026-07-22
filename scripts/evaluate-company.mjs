#!/usr/bin/env node

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { FileConnectionRegistry } from "../packages/app/dist/index.js";
import {
  createStandaloneCompanyOnboarding,
  evaluateCompanyFormation,
  renderCompanyEvaluationReport,
} from "../packages/cli/dist/index.js";
import { ScriptedProvider } from "../packages/providers/dist/index.js";

function usage() {
  return [
    "Usage: npm run eval:company -- [--scenario company_formation_v1] [--json]",
    "       [--configured --allow-network]",
    "       [--project <path>] [--recurs-home <path>]",
    "",
    "Offline mode is deterministic and performs no network requests.",
    "Configured mode uses the primary direct/local connection already saved by Recurs.",
  ].join("\n");
}

function parseArguments(argv) {
  const parsed = {
    mode: "offline",
    allowNetwork: false,
    json: false,
    scenario: "company_formation_v1",
    project: process.cwd(),
    recursHome: process.env.RECURS_HOME ?? path.join(homedir(), ".recurs"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--configured") parsed.mode = "configured";
    else if (argument === "--allow-network") parsed.allowNetwork = true;
    else if (argument === "--json") parsed.json = true;
    else if (
      argument === "--project" || argument === "--recurs-home" ||
      argument === "--scenario"
    ) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(usage());
      parsed[argument === "--project"
        ? "project"
        : argument === "--recurs-home"
          ? "recursHome"
          : "scenario"] = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
    }
  }
  if (parsed.mode === "configured" && !parsed.allowNetwork) {
    throw new Error(
      "Configured evaluation requires --allow-network because it may contact the selected provider.",
    );
  }
  if (parsed.mode === "offline" && parsed.allowNetwork) {
    throw new Error("--allow-network is only valid with --configured.");
  }
  if (parsed.scenario !== "company_formation_v1") {
    throw new Error(`Unknown company evaluation scenario: ${parsed.scenario}`);
  }
  return parsed;
}

function response(text) {
  return [
    { type: "text_delta", text },
    { type: "usage", inputTokens: 10, outputTokens: 5 },
    { type: "done", stopReason: "complete" },
  ];
}

function offlineProvider() {
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
    response("The repository has a package manifest and a CLI workspace."),
    response(JSON.stringify({
      kind: "propose",
      project: {
        type: "existing_project",
        stage: "active",
        purpose: "Build a dependable open-source coding-agent company for software maintainers.",
        users: ["Software maintainers"],
        successCriteria: [
          "Every implementation is independently reviewed with attributable evidence.",
        ],
        constraints: [
          "Delegated agents remain within inherited authority and shared budgets.",
        ],
        risks: ["Unbounded or misleading delegation"],
        architecturePreferences: ["Reuse durable runtime and provider seams."],
        deploymentTargets: ["CLI"],
        repository: {
          inspected: true,
          markers: ["package.json"],
          evidence: [{
            path: "package.json",
            finding: "The repository has a package manifest and a CLI workspace.",
          }],
        },
      },
      initialGoal: "Deliver one bounded, independently reviewed company-directed coding change.",
      roadmap: [
        "Understand the repository and authority boundaries.",
        "Implement and independently review a bounded goal.",
      ],
    })),
  ], "scripted-evaluation");
}

async function copyConfiguredConnection(sourceRoot, targetRoot) {
  const document = await new FileConnectionRegistry(sourceRoot).inspect();
  const connection = document.connections.find(
    (candidate) => candidate.id === document.primaryConnectionId,
  );
  if (connection === undefined) {
    throw new Error("Recurs has no primary provider connection to evaluate.");
  }
  if (
    connection.kind !== "local_openai_compatible" &&
    connection.kind !== "environment_model_provider"
  ) {
    throw new Error(
      "Configured evaluation currently requires a direct BYOK or local connection because company formation uses Recurs's restricted read-only tool boundary.",
    );
  }
  const target = new FileConnectionRegistry(targetRoot);
  await target.commit(0, (draft) => {
    draft.primaryConnectionId = connection.id;
    draft.connections.push(JSON.parse(JSON.stringify(connection)));
  });
  return connection;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const evaluationHome = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-company-evaluation-")),
  );
  try {
    let provider;
    let backend;
    if (options.mode === "offline") {
      provider = offlineProvider();
      backend = { providerId: provider.id, modelId: "offline-baseline" };
    } else {
      const connection = await copyConfiguredConnection(
        path.resolve(options.recursHome),
        evaluationHome,
      );
      backend = {
        providerId: connection.providerId,
        modelId: connection.modelId,
      };
    }
    const service = await createStandaloneCompanyOnboarding({
      permissionMode: "approved_for_me",
      operatingModeId: "balanced_v6",
      repositoryConsent: true,
    }, {
      cwd: path.resolve(options.project),
      dataDirectory: evaluationHome,
      skillHomeDirectory: evaluationHome,
      environment: process.env,
      ...(provider === undefined ? {} : { provider }),
    });
    const report = await evaluateCompanyFormation({
      service,
      mode: options.mode,
      backend,
    });
    process.stdout.write(options.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${renderCompanyEvaluationReport(report)}\n`);
    if (report.status === "failed" || report.status === "cancelled") {
      process.exitCode = 1;
    }
  } finally {
    await rm(evaluationHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Evaluation failed"}\n`);
  process.exitCode = 1;
});
