import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileConnectionRegistry, type DelegatedConnectionRecord } from "@recurs/app";
import { CODEX_APP_SERVER_PROFILE_REVISION } from "@recurs/runtimes";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PRODUCT_TASK_REFERENCES } from "../../core/test/company-benchmark-product-reference.js";
import { createConfiguredCompanyBenchmarkCampaign } from "../src/company-benchmark-command.js";
import { CodexControlBenchmarkAdapter, codexControlArguments, parseCodexControlOutput, runCodexControlProcess } from "../src/company-benchmark-codex-control.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const terminal = (usage: unknown = { input_tokens: 100, output_tokens: 15, cached_input_tokens: 40 }) => JSON.stringify({ type: "turn.completed", usage });

describe("official Codex benchmark process", () => {
  it("uses saved subscription auth and native tools without API or unsafe sandbox flags", () => {
    const args = codexControlArguments("gpt-5.6-luna", "medium", "/tmp/fixture");
    expect(args).toContain('forced_login_method="chatgpt"');
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("workspace-write");
    expect(args).not.toContain("multi_agent");
    expect(args.join(" ")).not.toMatch(/api[_-]key|dangerously|danger-full-access/iu);
  });

  it("preserves native counters without inferring absent costs or counting cached tokens twice", () => {
    expect(parseCodexControlOutput(terminal())).toEqual({ completed: true, usage: { inputTokens: 100, outputTokens: 15, cachedInputTokens: 40 } });
    expect(parseCodexControlOutput(terminal({ input_tokens: 0, output_tokens: 0 }))).toEqual({ completed: true, usage: { inputTokens: 0, outputTokens: 0 } });
    for (const usage of [null, {}, { input_tokens: -1, output_tokens: 2 }, { input_tokens: 2, output_tokens: 1, cached_input_tokens: 3 }, { input_tokens: 2, output_tokens: 1, reasoning_output_tokens: 0.5 }]) {
      expect(parseCodexControlOutput(terminal(usage))).toEqual({ completed: true, usage: null });
    }
    for (const output of ["", "broken", "[]", terminal() + "\n" + terminal(), terminal() + '\n{"type":"turn.failed"}', terminal() + '\n{"type":"error"}']) {
      expect(parseCodexControlOutput(output)).toEqual({ completed: false, usage: null });
    }
  });

  it("runs a process with exact stdin, captures output and settles missing executables", async () => {
    const result = await runCodexControlProcess({ command: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], workspace: tmpdir(), prompt: "literal `prompt` $HOME\n", signal: new AbortController().signal });
    expect(result).toMatchObject({ status: "completed", exitCode: 0, stdout: "literal `prompt` $HOME\n" });
    const absent = await runCodexControlProcess({ command: "/not/a/real/codex", args: [], workspace: tmpdir(), prompt: "", signal: new AbortController().signal });
    expect(absent.status).toBe("failed");
  });

  it("bounds output and cancels a running process", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      const result = await runCodexControlProcess({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], workspace: tmpdir(), prompt: "", signal: controller.signal });
      expect(result.status).toBe("cancelled");
    } finally { clearTimeout(timer); }
    const overflow = await runCodexControlProcess({ command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(17*1024*1024));setInterval(()=>{},1000)"], workspace: tmpdir(), prompt: "", signal: AbortSignal.timeout(5000) });
    expect(overflow.status).toBe("output_limit");
    expect(Buffer.byteLength(overflow.stdout)).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it("projects a native trial, grades its actual files and retains private trace evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-native-control-test-")); roots.push(root);
    const at = "2026-09-13T00:00:00.000Z";
    const connection = {
      kind: "delegated_agent", id: "codex-test", providerId: "openai-codex-chatgpt", adapterId: "codex-app-server", label: "Test", accountLabel: "Test", organizationLabel: null,
      modelId: "gpt-5.6-luna", reasoningEffort: "medium", accountSubjectFingerprint: `sha256:${"a".repeat(64)}`,
      policyRevision: "openai-codex-chatgpt-2026-07-11", runtimeCapabilityProfileRevision: CODEX_APP_SERVER_PROFILE_REVISION,
      billingPolicy: { revision: "billing:openai-codex-chatgpt:2026-07-11", disclosureRevision: "billing-disclosure:openai-codex-chatgpt:2026-07-11", primarySource: "included_subscription", possibleAdditionalSources: ["prepaid_credits"], providerFallback: "automatic", availableSelections: ["allow_declared_additional"] },
      billingSelection: { mode: "allow_declared_additional", policyRevision: "billing:openai-codex-chatgpt:2026-07-11", disclosureRevision: "billing-disclosure:openai-codex-chatgpt:2026-07-11", allowedSources: ["included_subscription", "prepaid_credits"], acknowledgedAt: at },
      verifiedAt: at, createdAt: at, updatedAt: at,
    } satisfies DelegatedConnectionRecord;
    const document = { schemaVersion: 2 as const, revision: 1, primaryConnectionId: connection.id, connections: [connection], agentRoutes: {} };
    vi.spyOn(FileConnectionRegistry.prototype, "inspect").mockResolvedValue(document);
    const campaign = createConfiguredCompanyBenchmarkCampaign({ document, scenarioId: "release_window_regressions", connectionId: connection.id, repetitions: 1, compareAllStrong: false, control: "codex", campaignId: "native-test", createdAt: at });
    let workspace: string | undefined;
    const processRunner = vi.fn(async (input: Parameters<typeof runCodexControlProcess>[0]) => {
      workspace = input.workspace;
      for (const [filePath, content] of Object.entries(PRODUCT_TASK_REFERENCES.release_window_regressions!)) await writeFile(path.join(input.workspace, filePath), content);
      return { status: "completed" as const, exitCode: 0, stdout: terminal(), stderr: "private trace" };
    });
    const adapter = new CodexControlBenchmarkAdapter({ sourceDataDirectory: root, artifactsDirectory: root,
      verifyConnection: async () => ({ status: "verified" }), resolveInstallation: () => ({ source: "bundled_package", codexVersion: "0.145.0", codexExecutable: process.execPath }), processRunner });
    const beforeProviderRequest = vi.fn(() => ({ id: "held" })), afterProviderResponse = vi.fn();
    await expect(adapter.execute({ campaign: { ...campaign, scenario: { ...campaign.scenario, fixtureSha256: "0".repeat(64) } }, slot: campaign.armOrder[0]!, allowance: { requestAllowance: 96, reportedCostAllowanceUsd: 3, beforeProviderRequest, afterProviderResponse } })).rejects.toThrow("scenario does not match");
    expect(processRunner).not.toHaveBeenCalled();
    const trial = await adapter.execute({ campaign, slot: campaign.armOrder[0]!, allowance: { requestAllowance: 96, reportedCostAllowanceUsd: 3, beforeProviderRequest, afterProviderResponse } });
    expect(processRunner).toHaveBeenCalledOnce();
    expect(trial.executionStatus).toBe("completed");
    expect(trial.verification.status).toBe("passed");
    expect(trial.activatedRoutes[0]?.adapterId).toBe("codex-cli-exec");
    expect(trial.usage).toMatchObject({ requestsUsed: 1, inputTokens: 100, outputTokens: 15, reportedCostUsd: null });
    expect(afterProviderResponse).toHaveBeenCalledExactlyOnceWith({ id: "held" }, null);
    const retained = (await readdir(root)).find(name => name.startsWith("trial-"))!;
    expect(await readFile(path.join(root, retained, "stderr.private.txt"), "utf8")).toBe("private trace");
    await expect(readdir(workspace!)).rejects.toThrow();
  });
});
