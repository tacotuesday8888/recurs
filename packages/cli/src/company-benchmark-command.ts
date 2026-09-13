import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  FileConnectionRegistry,
  type ConnectionRecord,
  type ConnectionRegistryDocument,
} from "@recurs/app";
import {
  RECURS_VERSION,
  companyBenchmarkTrialSlotId,
  deriveCompanyBenchmarkFailureAttribution,
  getOperatingModePolicy,
  parseCompanyBenchmarkCampaign,
  type CompanyBenchmarkCampaignSummaryV1,
  type CompanyBenchmarkCampaignV1,
  type CompanyBenchmarkFailureAttributionV1,
  type CompanyBenchmarkRouteV1,
  type CompanyBenchmarkTrialV1,
} from "@recurs/contracts";
import {
  COMPANY_BENCHMARK_SCENARIOS,
  CompanyBenchmarkRunner,
  FileCompanyBenchmarkCampaignStore,
  FileCompanyBenchmarkSlotReservationStore,
  FileCompanyBenchmarkSlotSettlementStore,
  FileCompanyBenchmarkSummaryStore,
  FileCompanyBenchmarkTrialStore,
  createCompanyBenchmarkBlueprint,
  assertCompanyBenchmarkBlueprintFitsOperatingMode,
  getCompanyBenchmarkScenario,
  type CompanyBenchmarkExecutionAdapter,
} from "@recurs/core";

import {
  RuntimeCompanyBenchmarkAdapter,
  companyBenchmarkBlueprintDigest,
} from "./company-benchmark-execution.js";
import { CodexControlBenchmarkAdapter, preflightCodexControlCampaign } from "./company-benchmark-codex-control.js";

const MODE_ID = "balanced_v6";
const REQUESTS_PER_SLOT = 96;
const REPORTED_COST_USD_PER_SLOT = 3;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export const COMPANY_BENCHMARK_USAGE = [
  "Usage: recurs benchmark company --list [--json]",
  "       recurs benchmark company --configured --allow-network [--scenario <id>] [--connection <id>] [--parent-connection <id>] [--implement-connection <id>] [--review-connection <id>] [--repair-connection <id>] [--repetitions 1|2|3] [--control codex] [--compare-all-strong] [--artifacts <directory>] [--json]",
  "       recurs benchmark company --resume <campaign-id> --allow-network [--artifacts <directory>] [--json]",
].join("\n");

export type CompanyBenchmarkCommandOptions =
  | { readonly action: "list"; readonly json: boolean }
  | {
      readonly action: "run";
      readonly artifactsDirectory?: string;
      readonly scenarioId: string;
      readonly connectionId: string | null;
      readonly roleConnectionIds: Readonly<
        Partial<Record<CompanyBenchmarkRouteV1["role"], string>>
      >;
      readonly repetitions: 1 | 2 | 3;
      readonly compareAllStrong: boolean;
      readonly control?: "codex";
      readonly json: boolean;
    }
  | {
      readonly action: "resume";
      readonly artifactsDirectory?: string;
      readonly campaignId: string;
      readonly json: boolean;
    };

export interface CompanyBenchmarkCommandReport {
  readonly version: 2;
  readonly campaign: CompanyBenchmarkCampaignV1;
  readonly summary: CompanyBenchmarkCampaignSummaryV1;
  readonly trials: readonly CompanyBenchmarkTrialV1[];
  readonly attribution: CompanyBenchmarkFailureAttributionV1;
}

export interface CompanyBenchmarkProgress {
  readonly campaignId: string;
  readonly slotId: string | null;
  readonly completedSlots: number;
  readonly totalSlots: number;
  readonly message: string;
}

export class CompanyBenchmarkArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyBenchmarkArgumentError";
  }
}

function argumentValue(argv: readonly string[], index: number): string {
  const value = argv[index + 1];
  if (value === undefined || !SAFE_ID.test(value)) {
    throw new CompanyBenchmarkArgumentError(COMPANY_BENCHMARK_USAGE);
  }
  return value;
}

