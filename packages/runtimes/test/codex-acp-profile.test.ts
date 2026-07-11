import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CODEX_ACP_ADAPTER_INTEGRITY,
  CODEX_ACP_ADAPTER_VERSION,
  CODEX_ACP_PROFILE_REVISION,
  CODEX_CLI_INTEGRITY,
  CODEX_CLI_VERSION,
  authenticateCodexAcpChatGpt,
  createAcpRuntimeProfile,
  createCodexAcpProfile,
  inspectCodexAcp,
  probeCodexAcp,
  resolveCodexAcpInstallation,
  type AcpRuntimeProfile,
} from "@recurs/runtimes";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-codex-acp-agent.mjs", import.meta.url),
);
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

function fakeProfile(scenario = "existing-chatgpt"): AcpRuntimeProfile {
  return createAcpRuntimeProfile({
    adapterId: "codex-acp",
    connectionId: "codex-test",
    capabilityProfileRevision: CODEX_ACP_PROFILE_REVISION,
    protocol: "acp",
    protocolVersion: 1,
    command: process.execPath,
    args: [fixture, "--scenario", scenario],
    clientInfo: { name: "recurs", version: "0.0.0", title: "Recurs" },
    allowedEnvironmentKeys: [],
    usageSemantics: "prompt_response",
    mappings: [
      {
        modelId: "gpt-test",
        executionMode: "plan",
        permissionMode: "ask_always",
        modeId: "read-only",
        configOptions: [
          { configId: "mode", value: "read-only" },
          { configId: "model", value: "gpt-test" },
        ],
      },
    ],
    capabilities: {
      resume: true,
      cancellation: "protocol",
      fileEvents: true,
      usageEvents: true,
      supportedPermissionModes: [
        "ask_always",
        "approved_for_me",
        "full_access",
      ],
      approvalControl: "host",
      planMode: "enforced",
      toolExecution: "opaque",
      checkpointing: "none",
    },
    bounds: {
      maxFrameBytes: 128 * 1_024,
      maxStdinBytes: 512 * 1_024,
      maxStdoutBytes: 2 * 1_024 * 1_024,
      maxStderrBytes: 64 * 1_024,
      maxFrames: 2_048,
      maxInboundQueueMessages: 128,
      maxInboundQueueBytes: 512 * 1_024,
      maxEvents: 2_048,
      maxEventBytes: 2 * 1_024 * 1_024,
      maxEventQueueEvents: 128,
      maxEventQueueBytes: 512 * 1_024,
      startupTimeoutMs: 2_000,
      promptTimeoutMs: 2_000,
      cancelSettlementTimeoutMs: 500,
      shutdownTimeoutMs: 500,
    },
  });
}

describe("official Codex ACP profile", () => {
  it("pins and resolves the reviewed adapter and platform executable without importing it", async () => {
    const installation = resolveCodexAcpInstallation();
    expect(installation).toMatchObject({
      adapterVersion: CODEX_ACP_ADAPTER_VERSION,
      codexVersion: CODEX_CLI_VERSION,
    });
    expect(path.isAbsolute(installation.adapterEntry)).toBe(true);
    expect(installation.adapterEntry).toMatch(/codex-acp\/dist\/index\.js$/u);
    expect(path.isAbsolute(installation.platformPackageJson)).toBe(true);

    const lock = JSON.parse(
      await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"),
    ) as { packages: Record<string, { version?: string; integrity?: string }> };
    expect(lock.packages["node_modules/@agentclientprotocol/codex-acp"]).toMatchObject({
      version: CODEX_ACP_ADAPTER_VERSION,
      integrity: CODEX_ACP_ADAPTER_INTEGRITY,
    });
    expect(lock.packages["node_modules/@openai/codex"]).toMatchObject({
      version: CODEX_CLI_VERSION,
      integrity: CODEX_CLI_INTEGRITY,
    });
    expect(Object.keys(lock.packages)).not.toContain(
      "node_modules/@zed-industries/codex-acp",
    );
    expect(lock.packages[`node_modules/${installation.platformPackageId}`])
      .toMatchObject({
        version: installation.platformVersion,
        integrity: installation.platformIntegrity,
      });
  });

  it("creates an immutable Plan-only profile with a narrow non-secret environment", () => {
    const profile = createCodexAcpProfile({
      connectionId: "codex-connection",
      modelId: "gpt-test",
    });
    expect(profile.command).toBe(process.execPath);
    expect(profile.args).toHaveLength(1);
    expect(profile.capabilityProfileRevision).toBe(CODEX_ACP_PROFILE_REVISION);
    expect(profile.capabilities).toMatchObject({
      resume: true,
      cancellation: "protocol",
      fileEvents: true,
      usageEvents: true,
      approvalControl: "host",
      planMode: "enforced",
      toolExecution: "opaque",
      checkpointing: "none",
    });
    expect(profile.capabilities.supportedPermissionModes).toEqual([
      "ask_always",
      "approved_for_me",
      "full_access",
    ]);
    expect(profile.mappings).toHaveLength(3);
    expect(profile.mappings.every((mapping) =>
      mapping.executionMode === "plan" &&
      mapping.modeId === "read-only" &&
      mapping.configOptions.some((option) =>
        option.configId === "mode" && option.value === "read-only"
      )
    )).toBe(true);
    for (const forbidden of [
      "APP_SERVER_LOGS",
      "DEFAULT_AUTH_REQUEST",
      "CODEX_PATH",
      "CODEX_CONFIG",
      "MODEL_PROVIDER",
      "INITIAL_AGENT_MODE",
      "DISABLE_MCP_CONFIG_FILTERING",
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "HTTP_PROXY",
      "NODE_OPTIONS",
    ]) {
      expect(profile.allowedEnvironmentKeys).not.toContain(forbidden);
    }
    expect(profile.allowedEnvironmentKeys).toContain("CODEX_HOME");
    expect(Object.isFrozen(profile)).toBe(true);
  });

  it("reads only the bounded structured status and authenticates the exact advertised method", async () => {
    await expect(inspectCodexAcp(
      fakeProfile(),
      new AbortController().signal,
    )).resolves.toMatchObject({
      status: { type: "chat-gpt", email: "owner@example.com" },
      inspection: {
        authMethods: expect.arrayContaining([
          { id: "chat-gpt", name: "ChatGPT", type: "agent" },
        ]),
      },
    });
    await expect(authenticateCodexAcpChatGpt(
      fakeProfile("unauthenticated"),
      new AbortController().signal,
    )).resolves.toMatchObject({ authenticatedMethodId: "chat-gpt" });
    await expect(authenticateCodexAcpChatGpt(
      fakeProfile("no-browser"),
      new AbortController().signal,
    )).rejects.toThrow("not advertised");
  });

  it("creates and closes a temporary session after verifying model and read-only mode", async () => {
    await expect(probeCodexAcp({
      profile: fakeProfile(),
      cwd: path.resolve(process.cwd()),
    }, new AbortController().signal)).resolves.toEqual({
      modelId: "gpt-test",
      modeId: "read-only",
      executionMode: "plan",
    });
    await expect(probeCodexAcp({
      profile: fakeProfile(),
      cwd: path.resolve(process.cwd()),
      modelId: "missing-model",
    }, new AbortController().signal)).rejects.toThrow("model");
  });
});
