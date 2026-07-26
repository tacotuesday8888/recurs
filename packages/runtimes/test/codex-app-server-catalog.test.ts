import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CodexAppServerCatalogError,
  createCodexAppServerProcessProfile,
  inspectCodexAppServerSubscription,
  loginCodexAppServerChatGpt,
  type CodexAppServerProcessProfile,
} from "@recurs/runtimes";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url),
);

function profile(scenario = "happy"): CodexAppServerProcessProfile {
  return {
    command: process.execPath,
    args: [fixture, "--scenario", scenario],
    environment: {},
    bounds: {
      maxFrameBytes: 64 * 1_024,
      maxStdoutBytes: 2 * 1_024 * 1_024,
      maxStderrBytes: 64 * 1_024,
      maxFrames: 512,
      maxPendingRequests: 8,
      requestTimeoutMs: 2_000,
      shutdownTimeoutMs: 500,
    },
  };
}

describe("Codex app-server subscription catalog", () => {
  it("allows bounded high-reasoning requests to exceed a short network timeout", () => {
    expect(createCodexAppServerProcessProfile().bounds.requestTimeoutMs)
      .toBe(120_000);
  });

  it("disables vendor workspace execution while retaining only Recurs host tools", () => {
    const profile = createCodexAppServerProcessProfile();
    const disabled = profile.args.flatMap((argument, index) =>
      argument === "--disable" ? [profile.args[index + 1]] : []
    );

    expect(disabled).toEqual(expect.arrayContaining([
      "apps",
      "code_mode_host",
      "multi_agent",
      "plugins",
      "shell_tool",
      "unified_exec",
      "workspace_dependencies",
    ]));
    expect(profile.args).toContain("mcp_servers={}");
    expect(profile.args).toContain('web_search="disabled"');
  });

  it("binds a ChatGPT account and paginates exact model effort options", async () => {
    const catalog = await inspectCodexAppServerSubscription(
      profile(),
      new AbortController().signal,
    );

    expect(catalog).toEqual({
      accountSubjectFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      accountDisplayLabel: "ChatGPT Pro subscription",
      planType: "pro",
      models: [
        {
          id: "gpt-5.6-luna",
          displayName: "GPT-5.6 Luna",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: ["low", "medium"],
        },
        {
          id: "gpt-5.6-sol",
          displayName: "GPT-5.6 Sol",
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: ["low", "ultra"],
        },
      ],
    });
    expect(JSON.stringify(catalog)).not.toContain("person@example.com");
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.models)).toBe(true);
  });

  it.each([
    ["unauthenticated", "authentication_required"],
    ["api-key", "account_mismatch"],
    ["malformed-catalog", "catalog_invalid"],
  ])("fails closed for %s", async (scenario, code) => {
    await expect(inspectCodexAppServerSubscription(
      profile(scenario),
      new AbortController().signal,
    )).rejects.toMatchObject({ code });
  });

  it("honors cancellation before reading account state", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(inspectCodexAppServerSubscription(
      profile(),
      controller.signal,
    )).rejects.toEqual(expect.objectContaining({
      constructor: CodexAppServerCatalogError,
      code: "cancelled",
    }));
  });

  it("runs the official bounded ChatGPT login flow without retaining its URL", async () => {
    const presented: unknown[] = [];
    await loginCodexAppServerChatGpt(
      profile(),
      new AbortController().signal,
      (prompt) => presented.push(prompt),
    );
    expect(presented).toEqual([{
      loginId: "fake-login-1",
      authUrl: "https://chatgpt.example/login?state=ephemeral",
    }]);
  });

  it("fails closed when the official ChatGPT login reports failure", async () => {
    await expect(loginCodexAppServerChatGpt(
      profile("login-failed"),
      new AbortController().signal,
      () => undefined,
    )).rejects.toMatchObject({
      constructor: CodexAppServerCatalogError,
      code: "authentication_required",
      message: "Codex ChatGPT login did not complete",
    });
  });

  it("cancels an in-flight official ChatGPT login", async () => {
    const controller = new AbortController();
    await expect(loginCodexAppServerChatGpt(
      profile("login-cancel"),
      controller.signal,
      () => controller.abort(),
    )).rejects.toMatchObject({
      constructor: CodexAppServerCatalogError,
      code: "cancelled",
    });
  });
});
