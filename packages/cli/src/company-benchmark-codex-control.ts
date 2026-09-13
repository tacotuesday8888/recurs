import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileConnectionRegistry } from "@recurs/app";
import type { CompanyBenchmarkCampaignV1, CompanyBenchmarkTrialV1, ProviderUsage } from "@recurs/contracts";
import {
  getCompanyBenchmarkScenario, initializeCompanyBenchmarkWorkspace,
  CompanyBenchmarkAllowanceError,
  projectCompanyBenchmarkTrial, verifyCompanyBenchmarkWorkspace,
  type CompanyBenchmarkExecutionAdapter, type CompanyBenchmarkExecutionInput,
  type CompanyBenchmarkWorkspaceVerification,
} from "@recurs/core";
import { codexAppServerEnvironment, resolveCodexCliInstallation } from "@recurs/runtimes";

import { retainCompanyBenchmarkArtifacts } from "./company-benchmark-artifacts.js";
import { assertCompanyBenchmarkScenarioAuthority } from "./company-benchmark-execution.js";
import { verifyCodexSubscriptionConnection } from "./codex-connection.js";

interface RetainedManifest {
  readonly files: { path: string; status: string; sha256?: string }[];
  readonly [key: string]: unknown;
}

export interface CodexControlProcessResult {
  readonly status: "completed" | "failed" | "cancelled" | "output_limit";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function codexControlArguments(model: string, effort: string, workspace: string): readonly string[] {
  return ["exec", "--json", "--ephemeral", "--ignore-user-config", "--sandbox", "workspace-write",
    "-c", 'approval_policy="never"', "-c", 'forced_login_method="chatgpt"',
    "--disable", "plugins", "--disable", "hooks", "--disable", "apps",
    "-c", "mcp_servers={}", "-c", 'web_search="disabled"',
    "-m", model, "-c", `model_reasoning_effort=${JSON.stringify(effort)}`, "-C", workspace, "-"];
}

/** Runs the official CLI without a Recurs agent prompt, tools, or delegation wrapper. */
export async function runCodexControlProcess(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly workspace: string;
  readonly prompt: string;
  readonly signal: AbortSignal;
}): Promise<CodexControlProcessResult> {
  if (input.signal.aborted) return { status: "cancelled", exitCode: null, stdout: "", stderr: "" };
  if (process.platform === "win32") throw new TypeError("Codex benchmark process groups require macOS or Linux");
  return new Promise((resolve) => {
    const child = spawn(input.command, [...input.args], {
      cwd: input.workspace, env: codexAppServerEnvironment(), detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0;
    let reason: "cancelled" | "output_limit" | null = null;
    const kill = () => { if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } } };
    const abort = () => { reason ??= "cancelled"; kill(); };
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]] as const) stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) { reason ??= "output_limit"; kill(); }
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input.prompt);
    child.once("error", () => { /* close follows spawn errors; details stay out of public records. */ });
    child.once("close", (exitCode) => {
      input.signal.removeEventListener("abort", abort);
      kill();
      resolve({ status: reason ?? (exitCode === 0 ? "completed" : "failed"), exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

export function parseCodexControlOutput(stdout: string): { readonly completed: boolean; readonly usage: ProviderUsage | null } {
  let terminalCount = 0, invalid = false;
  let usage: ProviderUsage | null = null;
  for (const line of stdout.split("\n").filter((line) => line.trim().length > 0)) {
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) { invalid = true; continue; }
      event = parsed as Record<string, unknown>;
    } catch { invalid = true; continue; }
    if (event.type === "turn.failed" || event.type === "error") invalid = true;
    if (event.type !== "turn.completed") continue;
    terminalCount += 1;
    const native = event.usage;
    if (typeof native !== "object" || native === null || Array.isArray(native)) continue;
    const record = native as Record<string, unknown>;
    const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    if (!count(record.input_tokens) || !count(record.output_tokens)) continue;
    const optional = { cached_input_tokens: "cachedInputTokens", cache_write_input_tokens: "cacheWriteInputTokens", reasoning_output_tokens: "reasoningTokens" } as const;
    if (Object.keys(optional).some((key) => record[key] !== undefined && !count(record[key]))) continue;
    if (count(record.cached_input_tokens) && record.cached_input_tokens > record.input_tokens) continue;
    usage = { inputTokens: record.input_tokens, outputTokens: record.output_tokens,
      ...Object.fromEntries(Object.entries(optional).filter(([key]) => record[key] !== undefined).map(([key, target]) => [target, record[key]])) };
  }
  return { completed: !invalid && terminalCount === 1, usage: !invalid && terminalCount === 1 ? usage : null };
}

/** Checks every saved subscription route without starting a model turn. */
export async function preflightCodexControlCampaign(
  campaign: CompanyBenchmarkCampaignV1,
  dataDirectory: string,
  signal: AbortSignal,
): Promise<void> {
  resolveCodexCliInstallation();
  const document = await new FileConnectionRegistry(dataDirectory).inspect();
  const routes = [campaign.baseline, ...campaign.companyArms].flatMap(arm => arm.configuredRoutes);
  const checked = new Set<string>();
  for (const route of routes) {
    const connection = document.connections.find(entry => entry.id === route.connectionId);
    if (connection?.kind !== "delegated_agent" || connection.providerId !== "openai-codex-chatgpt" ||
        connection.adapterId !== "codex-app-server" || connection.modelId !== route.modelId ||
        connection.reasoningEffort !== route.reasoningEffort) {
      throw new TypeError("The frozen benchmark route no longer matches a saved Codex subscription connection");
    }
    if (checked.has(connection.id)) continue;
    const decision = await verifyCodexSubscriptionConnection(connection, tmpdir(), signal);
    if (decision.status !== "verified") throw new TypeError(`Codex benchmark preflight failed: ${decision.reason}`);
    checked.add(connection.id);
  }
}

export class CodexControlBenchmarkAdapter implements CompanyBenchmarkExecutionAdapter {
  constructor(private readonly options: {
    readonly sourceDataDirectory: string;
    readonly artifactsDirectory?: string;
    readonly processRunner?: typeof runCodexControlProcess;
    readonly verifyConnection?: typeof verifyCodexSubscriptionConnection;
    readonly resolveInstallation?: typeof resolveCodexCliInstallation;
  }) {}

  async execute(input: CompanyBenchmarkExecutionInput): Promise<CompanyBenchmarkTrialV1> {
    if (input.campaign.comparisonDesign !== "official_codex_control_v1" || input.slot.armId !== input.campaign.baseline.id) {
      throw new TypeError("Native Codex execution requires the declared control slot");
    }
    const startedAtMs = Date.now();
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const scenario = getCompanyBenchmarkScenario(input.campaign.scenario.id, input.campaign.scenario.version);
    assertCompanyBenchmarkScenarioAuthority(scenario, input.campaign.scenario);
    const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "recurs-codex-control-")));
    const route = input.campaign.baseline.configuredRoutes[0]!;
    const sessionId = `codex-control-${randomUUID()}`;
    let result: CodexControlProcessResult | null = null;
    let usage: ProviderUsage | null = null;
    let executionStatus: "completed" | "failed" | "cancelled" = "failed";
    let verification: CompanyBenchmarkWorkspaceVerification = { status: "not_run", checks: [] };
    let requestStartedAtMs: number | null = null;
    let requestCompletedAtMs = startedAtMs;
    let reservation: ReturnType<typeof input.allowance.beforeProviderRequest> | null = null;
    let trial: CompanyBenchmarkTrialV1;
    let failureCode: string | null = "codex_control_setup_failed";
    try {
      const document = await new FileConnectionRegistry(this.options.sourceDataDirectory).inspect();
      const connection = document.connections.find((entry) => entry.id === route.connectionId);
      if (connection?.kind !== "delegated_agent" || connection.adapterId !== "codex-app-server" || connection.providerId !== "openai-codex-chatgpt" ||
          connection.modelId !== route.modelId || connection.reasoningEffort !== route.reasoningEffort ||
          (await (this.options.verifyConnection ?? verifyCodexSubscriptionConnection)(connection, workspace, signal)).status !== "verified") {
        throw new TypeError("Codex control subscription route is unavailable");
      }
      const installation = (this.options.resolveInstallation ?? resolveCodexCliInstallation)();
      const prepared = await initializeCompanyBenchmarkWorkspace({ scenario, workspaceRoot: workspace, signal });
      reservation = input.allowance.beforeProviderRequest(input.allowance.reportedCostAllowanceUsd / input.allowance.requestAllowance);
      requestStartedAtMs = Date.now();
      failureCode = "codex_control_execution_failed";
      result = await (this.options.processRunner ?? runCodexControlProcess)({ command: installation.codexExecutable,
        args: codexControlArguments(route.modelId, route.reasoningEffort!, workspace), workspace, prompt: scenario.objective, signal });
      requestCompletedAtMs = Date.now();
      const parsed = parseCodexControlOutput(result.stdout);
      usage = parsed.usage;
      executionStatus = result.status === "cancelled" ? "cancelled" : result.status === "completed" && parsed.completed ? "completed" : "failed";
      failureCode = executionStatus === "completed" ? null : result.status === "output_limit" ? "codex_control_output_limit" : executionStatus === "cancelled" ? "execution_cancelled" : "codex_control_execution_failed";
      input.allowance.afterProviderResponse(reservation, null);
      reservation = null;
      verification = await verifyCompanyBenchmarkWorkspace({ scenario, workspaceRoot: workspace, baseRevision: prepared.baseRevision, signal });
    } catch (error) {
      if (error instanceof CompanyBenchmarkAllowanceError) throw error;
      if (signal.aborted) { executionStatus = "cancelled"; failureCode = "execution_cancelled"; }
    } finally {
      if (reservation !== null) input.allowance.afterProviderResponse(reservation, null);
      if (requestStartedAtMs !== null && result === null) requestCompletedAtMs = Date.now();
      const completedAtMs = Math.max(startedAtMs, Date.now());
      let retained: string | null = null;
      let manifest: RetainedManifest | null = null;
      let temporaryArtifacts: string | null = null;
      try {
        try {
          if (this.options.artifactsDirectory === undefined) temporaryArtifacts = await mkdtemp(path.join(tmpdir(), "recurs-codex-control-capture-"));
          retained = await retainCompanyBenchmarkArtifacts({ directory: this.options.artifactsDirectory ?? temporaryArtifacts!, workspace, scenario,
            campaignId: input.campaign.id, slotId: input.slot.slotId, trial: null });
          manifest = JSON.parse(await readFile(path.join(retained, "manifest.json"), "utf8")) as RetainedManifest;
        } catch { /* An artifact failure does not discard execution evidence. */ }
        const changedFiles = (manifest?.files ?? []).filter((file) => file.status === "retained" &&
          file.sha256 !== createHash("sha256").update(scenario.files.find((source) => source.path === file.path)!.content).digest("hex")).map((file) => file.path);
        trial = projectCompanyBenchmarkTrial({ campaign: input.campaign, slot: input.slot, startedAtMs, completedAtMs,
          recorder: { requests: requestStartedAtMs === null ? [] : [{ role: "parent", sessionId, startedAtMs: requestStartedAtMs,
            completedAtMs: requestCompletedAtMs, status: executionStatus, usage }],
            attempts: requestStartedAtMs === null ? [] : [{ role: "parent", sessionId, startedAtMs: requestStartedAtMs,
              completedAtMs: requestCompletedAtMs, status: executionStatus, changedFiles, evidence: [] }],
            interventions: { externalConfirmationRequests: 0, userInputRequests: 0, automaticApprovals: 0, automaticDenials: 0 } },
          verification, teamRuns: [], executionStatus, finalEvidence: [],
          ...(failureCode === null ? {} : { failures: [{ stage: requestStartedAtMs === null ? "setup" : "execution", code: failureCode }] }) });
        try {
          if (retained !== null && manifest !== null) {
            await writeFile(path.join(retained, "manifest.json"), JSON.stringify({ ...manifest, trial }, null, 2) + "\n", { mode: 0o600 });
            if (result !== null) {
              await writeFile(path.join(retained, "stdout.private.jsonl"), result.stdout, { mode: 0o600, flag: "wx" });
              await writeFile(path.join(retained, "stderr.private.txt"), result.stderr, { mode: 0o600, flag: "wx" });
            }
          }
        } catch { /* Keep the measured trial when optional trace retention fails. */ }
      } finally {
        await rm(workspace, { recursive: true, force: true });
        if (temporaryArtifacts !== null) await rm(temporaryArtifacts, { recursive: true, force: true });
      }
    }
    return trial;
  }
}