export function parseCompanyBenchmarkCommand(
  argv: readonly string[],
): CompanyBenchmarkCommandOptions {
  if (argv[0] !== "company") {
    throw new CompanyBenchmarkArgumentError(COMPANY_BENCHMARK_USAGE);
  }
  let artifactsDirectory: string | undefined;
  let list = false;
  let configured = false;
  let allowNetwork = false;
  let json = false;
  let connectionId: string | null = null;
  const roleConnectionIds: Partial<
    Record<CompanyBenchmarkRouteV1["role"], string>
  > = {};
  let scenarioId = "alias_registry";
  let repetitions: 1 | 2 | 3 = 3;
  let compareAllStrong = false;
  let control: "codex" | undefined;
  let resume: string | null = null;
  const seen = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || seen.has(argument)) {
      throw new CompanyBenchmarkArgumentError(COMPANY_BENCHMARK_USAGE);
    }
    seen.add(argument);
    if (argument === "--list") list = true;
    else if (argument === "--configured") configured = true;
    else if (argument === "--allow-network") allowNetwork = true;
    else if (argument === "--compare-all-strong") compareAllStrong = true;
    else if (argument === "--json") json = true;
    else if (argument === "--control") {
      if (argumentValue(argv, index) !== "codex") throw new CompanyBenchmarkArgumentError("--control must be codex");
      control = "codex";
      index += 1;
    }
    else if (argument === "--artifacts") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--") || value.trim().length === 0 || value.includes("\0")) {
        throw new CompanyBenchmarkArgumentError("--artifacts requires an output directory.");
      }
      artifactsDirectory = path.resolve(value);
      index += 1;
    }
    else if (argument === "--scenario") {
      scenarioId = argumentValue(argv, index);
      index += 1;
    }
    else if (argument === "--connection") {
      connectionId = argumentValue(argv, index);
      index += 1;
    } else if (
      argument === "--parent-connection" ||
      argument === "--implement-connection" ||
      argument === "--review-connection" ||
      argument === "--repair-connection"
    ) {
      const role = argument.slice(2, -"-connection".length) as
        CompanyBenchmarkRouteV1["role"];
      roleConnectionIds[role] = argumentValue(argv, index);
      index += 1;
    } else if (argument === "--resume") {
      resume = argumentValue(argv, index);
      index += 1;
    } else if (argument === "--repetitions") {
      const value = argumentValue(argv, index);
      if (value !== "1" && value !== "2" && value !== "3") {
        throw new CompanyBenchmarkArgumentError(
          "--repetitions must be 1, 2, or 3.",
        );
      }
      repetitions = Number(value) as 1 | 2 | 3;
      index += 1;
    } else {
      throw new CompanyBenchmarkArgumentError(
        `Unknown company benchmark argument: ${argument}`,
      );
    }
  }
  if (list) {
    if (artifactsDirectory !== undefined || configured || allowNetwork || connectionId !== null ||
      Object.keys(roleConnectionIds).length > 0 ||
      resume !== null || repetitions !== 3 || scenarioId !== "alias_registry" ||
      compareAllStrong || control !== undefined) {
      throw new CompanyBenchmarkArgumentError(
        "--list can be combined only with --json.",
      );
    }
    return { action: "list", json };
  }
  if (!allowNetwork) {
    throw new CompanyBenchmarkArgumentError(
      "Company proof requires --allow-network because it runs saved provider connections.",
    );
  }
  if (resume !== null) {
    if (
      configured || connectionId !== null ||
      Object.keys(roleConnectionIds).length > 0 || repetitions !== 3 ||
      scenarioId !== "alias_registry" || compareAllStrong || control !== undefined
    ) {
      throw new CompanyBenchmarkArgumentError(
        "--resume uses the frozen campaign and accepts only --allow-network, --artifacts and --json.",
      );
    }
    return { action: "resume", campaignId: resume, json, ...(artifactsDirectory === undefined ? {} : { artifactsDirectory }) };
  }
  if (!configured) {
    throw new CompanyBenchmarkArgumentError(
      "A new Company proof requires --configured --allow-network.",
    );
  }
  if (!COMPANY_BENCHMARK_SCENARIOS.some((scenario) =>
    scenario.id === scenarioId
  )) {
    throw new CompanyBenchmarkArgumentError(
      `Unknown company benchmark scenario: ${scenarioId}`,
    );
  }
  return {
    action: "run",
    ...(artifactsDirectory === undefined ? {} : { artifactsDirectory }),
    scenarioId,
    connectionId,
    roleConnectionIds,
    repetitions,
    compareAllStrong,
    ...(control === undefined ? {} : { control }),
    json,
  };
}

