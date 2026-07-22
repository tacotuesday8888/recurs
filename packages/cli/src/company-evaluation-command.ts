import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { FileConnectionRegistry } from "@recurs/app";
import type { CompanyEvaluationReportV1 } from "@recurs/contracts";
import { ScriptedProvider } from "@recurs/providers";

import { createStandaloneCompanyOnboarding } from "./assembly.js";
import { evaluateCompanyFormation } from "./company-evaluation.js";

export const COMPANY_EVALUATION_USAGE = [
  "Usage: recurs eval company [--scenario company_formation_v1] [--json]",
  "       recurs eval company --configured --allow-network [--json]",
].join("\n");

export interface CompanyEvaluationCommandOptions {
  readonly scenario: "company_formation_v1";
  readonly mode: "offline" | "configured";
  readonly allowNetwork: boolean;
  readonly json: boolean;
}

export class CompanyEvaluationArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyEvaluationArgumentError";
  }
}

export function parseCompanyEvaluationCommand(
  argv: readonly string[],
): CompanyEvaluationCommandOptions {
  if (argv[0] !== "company") {
    throw new CompanyEvaluationArgumentError(COMPANY_EVALUATION_USAGE);
  }
  let scenario = "company_formation_v1";
  let mode: CompanyEvaluationCommandOptions["mode"] = "offline";
  let allowNetwork = false;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--configured") mode = "configured";
    else if (argument === "--allow-network") allowNetwork = true;
    else if (argument === "--json") json = true;
    else if (argument === "--scenario") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CompanyEvaluationArgumentError(COMPANY_EVALUATION_USAGE);
      }
      scenario = value;
      index += 1;
    } else {
      throw new CompanyEvaluationArgumentError(
        `Unknown company evaluation argument: ${argument ?? ""}`,
      );
    }
  }
  if (scenario !== "company_formation_v1") {
    throw new CompanyEvaluationArgumentError(
      `Unknown company evaluation scenario: ${scenario}`,
    );
  }
  if (mode === "configured" && !allowNetwork) {
    throw new CompanyEvaluationArgumentError(
      "Configured evaluation requires --allow-network because it may contact the selected provider.",
    );
  }
  if (mode === "offline" && allowNetwork) {
    throw new CompanyEvaluationArgumentError(
      "--allow-network is only valid with --configured.",
    );
  }
  return { scenario, mode, allowNetwork, json };
}

function response(text: string) {
  return [
    { type: "text_delta" as const, text },
    { type: "usage" as const, inputTokens: 10, outputTokens: 5 },
    { type: "done" as const, stopReason: "complete" as const },
  ];
}

function offlineProvider(): ScriptedProvider {
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
        type: "tool_call" as const,
        call: {
          id: "read-package",
          name: "read_file",
          arguments: { path: "package.json" },
        },
      },
      { type: "done" as const, stopReason: "tool_calls" as const },
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

async function copyConfiguredConnection(
  sourceRoot: string,
  targetRoot: string,
) {
  const document = await new FileConnectionRegistry(sourceRoot).inspect();
  const connection = document.connections.find(
    (candidate) => candidate.id === document.primaryConnectionId,
  );
  if (connection === undefined) {
    throw new Error("Recurs has no primary provider connection to evaluate.");
  }
  if (connection.kind !== "local_openai_compatible" &&
    connection.kind !== "environment_model_provider") {
    throw new Error(
      "Configured evaluation requires a direct BYOK or local connection.",
    );
  }
  const target = new FileConnectionRegistry(targetRoot);
  await target.commit(0, (draft) => {
    draft.primaryConnectionId = connection.id;
    draft.connections.push(structuredClone(connection));
  });
  return connection;
}

export async function runCompanyEvaluationCommand(
  options: CompanyEvaluationCommandOptions,
  dependencies: {
    readonly projectRoot: string;
    readonly dataDirectory?: string;
    readonly environment?: Readonly<NodeJS.ProcessEnv>;
    readonly signal?: AbortSignal;
  },
): Promise<CompanyEvaluationReportV1> {
  const projectRoot = await realpath(dependencies.projectRoot);
  const evaluationHome = await realpath(
    await mkdtemp(path.join(tmpdir(), "recurs-company-evaluation-")),
  );
  try {
    let provider: ScriptedProvider | undefined;
    let backend: { readonly providerId: string; readonly modelId: string };
    if (options.mode === "offline") {
      provider = offlineProvider();
      backend = { providerId: provider.id, modelId: "offline-baseline" };
    } else {
      const connection = await copyConfiguredConnection(
        dependencies.dataDirectory ?? path.join(homedir(), ".recurs"),
        evaluationHome,
      );
      backend = {
        providerId: connection.providerId,
        modelId: connection.modelId,
      };
    }
    const environment = dependencies.environment ?? process.env;
    const service = await createStandaloneCompanyOnboarding({
      permissionMode: "approved_for_me",
      operatingModeId: "balanced_v6",
      repositoryConsent: true,
    }, {
      cwd: projectRoot,
      dataDirectory: evaluationHome,
      skillHomeDirectory: evaluationHome,
      environment,
      ...(provider === undefined ? {} : { provider }),
    });
    return await evaluateCompanyFormation({
      service,
      mode: options.mode,
      backend,
      ...(dependencies.signal === undefined
        ? {}
        : { signal: dependencies.signal }),
    });
  } finally {
    await rm(evaluationHome, { recursive: true, force: true });
  }
}
