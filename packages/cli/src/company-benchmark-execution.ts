import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FileConnectionRegistry,
  type ConnectionRecord,
  type DelegatedConnectionRecord,
} from "@recurs/app";
import {
  createHostInvocation,
  type AgentRuntime,
  type CompanyBenchmarkArmV1,
  type CompanyBenchmarkScenarioRefV1,
  type CompanyBenchmarkTrialV1,
  type CompanyBlueprintV2,
  type RunResult,
  type RuntimeContinuationStore,
} from "@recurs/contracts";
import {
  AgentLoopError,
  CompanyBenchmarkAllowanceError,
  CompanyBenchmarkExecutionRecorder,
  CoordinatedRunError,
  JsonlTeamRunStore,
  getCompanyBenchmarkScenario,
  initializeCompanyBenchmarkWorkspace,
  projectCompanyBenchmarkTrial,
  verifyCompanyBenchmarkWorkspace,
  type CompanyBenchmarkExecutionAdapter,
  type CompanyBenchmarkExecutionInput,
  type CompanyBenchmarkScenario,
  type CompanyBenchmarkWorkspaceVerification,
  type RecursEvent,
} from "@recurs/core";
import type { ModelProvider } from "@recurs/providers";
import type { runProcess } from "@recurs/tools";

import { createStandaloneRuntime } from "./assembly.js";
import { createCodexAgentRuntime } from "./codex-connection.js";
import { RuntimeError } from "./runtime.js";

const LAUNCH_INVOCATION = createHostInvocation({
  invocation: "goal",
  userPresent: true,
  remote: false,
  scripted: false,
  embedding: "cli",
});
const BENCHMARK_PRECONSENTED_CONFIRMATIONS = new Set([
  "Allow write access to team candidate apply?",
  "Allow shell access to fixed Git worktree orchestration?",
]);

export function isCompanyBenchmarkPreconsentedConfirmation(
  message: string,
): boolean {
  return BENCHMARK_PRECONSENTED_CONFIRMATIONS.has(message) ||
    message.startsWith("Allow shell access to ") && message.endsWith("?");
}

export function companyBenchmarkBlueprintDigest(
  blueprint: CompanyBlueprintV2,
): string {
  return createHash("sha256")
    .update(JSON.stringify(blueprint))
    .digest("hex");
}

export function assertCompanyBenchmarkScenarioAuthority(
  scenario: CompanyBenchmarkScenario,
  reference: CompanyBenchmarkScenarioRefV1,
): void {
  if (
    scenario.id !== reference.id ||
    scenario.version !== reference.version ||
    scenario.taskClass !== reference.taskClass ||
    scenario.difficulty !== reference.difficulty ||
    scenario.fixtureSha256 !== reference.fixtureSha256 ||
    scenario.verifierId !== reference.verifierId ||
    scenario.objectiveRevision !== reference.objectiveRevision
  ) {
    throw new TypeError(
      "Company benchmark scenario does not match campaign authority",
    );
  }
}

export function companyBenchmarkExecutionFailureCode(
  error: unknown,
): string | null {
  if (error instanceof RuntimeError) {
    return `runtime_${error.code}`;
  }
  if (error instanceof AgentLoopError) {
    return `agent_${error.code}`;
  }
  if (error instanceof CoordinatedRunError) {
    return `coordinated_${error.failure.code}`;
  }
  return null;
}

function projectDirectory(dataDirectory: string, workspace: string): string {
  const projectId = createHash("sha256")
    .update(workspace)
    .digest("hex")
    .slice(0, 24);
  return path.join(dataDirectory, "projects", projectId);
}

function sameRoute(
  route: CompanyBenchmarkArmV1["configuredRoutes"][number],
  connection: ConnectionRecord,
): boolean {
  return route.providerId === connection.providerId &&
    route.adapterId === connection.adapterId &&
    route.connectionId === connection.id &&
    route.modelId === connection.modelId &&
    route.reasoningEffort === (
      "reasoningEffort" in connection
        ? connection.reasoningEffort ?? null
        : null
    );
}

