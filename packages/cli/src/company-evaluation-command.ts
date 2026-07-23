import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { FileConnectionRegistry } from "@recurs/app";
import type {
  CompanyEvaluationReportV1,
  NativeOpenAIResponsesPort,
} from "@recurs/contracts";
import { ScriptedProvider } from "@recurs/providers";

import { createStandaloneCompanyOnboarding } from "./assembly.js";
import {
  evaluateCompanyFormation,
  type CompanyEvaluationProgress,
} from "./company-evaluation.js";
import { evaluateStoredCompanyGoal } from "./company-evaluation-store.js";

export const COMPANY_EVALUATION_USAGE = [
  "Usage: recurs eval company --list [--json]",
  "       recurs eval company [--scenario company_formation_v1] [--json]",
  "       recurs eval company --configured --allow-network [--connection <id>] [--json]",
  "       recurs eval company --scenario company_goal_execution_v1 --run <id> [--json]",
].join("\n");

export const COMPANY_EVALUATION_SCENARIOS = Object.freeze([
  Object.freeze({
    id: "company_formation_v1" as const,
    version: 1 as const,
    network: "optional_explicit" as const,
    description: "Form and approve a bounded company in isolated evaluation state.",
  }),
  Object.freeze({
    id: "company_goal_execution_v1" as const,
    version: 1 as const,
    network: "never" as const,
    description: "Score one existing durable company goal without resuming it.",
  }),
]);

export type CompanyEvaluationScenarioId =
  (typeof COMPANY_EVALUATION_SCENARIOS)[number]["id"];

export type CompanyEvaluationCommandOptions =
  | { readonly action: "list"; readonly json: boolean }
  | {
      readonly action: "run";
      readonly scenario: "company_formation_v1";
      readonly mode: "offline" | "configured";
      readonly allowNetwork: boolean;
      readonly connectionId: string | null;
      readonly json: boolean;
    }
  | {
      readonly action: "run";
      readonly scenario: "company_goal_execution_v1";
      readonly runId: string;
      readonly json: boolean;
    };

export type CompanyEvaluationRunOptions = Extract<
  CompanyEvaluationCommandOptions,
  { readonly action: "run" }
>;

export class CompanyEvaluationArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyEvaluationArgumentError";
  }
}

const exactId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function valueAfter(argv: readonly string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--") || !exactId.test(value)) {
    throw new CompanyEvaluationArgumentError(COMPANY_EVALUATION_USAGE);
  }
  return value;
}

export function renderCompanyEvaluationScenarios(json: boolean): string {
  if (json) {
    return JSON.stringify({
      version: 1,
      scenarios: COMPANY_EVALUATION_SCENARIOS,
    });
  }
  return [
    "Company evaluation scenarios",
    ...COMPANY_EVALUATION_SCENARIOS.map((scenario) =>
      `${scenario.id} v${scenario.version} · network ${scenario.network}: ${scenario.description}`
    ),
  ].join("\n");
}