export function renderCompanyBenchmarkScenarios(json: boolean): string {
  const scenarios = COMPANY_BENCHMARK_SCENARIOS.filter((scenario) => getCompanyBenchmarkScenario(scenario.id) === scenario).map((scenario) => ({
    id: scenario.id,
    version: scenario.version,
    taskClass: scenario.taskClass,
    difficulty: scenario.difficulty,
    verifierId: scenario.verifierId,
  }));
  return json
    ? JSON.stringify({ version: 1, scenarios })
    : [
        "Company proof scenarios",
        ...scenarios.map((scenario) =>
          `${scenario.id} v${scenario.version} · ${scenario.difficulty} ${scenario.taskClass} · external verifier ${scenario.verifierId}`
        ),
      ].join("\n");
}

function route(
  role: CompanyBenchmarkRouteV1["role"],
  connection: ConnectionRecord,
): CompanyBenchmarkRouteV1 {
  return {
    role,
    providerId: connection.providerId,
    adapterId: connection.adapterId,
    connectionId: connection.id,
    modelId: connection.modelId,
    reasoningEffort: "reasoningEffort" in connection
      ? connection.reasoningEffort ?? null
      : null,
  };
}

function requireCodexConnection(
  document: ConnectionRegistryDocument,
  id: string | null,
): ConnectionRecord {
  const connection = document.connections.find((candidate) =>
    candidate.id === (id ?? document.primaryConnectionId)
  );
  if (connection === undefined) {
    throw new Error("The selected Company proof connection is unavailable.");
  }
  if (connection.kind !== "delegated_agent" ||
    connection.adapterId !== "codex-app-server") {
    throw new Error(
      "Company Proof Alpha currently requires a reviewed Codex app-server connection.",
    );
  }
  return connection;
}