async function copyConfiguredConnections(input: {
  readonly source: string;
  readonly target: string;
  readonly arm: CompanyBenchmarkArmV1;
}): Promise<readonly ConnectionRecord[]> {
  const document = await new FileConnectionRegistry(input.source).inspect();
  const selected = input.arm.configuredRoutes.map((route) => {
    const connection = document.connections.find(
      (candidate) => candidate.id === route.connectionId,
    );
    if (connection === undefined || !sameRoute(route, connection)) {
      throw new TypeError(
        "Company benchmark route no longer matches its saved connection",
      );
    }
    return connection;
  });
  if (selected.some((connection) =>
    connection.kind !== "delegated_agent" ||
    connection.adapterId !== "codex-app-server"
  )) {
    throw new TypeError(
      "Configured Company Proof Alpha currently requires reviewed Codex app-server routes",
    );
  }
  const byId = new Map(selected.map((connection) => [
    connection.id,
    connection,
  ] as const));
  const parent = input.arm.configuredRoutes[0]!;
  const target = new FileConnectionRegistry(input.target);
  await target.commit(0, (draft) => {
    draft.primaryConnectionId = parent.connectionId;
    draft.connections.push(
      ...[...byId.values()].map((connection) => structuredClone(connection)),
    );
    draft.agentRoutes = Object.fromEntries(
      (["implement", "review", "repair"] as const).map((role) => [
        role,
        input.arm.configuredRoutes.find(
          (route) => route.role === role,
        )?.connectionId ?? parent.connectionId,
      ]),
    ) as typeof draft.agentRoutes;
  });
  return selected;
}

function maximumReportedCostPerRequest(
  connections: readonly ConnectionRecord[],
  input: CompanyBenchmarkExecutionInput,
): number {
  const chargeable = connections.some((connection) =>
    connection.kind !== "local_openai_compatible" &&
    connection.billingSelection.allowedSources.some((source) =>
      source === "metered_api" || source === "prepaid_credits"
    )
  );
  return chargeable
    ? input.allowance.reportedCostAllowanceUsd /
      input.allowance.requestAllowance
    : 0;
}

function failedVerification(): CompanyBenchmarkWorkspaceVerification {
  return {
    status: "failed",
    checks: [{ id: "workspace_inventory", status: "failed" }],
  };
}

function isRunResult(value: unknown): value is RunResult {
  return typeof value === "object" && value !== null &&
    "finalText" in value && "changedFiles" in value && "evidence" in value;
}

function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true ||
    error instanceof DOMException && error.name === "AbortError";
}

export interface RuntimeCompanyBenchmarkAdapterOptions {
  readonly blueprint: CompanyBlueprintV2;
  readonly sourceDataDirectory?: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly createProvider?: (
    input: CompanyBenchmarkExecutionInput,
  ) => ModelProvider;
  readonly createDelegatedRuntime?: (
    connection: DelegatedConnectionRecord,
    store: RuntimeContinuationStore,
  ) => AgentRuntime;
  readonly processRunner?: typeof runProcess;
  readonly nowMs?: () => number;
}

/**
 * Executes each arm through the normal Recurs runtime. The adapter creates a
 * byte-identical scenario workspace and a private temporary Recurs home for
 * every slot, then retains only the normalized benchmark record.
 */