export function parseCompanyEvaluationCommand(
  argv: readonly string[],
): CompanyEvaluationCommandOptions {
  if (argv[0] !== "company") {
    throw new CompanyEvaluationArgumentError(COMPANY_EVALUATION_USAGE);
  }
  let scenario: string = "company_formation_v1";
  let configured = false;
  let allowNetwork = false;
  let json = false;
  let list = false;
  let connectionId: string | null = null;
  let runId: string | null = null;
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || seen.has(argument)) {
      throw new CompanyEvaluationArgumentError(COMPANY_EVALUATION_USAGE);
    }
    seen.add(argument);
    if (argument === "--configured") configured = true;
    else if (argument === "--allow-network") allowNetwork = true;
    else if (argument === "--json") json = true;
    else if (argument === "--list") list = true;
    else if (argument === "--scenario") {
      scenario = valueAfter(argv, index);
      index += 1;
    } else if (argument === "--connection") {
      connectionId = valueAfter(argv, index);
      index += 1;
    } else if (argument === "--run") {
      runId = valueAfter(argv, index);
      index += 1;
    } else {
      throw new CompanyEvaluationArgumentError(
        `Unknown company evaluation argument: ${argument ?? ""}`,
      );
    }
  }
  if (list) {
    if (configured || allowNetwork || connectionId !== null || runId !== null ||
      scenario !== "company_formation_v1") {
      throw new CompanyEvaluationArgumentError(
        "--list can be combined only with --json.",
      );
    }
    return { action: "list", json };
  }
  if (scenario !== "company_formation_v1" &&
    scenario !== "company_goal_execution_v1") {
    throw new CompanyEvaluationArgumentError(
      `Unknown company evaluation scenario: ${scenario}`,
    );
  }
  if (scenario === "company_goal_execution_v1") {
    if (runId === null) {
      throw new CompanyEvaluationArgumentError(
        "company_goal_execution_v1 requires --run <exact-run-id>.",
      );
    }
    if (configured || allowNetwork || connectionId !== null) {
      throw new CompanyEvaluationArgumentError(
        "Stored company goal evaluation is read-only and accepts no provider or network flags.",
      );
    }
    return { action: "run", scenario, runId, json };
  }
  if (runId !== null) {
    throw new CompanyEvaluationArgumentError(
      "--run is valid only with company_goal_execution_v1.",
    );
  }
  if (configured && !allowNetwork) {
    throw new CompanyEvaluationArgumentError(
      "Configured evaluation requires --allow-network because it may contact the selected provider.",
    );
  }
  if (!configured && allowNetwork) {
    throw new CompanyEvaluationArgumentError(
      "--allow-network is only valid with --configured.",
    );
  }
  if (!configured && connectionId !== null) {
    throw new CompanyEvaluationArgumentError(
      "--connection is only valid with --configured.",
    );
  }
  return {
    action: "run",
    scenario,
    mode: configured ? "configured" : "offline",
    allowNetwork,
    connectionId,
    json,
  };
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

export async function copyConfiguredEvaluationConnection(
  sourceRoot: string,
  targetRoot: string,
  connectionId: string | null,
) {
  const document = await new FileConnectionRegistry(sourceRoot).inspect();
  const connection = document.connections.find(
    (candidate) => candidate.id === (connectionId ?? document.primaryConnectionId),
  );
  if (connection === undefined) {
    throw new Error("The selected provider connection is unavailable.");
  }
  if (connection.kind === "delegated_agent") {
    throw new Error(
      "Delegated subscription runtimes are not yet used for company-formation evaluation; choose a supported direct API or local model connection.",
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
  options: CompanyEvaluationRunOptions,
  dependencies: CompanyEvaluationCommandDependencies,
): Promise<CompanyEvaluationReportV1> {
  if (options.scenario === "company_goal_execution_v1") {
    return await evaluateStoredCompanyGoal({
      projectRoot: dependencies.projectRoot,
      dataDirectory:
        dependencies.dataDirectory ?? path.join(homedir(), ".recurs"),
      runId: options.runId,
      ...(dependencies.signal === undefined
        ? {}
        : { signal: dependencies.signal }),
      ...(dependencies.onProgress === undefined
        ? {}
        : { onProgress: dependencies.onProgress }),
    });
  }
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
      const connection = await copyConfiguredEvaluationConnection(
        dependencies.dataDirectory ?? path.join(homedir(), ".recurs"),
        evaluationHome,
        options.connectionId,
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
      ...(options.connectionId === null
        ? {}
        : { connectionId: options.connectionId }),
      ...(dependencies.nativeOpenAIResponses === undefined
        ? {}
        : { nativeOpenAIResponses: dependencies.nativeOpenAIResponses }),
      ...(provider === undefined ? {} : { provider }),
    });
    return await evaluateCompanyFormation({
      service,
      mode: options.mode,
      backend,
      ...(dependencies.signal === undefined
        ? {}
        : { signal: dependencies.signal }),
      ...(dependencies.onProgress === undefined
        ? {}
        : { onProgress: dependencies.onProgress }),
    });
  } finally {
    await rm(evaluationHome, { recursive: true, force: true });
  }
}

export interface CompanyEvaluationCommandDependencies {
  readonly projectRoot: string;
  readonly dataDirectory?: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly nativeOpenAIResponses?: NativeOpenAIResponsesPort;
  readonly signal?: AbortSignal;
  readonly onProgress?: (
    progress: CompanyEvaluationProgress,
  ) => void | Promise<void>;
}