export function createConfiguredCompanyBenchmarkCampaign(input: {
  readonly document: ConnectionRegistryDocument;
  readonly scenarioId: string;
  readonly connectionId: string | null;
  readonly roleConnectionIds?: Readonly<
    Partial<Record<CompanyBenchmarkRouteV1["role"], string>>
  >;
  readonly repetitions: 1 | 2 | 3;
  readonly compareAllStrong: boolean;
  readonly control?: "codex";
  readonly campaignId: string;
  readonly createdAt: string;
}): CompanyBenchmarkCampaignV1 {
  const scenario = getCompanyBenchmarkScenario(input.scenarioId);
  const blueprint = createCompanyBenchmarkBlueprint(scenario);
  assertCompanyBenchmarkBlueprintFitsOperatingMode(blueprint);
  const baselineParent = requireCodexConnection(
    input.document,
    input.connectionId,
  );
  const companyParent = requireCodexConnection(
    input.document,
    input.roleConnectionIds?.parent ?? baselineParent.id,
  );
  const roles = (["implement", "review", "repair"] as const).map((role) => {
    const configured = input.document.agentRoutes[role];
    return route(
      role,
      requireCodexConnection(
        input.document,
        input.roleConnectionIds?.[role] ?? configured ?? companyParent.id,
      ),
    );
  });
  const autoRoutes = [route("parent", companyParent), ...roles] as const;
  const strongRoutes = [
    route("parent", baselineParent),
    route("implement", baselineParent),
    route("review", baselineParent),
    route("repair", baselineParent),
  ] as const;
  const autoDiffers = autoRoutes.some((candidate, index) => {
    const strong = strongRoutes[index]!;
    return candidate.connectionId !== strong.connectionId ||
      candidate.modelId !== strong.modelId ||
      candidate.reasoningEffort !== strong.reasoningEffort;
  });
  const companyArms = [
    {
      id: "company-auto",
      kind: "company" as const,
      configuredRoutes: autoRoutes,
    },
    ...(input.compareAllStrong && autoDiffers
      ? [{
          id: "company-strong",
          kind: "company" as const,
          configuredRoutes: strongRoutes,
        }]
      : []),
  ];
  const baselineId = input.control === "codex" ? "codex-cli" : "single-strong";
  const armOrder = Array.from(
    { length: input.repetitions },
    (_, index) => index + 1,
  ).flatMap((repetition) => {
    const companyIds = companyArms.map((arm) => arm.id);
    const armIds = repetition % 2 === 1
      ? [baselineId, ...companyIds]
      : [...companyIds].reverse().concat(baselineId);
    return armIds.map((armId) => ({
      slotId: companyBenchmarkTrialSlotId(armId, repetition),
      armId,
      repetition,
    }));
  });
  const policy = getOperatingModePolicy(MODE_ID);
  return parseCompanyBenchmarkCampaign({
    id: input.campaignId,
    version: 1,
    createdAt: input.createdAt,
    scenario: {
      id: scenario.id,
      version: scenario.version,
      taskClass: scenario.taskClass,
      difficulty: scenario.difficulty,
      fixtureSha256: scenario.fixtureSha256,
      verifierId: scenario.verifierId,
      objectiveRevision: scenario.objectiveRevision,
    },
    harnessRevision: `recurs_${RECURS_VERSION.replaceAll(/[^A-Za-z0-9_-]/gu, "_")}`,
    launchProtocolRevision: input.control === "codex" ? "company-benchmark-codex-control-300s-v1" : "company-benchmark-parent-only-v2",
    operatingModeId: MODE_ID,
    operatingModeVersion: policy.version,
    permissionMode: "approved_for_me",
    ...(input.control === "codex"
      ? { comparisonDesign: "official_codex_control_v1" as const }
      : companyParent.id === baselineParent.id
      ? {}
      : { comparisonDesign: "independent_company_parent_v1" as const }),
    repetitions: input.repetitions,
    ceilings: {
      maxTrialSlots: armOrder.length,
      maxRequests: (["options_precedence", "queue_cancellation", "workspace_maintenance"].includes(scenario.id) ? 16 : REQUESTS_PER_SLOT) * armOrder.length,
      maxReportedCostUsd:
        REPORTED_COST_USD_PER_SLOT * armOrder.length,
    },
    blueprint: {
      id: blueprint.id,
      revision: blueprint.revision,
      sha256: companyBenchmarkBlueprintDigest(blueprint),
    },
    baseline: {
      id: baselineId,
      kind: "single_agent",
      configuredRoutes: [{ ...route("parent", baselineParent), ...(input.control === "codex" ? { adapterId: "codex-cli-exec" } : {}) }],
    },
    companyArms,
    armOrder,
  });
}

function benchmarkRoot(dataDirectory: string): string {
  return path.join(dataDirectory, "evaluations", "company-proof-v1");
}

function stores(dataDirectory: string) {
  const root = benchmarkRoot(dataDirectory);
  return {
    campaigns: new FileCompanyBenchmarkCampaignStore(
      path.join(root, "campaigns"),
    ),
    trials: new FileCompanyBenchmarkTrialStore(path.join(root, "trials")),
    summaries: new FileCompanyBenchmarkSummaryStore(
      path.join(root, "summaries"),
    ),
    reservations: new FileCompanyBenchmarkSlotReservationStore(
      path.join(root, "reservations"),
    ),
    settlements: new FileCompanyBenchmarkSlotSettlementStore(
      path.join(root, "settlements"),
    ),
  };
}

export interface CompanyBenchmarkCommandDependencies {
  readonly dataDirectory: string;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
  readonly createId?: () => string;
  readonly createAdapter?: (
    campaign: CompanyBenchmarkCampaignV1,
  ) => CompanyBenchmarkExecutionAdapter;
  readonly onProgress?: (
    progress: CompanyBenchmarkProgress,
  ) => void | Promise<void>;
}