export class RuntimeCompanyBenchmarkAdapter
  implements CompanyBenchmarkExecutionAdapter {
  readonly #options: RuntimeCompanyBenchmarkAdapterOptions;

  constructor(options: RuntimeCompanyBenchmarkAdapterOptions) {
    if (options.blueprint.state !== "approved") {
      throw new TypeError(
        "Company benchmark execution requires an approved blueprint",
      );
    }
    this.#options = options;
  }

  async execute(
    input: CompanyBenchmarkExecutionInput,
  ): Promise<CompanyBenchmarkTrialV1> {
    input.signal?.throwIfAborted();
    if (
      input.campaign.blueprint.id !== this.#options.blueprint.id ||
      input.campaign.blueprint.revision !== this.#options.blueprint.revision ||
      input.campaign.blueprint.sha256 !==
        companyBenchmarkBlueprintDigest(this.#options.blueprint)
    ) {
      throw new TypeError(
        "Company benchmark blueprint does not match campaign authority",
      );
    }
    const arm = input.slot.armId === input.campaign.baseline.id
      ? input.campaign.baseline
      : input.campaign.companyArms.find(
          (candidate) => candidate.id === input.slot.armId,
        );
    if (arm === undefined) {
      throw new TypeError("Company benchmark arm is unavailable");
    }
    const scenario = getCompanyBenchmarkScenario(
      input.campaign.scenario.id,
      input.campaign.scenario.version,
    );
    assertCompanyBenchmarkScenarioAuthority(
      scenario,
      input.campaign.scenario,
    );

    const nowMs = this.#options.nowMs ?? Date.now;
    const workspace = await realpath(
      await mkdtemp(path.join(tmpdir(), "recurs-company-benchmark-workspace-")),
    );
    const dataDirectory = await realpath(
      await mkdtemp(path.join(tmpdir(), "recurs-company-benchmark-home-")),
    );
    const startedAtMs = nowMs();
    let runtime: Awaited<ReturnType<typeof createStandaloneRuntime>> | null =
      null;
    let recorder: CompanyBenchmarkExecutionRecorder | null = null;
    let verification: CompanyBenchmarkWorkspaceVerification =
      failedVerification();
    let executionStatus:
      | "completed"
      | "failed"
      | "cancelled"
      | "interrupted";
    let finalEvidence: readonly string[] = [];
    let failureStage: "setup" | "execution" | null = null;
    let executionFailureCode: string | null = null;
    const companyState: {
      terminal:
        | "completed"
        | "failed"
        | "cancelled"
        | "interrupted"
        | null;
    } = { terminal: null };

    try {
      const prepared = await initializeCompanyBenchmarkWorkspace({
        scenario,
        workspaceRoot: workspace,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(this.#options.processRunner === undefined
          ? {}
          : { processRunner: this.#options.processRunner }),
      });
      let connections: readonly ConnectionRecord[] = [];
      if (this.#options.createProvider === undefined) {
        if (this.#options.sourceDataDirectory === undefined) {
          throw new TypeError(
            "Configured benchmark execution requires a source Recurs home",
          );
        }
        connections = await copyConfiguredConnections({
          source: this.#options.sourceDataDirectory,
          target: dataDirectory,
          arm,
        });
      }
      recorder = new CompanyBenchmarkExecutionRecorder({
        allowance: input.allowance,
        maximumReportedCostPerRequestUsd:
          maximumReportedCostPerRequest(connections, input),
        nowMs,
      });
      const events = {
        async emit(event: RecursEvent) {
          recorder!.observe(event);
          if (event.type === "company_goal_completed") {
            companyState.terminal = "completed";
          } else if (event.type === "company_goal_failed") {
            companyState.terminal = "failed";
          } else if (event.type === "company_goal_cancelled") {
            companyState.terminal = "cancelled";
          } else if (event.type === "company_goal_interrupted") {
            companyState.terminal = "interrupted";
          }
        },
      };
      const provider = this.#options.createProvider?.(input);
      const delegated = this.#options.createDelegatedRuntime ??
        createCodexAgentRuntime;
      runtime = await createStandaloneRuntime(events, {
        cwd: workspace,
        dataDirectory,
        skillHomeDirectory: dataDirectory,
        reuseExistingSession: false,
        operatingModeId: input.campaign.operatingModeId,
        permissionMode: input.campaign.permissionMode,
        ...(arm.kind === "company"
          ? { companyBlueprint: this.#options.blueprint }
          : {}),
        ...(provider === undefined
          ? {
              connectionId: arm.configuredRoutes[0]!.connectionId,
              delegatedRuntimeFactory: (connection, store) =>
                recorder!.wrapRuntime(delegated(connection, store)),
            }
          : {
              provider: recorder.wrapProvider(provider),
              model: arm.configuredRoutes[0]!.modelId,
            }),
        ...(this.#options.environment === undefined
          ? {}
          : { environment: this.#options.environment }),
      });
      runtime.setConfirmHandler(async (message) =>
        isCompanyBenchmarkPreconsentedConfirmation(message)
      );
      recorder.registerParent(runtime.session.id, startedAtMs);
      try {
        if (arm.kind === "single_agent") {
          const goal = await runtime.submit(
            `/goal ${scenario.objective}`,
            LAUNCH_INVOCATION,
          );
          if (isRunResult(goal)) {
            throw new TypeError(
              "Company benchmark goal setup unexpectedly ran an agent turn",
            );
          }
        }
        const response = await runtime.submit(
          arm.kind === "company"
            ? `/goal ${scenario.objective}`
            : scenario.objective,
          LAUNCH_INVOCATION,
        );
        if (!isRunResult(response)) {
          throw new TypeError(
            "Company benchmark launch did not execute an agent turn",
          );
        }
        finalEvidence = response.evidence;
        recorder.finishParent({
          completedAtMs: nowMs(),
          status: "completed",
          changedFiles: response.changedFiles,
          evidence: response.evidence,
        });
        executionStatus = arm.kind === "single_agent"
          ? "completed"
          : companyState.terminal ?? "failed";
        if (executionStatus !== "completed") {
          failureStage = "execution";
        }
      } catch (error) {
        if (error instanceof CompanyBenchmarkAllowanceError) throw error;
        executionStatus = isCancellation(error, input.signal)
          ? "cancelled"
          : "failed";
        executionFailureCode = companyBenchmarkExecutionFailureCode(error);
        recorder.finishParent({
          completedAtMs: nowMs(),
          status: executionStatus,
          changedFiles: [],
          evidence: [],
        });
        failureStage = "execution";
      }
      try {
        verification = await verifyCompanyBenchmarkWorkspace({
          scenario,
          workspaceRoot: workspace,
          baseRevision: prepared.baseRevision,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(this.#options.processRunner === undefined
            ? {}
            : { processRunner: this.#options.processRunner }),
        });
      } catch {
        verification = failedVerification();
      }

      const store = new JsonlTeamRunStore(
        path.join(projectDirectory(dataDirectory, workspace), "team-runs"),
      );
      const entries = runtime === null
        ? []
        : await store.list(runtime.session.id);
      const teamRuns = await Promise.all(
        entries.map((entry) => store.load(entry.id)),
      );
      const completedAtMs = Math.max(startedAtMs, nowMs());
      return projectCompanyBenchmarkTrial({
        campaign: input.campaign,
        slot: input.slot,
        startedAtMs,
        completedAtMs,
        recorder: recorder.snapshot(completedAtMs),
        verification,
        teamRuns,
        executionStatus,
        finalEvidence,
        ...(failureStage === null
          ? {}
          : {
              failures: [{
                stage: failureStage,
                code: executionStatus === "cancelled"
                  ? "execution_cancelled"
                  : executionFailureCode ??
                    (
                      executionStatus === "interrupted"
                        ? "company_goal_interrupted"
                        : arm.kind === "company"
                          ? companyState.terminal === null
                            ? "company_goal_not_executed"
                            : "company_goal_failed"
                          : "runtime_execution_failed"
                    ),
              }],
            }),
      });
    } catch (error) {
      if (error instanceof CompanyBenchmarkAllowanceError) throw error;
      if (isCancellation(error, input.signal)) throw error;
      if (recorder !== null) throw error;
      failureStage = "setup";
      const completedAtMs = Math.max(startedAtMs, nowMs());
      return projectCompanyBenchmarkTrial({
        campaign: input.campaign,
        slot: input.slot,
        startedAtMs,
        completedAtMs,
        recorder: {
          requests: [],
          attempts: [],
          interventions: {
            externalConfirmationRequests: 0,
            userInputRequests: 0,
            automaticApprovals: 0,
            automaticDenials: 0,
          },
        },
        verification,
        teamRuns: [],
        executionStatus: "failed",
        finalEvidence: [],
        failures: [{
          stage: failureStage,
          code: "runtime_setup_failed",
        }],
      });
    } finally {
      await runtime?.close().catch(() => {});
      await Promise.all([
        rm(workspace, { recursive: true, force: true }),
        rm(dataDirectory, { recursive: true, force: true }),
      ]);
    }
  }
}