export async function runCompanyBenchmarkCommand(
  options: Exclude<CompanyBenchmarkCommandOptions, { readonly action: "list" }>,
  dependencies: CompanyBenchmarkCommandDependencies,
): Promise<CompanyBenchmarkCommandReport> {
  const state = stores(dependencies.dataDirectory);
  let campaign: CompanyBenchmarkCampaignV1;
  if (options.action === "resume") {
    campaign = await state.campaigns.load(
      options.campaignId,
      dependencies.signal,
    );
  } else {
    const document = await new FileConnectionRegistry(
      dependencies.dataDirectory,
    ).inspect();
    campaign = createConfiguredCompanyBenchmarkCampaign({
      document,
      scenarioId: options.scenarioId,
      connectionId: options.connectionId,
      roleConnectionIds: options.roleConnectionIds,
      repetitions: options.repetitions,
      compareAllStrong: options.compareAllStrong,
      ...(options.control === undefined ? {} : { control: options.control }),
      campaignId: `company-proof-${(dependencies.createId ?? randomUUID)()}`,
      createdAt: (dependencies.now ?? (() => new Date().toISOString()))(),
    });
    if (campaign.comparisonDesign === "official_codex_control_v1" && dependencies.createAdapter === undefined) {
      await preflightCodexControlCampaign(campaign, dependencies.dataDirectory, dependencies.signal ?? new AbortController().signal);
    }
    await state.campaigns.create(campaign, dependencies.signal);
  }

  const existing = (await state.trials.list(dependencies.signal)).filter(
    (trial) => trial.campaignId === campaign.id,
  );
  if (options.action === "resume" && campaign.comparisonDesign === "official_codex_control_v1" && dependencies.createAdapter === undefined) {
    await preflightCodexControlCampaign(campaign, dependencies.dataDirectory, dependencies.signal ?? new AbortController().signal);
  }
  let completed = existing.length;
  await dependencies.onProgress?.({
    campaignId: campaign.id,
    slotId: null,
    completedSlots: completed,
    totalSlots: campaign.armOrder.length,
    message: `Company proof ${campaign.id}: ${completed}/${campaign.armOrder.length} durable trials complete.`,
  });
  const blueprint = createCompanyBenchmarkBlueprint(
    getCompanyBenchmarkScenario(
      campaign.scenario.id,
      campaign.scenario.version,
    ),
  );
  const adapter = dependencies.createAdapter?.(campaign) ??
    new RuntimeCompanyBenchmarkAdapter({
      blueprint,
      sourceDataDirectory: dependencies.dataDirectory,
      ...(options.artifactsDirectory === undefined ? {} : { artifactsDirectory: options.artifactsDirectory }),
      onArtifactError: () => dependencies.onProgress?.({
        campaignId: campaign.id, slotId: null, completedSlots: completed,
        totalSlots: campaign.armOrder.length,
        message: "Candidate artifact retention failed; the measured trial is preserved.",
      }),
    });
  const control = campaign.comparisonDesign === "official_codex_control_v1"
    ? new CodexControlBenchmarkAdapter({ sourceDataDirectory: dependencies.dataDirectory,
      ...(options.artifactsDirectory === undefined ? {} : { artifactsDirectory: options.artifactsDirectory }) })
    : null;
  const setupStop = new AbortController();
  const runnerSignal = dependencies.signal === undefined ? setupStop.signal : AbortSignal.any([dependencies.signal, setupStop.signal]);
  const runner = new CompanyBenchmarkRunner({
    trials: state.trials,
    summaries: state.summaries,
    reservations: state.reservations,
    settlements: state.settlements,
    adapter: {
      async execute(input) {
        await dependencies.onProgress?.({
          campaignId: campaign.id,
          slotId: input.slot.slotId,
          completedSlots: completed,
          totalSlots: campaign.armOrder.length,
          message: `Running ${input.slot.armId} repetition ${input.slot.repetition}.`,
        });
        const deadline = new AbortController();
        const timer = control === null ? undefined : setTimeout(() => deadline.abort(), 300_000);
        timer?.unref();
        let trial: CompanyBenchmarkTrialV1;
        try {
          const bounded = control === null ? input : { ...input, signal: input.signal === undefined ? deadline.signal : AbortSignal.any([input.signal, deadline.signal]) };
          trial = await (control !== null && input.slot.armId === campaign.baseline.id && dependencies.createAdapter === undefined ? control : adapter).execute(bounded);
        } finally { if (timer !== undefined) clearTimeout(timer); }
        if (control !== null && (trial.failures.some(failure => failure.stage === "setup") ||
          trial.executionStatus === "failed" && (trial.usage.requestsUsed === 0 || trial.armId === campaign.baseline.id))) {
          // The runner persists this trial and settlement before observing cancellation at the next slot.
          setupStop.abort(new Error("Codex comparison stopped after an invalid execution; inspect the retained trial"));
        }
        completed += 1;
        await dependencies.onProgress?.({
          campaignId: campaign.id,
          slotId: input.slot.slotId,
          completedSlots: completed,
          totalSlots: campaign.armOrder.length,
          message: `Recorded ${input.slot.armId} repetition ${input.slot.repetition}.`,
        });
        return trial;
      },
    },
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  const summary = await runner.run(campaign, runnerSignal);
  const trials = (await state.trials.list(dependencies.signal))
    .filter((trial) => trial.campaignId === campaign.id)
    .sort((left, right) =>
      campaign.armOrder.findIndex((slot) => slot.slotId === left.slotId) -
      campaign.armOrder.findIndex((slot) => slot.slotId === right.slotId)
    );
  return Object.freeze({
    version: 2,
    campaign,
    summary,
    trials: Object.freeze(trials),
    attribution: deriveCompanyBenchmarkFailureAttribution(campaign, trials),
  });
}

function metric(value: number | null, suffix = ""): string {
  return value === null ? "unknown" : `${value}${suffix}`;
}

export function renderCompanyBenchmarkReport(
  report: CompanyBenchmarkCommandReport,
): string {
  const routeLines = report.campaign.companyArms.flatMap((arm) => [
    `Configured team ${arm.id}`,
    ...arm.configuredRoutes.map((item) =>
      `  ${item.role}: ${item.modelId}${item.reasoningEffort === null ? "" : ` · ${item.reasoningEffort}`}`
    ),
  ]);
  const trialLines = report.trials.flatMap((trial) => {
    const roles = trial.roles.map((role) =>
      `${role.role}:${role.attempts}`
    ).join(", ");
    return [
      `${trial.armId} · repetition ${trial.repetition} · ${trial.executionStatus} · verifier ${trial.verification.status}`,
      `  ${metric(trial.wallClockMs, "ms")} · requests ${trial.usage.requestsUsed} · input ${metric(trial.usage.inputTokens)} · output ${metric(trial.usage.outputTokens)} · cost ${metric(trial.usage.reportedCostUsd, " USD")}`,
      `  activated ${roles || "none"} · review ${trial.review.finalVerdict ?? "none"} · repair rounds ${trial.repairRounds}`,
    ];
  });
  return [
    `Company proof — ${report.campaign.id}`,
    `${report.summary.completedTrialIds.length}/${report.campaign.armOrder.length} trials recorded · correctness ${report.summary.correctnessEligibility} · efficiency ${report.summary.efficiencyEligibility}`,
    `Attribution: ${report.attribution.trialCounts.reliability} reliability · ${report.attribution.trialCounts.rosterInformative} roster-informative · ${report.attribution.trialCounts.sharedParentBoundaryFailure} shared-parent-boundary-failure trial(s)`,
    `Review: ${report.attribution.review.activatedTrials}/${report.attribution.review.companyTrials} company trial(s) activated · ${report.attribution.review.finalApprovals} approved · ${report.attribution.review.finalChangesRequested} changes requested · ${report.attribution.review.finalUnverified} unverified`,
    `Repair: ${report.attribution.repair.completedAttempts}/${report.attribution.repair.attempts} attempt(s) completed · ${report.attribution.repair.recoveredTrials}/${report.attribution.repair.attemptedTrials} trial(s) recovered`,
    ...routeLines,
    ...trialLines,
    `Rationale: ${report.summary.rationale.join(", ") || "none"}`,
    `Resume: recurs benchmark company --resume ${report.campaign.id} --allow-network`,
  ].join("\n");
}
