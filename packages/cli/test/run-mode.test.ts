import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

import {
  NATIVE_COMPONENT_VERSION,
  type BackendResolver,
  type HostInvocation,
  type NativeAuthorityStatusPort,
} from "@recurs/contracts";
import {
  ConnectionLifecycleError,
  EnvironmentConnectionError,
} from "@recurs/app";
import type { EventSink } from "@recurs/core";
import {
  AgentLoop,
  AgentLoopError,
  BackendRunCoordinator,
  JsonlSessionStore,
  bindRunAuthorization,
} from "@recurs/core";
import { ProviderError, ScriptedProvider } from "@recurs/providers";
import {
  ToolRegistry,
} from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RecursRuntime,
  LocalConnectionError,
  RuntimeError,
  createCommandRegistry,
  createStandaloneRuntime,
  type CliDependencies,
} from "../src/index.js";
import {
  isAutomationEnvironment,
  runCli,
  runCliProcess,
} from "../src/process-host.js";
import { testAt, testBackendPin } from "../../../tests/support/backend.js";

class TextOutput extends Writable {
  value = "";

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += chunk.toString();
    callback();
  }
}

const directories: string[] = [];
const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));

async function readStream(stream: Readable, closeOnData = false): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.from(chunk));
      if (closeOnData) stream.destroy();
    });
    stream.once("error", reject);
    stream.once("close", () => resolve(Buffer.concat(chunks)));
    stream.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function runPublicCli(platform: "darwin" | "linux"): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly nativeBytes: Buffer;
}> {
  const source = `
    import { createServer } from "vite";
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: true,
      value: ${JSON.stringify(platform)},
    });
    const server = await createServer({
      root: ${JSON.stringify(workspaceRoot)},
      appType: "custom",
      logLevel: "silent",
      server: { middlewareMode: true },
      plugins: [{
        name: "assert-native-marker-deleted",
        load(id) {
          if (
            id.endsWith("/packages/cli/src/process-host.ts") &&
            Object.prototype.hasOwnProperty.call(process.env, "RECURS_NATIVE_FD")
          ) {
            throw new Error("native descriptor marker reached process host");
          }
          return null;
        },
      }],
    });
    try {
      await server.ssrLoadModule("/packages/cli/src/main.ts");
    } finally {
      await server.close();
    }
  `;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      source,
      "recurs",
      "doctor",
      "native",
      "--json",
    ],
    {
      cwd: workspaceRoot,
      env: { ...process.env, RECURS_NATIVE_FD: "3" },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    },
  );
  const stdout = child.stdout;
  const stderr = child.stderr;
  const nativePipe = child.stdio[3];
  if (stdout === null || stderr === null || !(nativePipe instanceof Readable)) {
    child.kill();
    throw new Error("public CLI child did not expose expected pipes");
  }
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const [code, stdoutBytes, stderrBytes, nativeBytes] = await Promise.all([
    closed,
    readStream(stdout),
    readStream(stderr),
    readStream(nativePipe, true),
  ]);
  return {
    code,
    stdout: stdoutBytes.toString("utf8"),
    stderr: stderrBytes.toString("utf8"),
    nativeBytes,
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createRuntime(sink: EventSink): Promise<RecursRuntime> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-run-mode-"));
  directories.push(directory);
  const sessions = new JsonlSessionStore(path.join(directory, "sessions"));
  await sessions.createPinnedSession({
    id: "s1",
    at: testAt,
    cwd: directory,
    backend: testBackendPin(),
  });
  const provider = new ScriptedProvider([
    [
      { type: "text_delta", text: "inspection complete" },
      { type: "usage", inputTokens: 3, outputTokens: 2 },
      { type: "done", stopReason: "complete" },
    ],
  ]);
  const loop = new AgentLoop({
    provider,
    tools: new ToolRegistry(),
    approvals: { async request() { return "deny"; } },
    sessions,
    emit: sink.emit,
    createToolContext(session, signal) {
      return {
        sessionId: session.id,
        cwd: session.cwd,
        signal,
        executionMode: session.executionMode,
        readRevisions: new Map(),
      };
    },
  });
  return new RecursRuntime(
    {
      commands: createCommandRegistry({ sessions, provider }),
      loop,
      sessions,
      confirm: async () => false,
    },
    await sessions.loadState("s1"),
  );
}

function dependencies(stdout: TextOutput, stderr: TextOutput): CliDependencies {
  return { stdout, stderr, createRuntime };
}

const openAIDisclosure = {
  providerId: "openai-api" as const,
  displayName: "OpenAI API" as const,
  credentialOwner: "recurs_broker" as const,
  endpoint: "https://api.openai.com/v1" as const,
  policyRevision: "openai-api-2026-07-11",
  billingPolicyRevision: "billing:openai-api:2026-07-11",
  billingDisclosureRevision: "billing-disclosure:openai-api:2026-07-11",
  primaryBillingSource: "metered_api" as const,
  billingNotice:
    "OpenAI API billing is separate from ChatGPT subscriptions." as const,
  systemProxyTrust: "trusted_in_v1" as const,
  supportedRunContexts: ["local_cli_user_present"] as const,
  capabilityProfileRevision:
    "openai-responses-tools-2026-07-13-v1" as const,
  restrictions: ["Activation requires the native credential broker."],
};

const openAIModelIds = [
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
] as const;

describe("public CLI process boundary", () => {
  it("exports process assembly without re-exporting or evaluating the bin", async () => {
    const [indexSource, binSource] = await Promise.all([
      readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/main.ts", import.meta.url), "utf8"),
    ]);

    expect(runCliProcess).toBeTypeOf("function");
    expect(indexSource).toContain('export * from "./process-host.js";');
    expect(indexSource).not.toContain('export * from "./main.js";');
    expect(binSource).not.toMatch(/from\s+["'](?:@recurs|node:net)/u);
    expect(binSource).not.toContain("inherited-socket");
    expect(binSource.indexOf("delete process.env.RECURS_NATIVE_FD"))
      .toBeLessThan(binSource.indexOf('await import("./process-host.js")'));
  });

  it.each([
    ["darwin", "launcher_unavailable"],
    ["linux", "unsupported_platform"],
  ] as const)(
    "deletes the inherited marker before async imports on %s",
    async (platform, expectedReason) => {
      const result = await runPublicCli(platform);

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        version: 1,
        nativeAuthority: {
          state: "unavailable",
          reason: expectedReason,
        },
      });
      expect(result.nativeBytes).toHaveLength(0);
    },
    15_000,
  );
});

describe("ACP command", () => {
  it("runs the stdio server without creating the ordinary CLI runtime", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    let served = 0;
    const exitCode = await runCli(["acp"], {
      stdout,
      stderr,
      async createRuntime() {
        throw new Error("ordinary runtime must not start");
      },
      async runAcp() {
        served += 1;
      },
    });

    expect(exitCode).toBe(0);
    expect(served).toBe(1);
    expect(stdout.value).toBe("");
    expect(stderr.value).toBe("");
  });

  it("rejects ACP arguments before starting the protocol stream", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    let served = false;
    const exitCode = await runCli(["acp", "extra"], {
      stdout,
      stderr,
      async createRuntime() {
        throw new Error("ordinary runtime must not start");
      },
      async runAcp() { served = true; },
    });

    expect(exitCode).toBe(2);
    expect(served).toBe(false);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("recurs acp");
  });
});

describe("runCli", () => {
  it("classifies common CI markers while honoring explicit false values", () => {
    expect(isAutomationEnvironment({ CI: "true" })).toBe(true);
    expect(isAutomationEnvironment({ GITHUB_ACTIONS: "1" })).toBe(true);
    expect(isAutomationEnvironment({ CI: "false", GITHUB_ACTIONS: "0" }))
      .toBe(false);
    expect(isAutomationEnvironment({})).toBe(false);
  });

  it("configures a verified local model through setup", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    let received: { baseUrl: string; modelId: string } | undefined;

    const exitCode = await runCli([
      "setup", "local", "--url", "http://127.0.0.1:11434/v1", "--model", "qwen-coder",
    ], {
      stdout,
      stderr,
      async createRuntime() { throw new Error("runtime must not start"); },
      async setupLocal(input) {
        received = input;
        return { id: "local-1", label: "Local model", primary: true, ...input };
      },
    });

    expect(exitCode).toBe(0);
    expect(received).toEqual({
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen-coder",
    });
    expect(stdout.value).toContain("Ready — Local model · qwen-coder");
    expect(stdout.value).toContain("Primary connection");
    expect(stderr.value).toBe("");
  });

  it("rejects incomplete local setup without writing configuration", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    let called = false;
    const exitCode = await runCli(["setup", "local", "--url", "http://127.0.0.1:11434/v1"], {
      stdout,
      stderr,
      async createRuntime() { throw new Error("runtime must not start"); },
      async setupLocal() { called = true; throw new Error("unexpected"); },
    });
    expect(exitCode).toBe(2);
    expect(called).toBe(false);
    expect(stderr.value).toContain("recurs setup local --url");
  });

  it("guides explicit local setup and falls back safely when Full Access is declined", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    const selections = [
      "local:ollama",
      "full_access",
      "balanced_v5",
      "skip",
    ];
    let localInput: unknown;
    let runtimeOptions: unknown;
    const runtime = {
      state: { type: "session" },
      setConfirmHandler() {},
      cancel() { return false; },
      async submit() { return { type: "quit" as const }; },
    } as unknown as RecursRuntime;

    const exitCode = await runCli(["setup"], {
      stdin: Readable.from(["/quit\n"]),
      stdout,
      stderr,
      interactive: true,
      automation: false,
      async createRuntime(_events, options) {
        runtimeOptions = options;
        return runtime;
      },
      async listAccounts() { return []; },
      async listProviders() { return []; },
      async detectProviders() {
        return [{
          id: "ollama",
          name: "Ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          detected: true,
        }];
      },
      async selectChoice(_message, choices) {
        const selected = selections.shift() ?? null;
        expect(choices.some((choice) => choice.id === selected)).toBe(true);
        return selected;
      },
      async promptText(message) {
        expect(message).toContain("exact model ID");
        return "qwen-coder";
      },
      async confirm(message) {
        expect(message).toContain("Windows does not yet have");
        return false;
      },
      async setupLocal(input) {
        localInput = input;
        return {
          id: "local-1",
          label: "Ollama",
          modelId: input.modelId,
          baseUrl: input.baseUrl,
          primary: true,
        };
      },
    });

    expect(exitCode).toBe(0);
    expect(localInput).toEqual({
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen-coder",
    });
    expect(runtimeOptions).toEqual({
      operatingModeId: "balanced_v5",
      permissionMode: "ask_always",
      reuseExistingSession: false,
    });
    expect(stdout.value).toContain("Welcome to Recurs");
    expect(stdout.value).toContain("Onboarding complete");
    expect(stdout.value).toContain("Starting a fresh durable session");
    expect(stdout.value).toContain("Full Access was not enabled");
    expect(stdout.value).toContain("Recurs — local harness mode");
    expect(stderr.value).toBe("");
  });

  it("offers guided BYOK onboarding and selects a credential-visible model", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "recurs-guided-byok-"));
    directories.push(cwd);
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    const selections = [
      "byok:openrouter-api",
      "anthropic/claude-test",
      "approved_for_me",
      "balanced_v5",
      "skip",
    ];
    let configured = false;
    let setupInput: unknown;
    const runtimeOptions: unknown[] = [];
    const workspaceRuntime = {
      state: {
        type: "workspace",
        cwd: "/tmp/workspace",
        permissionMode: "ask_always",
      },
      setConfirmHandler() {},
      cancel() { return false; },
      async submit() { return { type: "quit" as const }; },
    } as unknown as RecursRuntime;
    const sessionRuntime = {
      state: { type: "session" },
      setConfirmHandler() {},
      cancel() { return false; },
      async submit() { return { type: "quit" as const }; },
    } as unknown as RecursRuntime;

    const exitCode = await runCli([], {
      stdin: Readable.from(["/quit\n"]),
      stdout,
      stderr,
      cwd,
      interactive: true,
      automation: false,
      async createRuntime(_events, options) {
        runtimeOptions.push(options);
        return options === undefined ? workspaceRuntime : sessionRuntime;
      },
      async listAccounts() {
        return configured
          ? [{
              id: "byok-1",
              label: "OpenRouter API BYOK",
              providerId: "openrouter-api",
              adapterId: "openai-chat-completions" as const,
              kind: "environment_model_provider" as const,
              modelId: "anthropic/claude-test",
              primary: true,
              account: "environment credential (value not stored)",
              execution: "Act + Plan",
              billingSources: ["prepaid_credits" as const],
              agentRoles: [],
            }]
          : [];
      },
      async listProviders() {
        return [{
          id: "openrouter-api",
          displayName: "OpenRouter API",
          status: "runnable_byok" as const,
          supportStatus: "supported" as const,
          adapterKind: "model_provider" as const,
          accessKind: "api" as const,
          protocol: "openai_chat" as const,
          connectionOwner: "process_environment" as const,
          billing: {
            primarySource: "prepaid_credits" as const,
            possibleAdditionalSources: [],
            providerFallback: "none" as const,
          },
          restrictions: [],
        }];
      },
      async detectProviders() { return []; },
      async discoverEnvironmentModels(providerId, environmentVariable) {
        expect(providerId).toBe("openrouter-api");
        expect(environmentVariable).toBe("OPENROUTER_API_KEY");
        return [{
          id: "anthropic/claude-test",
          displayName: "Claude Test",
          createdAt: null,
          maxInputTokens: 200_000,
          maxOutputTokens: null,
        }];
      },
      async selectChoice(_message, choices) {
        const selected = selections.shift() ?? null;
        expect(choices.some((choice) => choice.id === selected)).toBe(true);
        return selected;
      },
      async promptText(message, suggestion) {
        expect(message).toContain("Environment variable");
        expect(suggestion).toBe("OPENROUTER_API_KEY");
        return suggestion ?? null;
      },
      async confirm(message) {
        expect(message).toContain("reviewed fixed HTTPS origin");
        return true;
      },
      async setupEnvironment(input) {
        configured = true;
        setupInput = input;
        return {
          id: "byok-1",
          label: "OpenRouter API BYOK",
          providerId: input.providerId,
          modelId: input.modelId,
          credentialEnvironmentVariable: input.credentialEnvironmentVariable,
          primary: true,
          billingSelection: input.billingSelection,
        };
      },
    });

    expect(exitCode).toBe(0);
    expect(setupInput).toEqual({
      providerId: "openrouter-api",
      modelId: "anthropic/claude-test",
      credentialEnvironmentVariable: "OPENROUTER_API_KEY",
      billingSelection: "strict_primary_only",
    });
    expect(runtimeOptions).toEqual([
      undefined,
      {
        operatingModeId: "balanced_v5",
        permissionMode: "approved_for_me",
        reuseExistingSession: false,
      },
    ]);
    expect(stdout.value).toContain(
      "Connection: OpenRouter API BYOK · anthropic/claude-test",
    );
    expect(stderr.value).toBe("");
  });

  it("selects an Anthropic model reported by the entered environment credential", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "recurs-guided-anthropic-"));
    directories.push(cwd);
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    const selections = [
      "byok:anthropic-api",
      "claude-sonnet-visible",
      "approved_for_me",
      "balanced_v5",
      "skip",
    ];
    let configured = false;
    let discovered: readonly string[] | undefined;
    let setupInput: unknown;
    const workspaceRuntime = {
      state: { type: "workspace", cwd: "/tmp/workspace", permissionMode: "ask_always" },
      setConfirmHandler() {},
      cancel() { return false; },
      async submit() { return { type: "quit" as const }; },
    } as unknown as RecursRuntime;
    const sessionRuntime = {
      state: { type: "session" },
      setConfirmHandler() {},
      cancel() { return false; },
      async submit() { return { type: "quit" as const }; },
    } as unknown as RecursRuntime;

    expect(await runCli([], {
      stdin: Readable.from(["/quit\n"]),
      stdout,
      stderr,
      cwd,
      interactive: true,
      automation: false,
      async createRuntime(_events, options) {
        return options === undefined ? workspaceRuntime : sessionRuntime;
      },
      async listAccounts() {
        return configured
          ? [{
              id: "byok-anthropic",
              label: "Anthropic API BYOK",
              providerId: "anthropic-api",
              adapterId: "anthropic-messages" as const,
              kind: "environment_model_provider" as const,
              modelId: "claude-sonnet-visible",
              primary: true,
              account: "environment credential (value not stored)",
              execution: "Act + Plan",
              billingSources: ["metered_api" as const],
              agentRoles: [],
            }]
          : [];
      },
      async listProviders() {
        return [{
          id: "anthropic-api",
          displayName: "Anthropic API",
          status: "runnable_byok" as const,
          supportStatus: "supported" as const,
          adapterKind: "model_provider" as const,
          accessKind: "api" as const,
          protocol: "anthropic_messages" as const,
          connectionOwner: "process_environment" as const,
          billing: {
            primarySource: "metered_api" as const,
            possibleAdditionalSources: [],
            providerFallback: "none" as const,
          },
          restrictions: [],
        }];
      },
      async detectProviders() { return []; },
      async discoverEnvironmentModels(providerId, environmentVariable) {
        discovered = [providerId, environmentVariable];
        return [{
          id: "claude-sonnet-visible",
          displayName: "Claude Sonnet Visible",
          createdAt: "2026-07-01T00:00:00Z",
          maxInputTokens: 200_000,
          maxOutputTokens: 64_000,
        }];
      },
      async selectChoice(_message, choices) {
        const selected = selections.shift() ?? null;
        expect(choices.some((choice) => choice.id === selected)).toBe(true);
        return selected;
      },
      async promptText(message, suggestion) {
        expect(message).toContain("Environment variable");
        expect(suggestion).toBe("ANTHROPIC_API_KEY");
        return suggestion ?? null;
      },
      async confirm() { return true; },
      async setupEnvironment(input) {
        configured = true;
        setupInput = input;
        return {
          id: "byok-anthropic",
          label: "Anthropic API BYOK",
          providerId: input.providerId,
          modelId: input.modelId,
          credentialEnvironmentVariable: input.credentialEnvironmentVariable,
          primary: true,
          billingSelection: input.billingSelection,
        };
      },
    })).toBe(0);

    expect(discovered).toEqual(["anthropic-api", "ANTHROPIC_API_KEY"]);
    expect(setupInput).toMatchObject({
      providerId: "anthropic-api",
      modelId: "claude-sonnet-visible",
      credentialEnvironmentVariable: "ANTHROPIC_API_KEY",
    });
    expect(stdout.value).toContain("Anthropic API BYOK · claude-sonnet-visible");
    expect(stderr.value).toBe("");
  });

  it("configures saved BYOK metadata after an explicit credential and billing disclosure", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    let disclosure = "";
    let received: unknown;
    const exitCode = await runCli([
      "setup", "byok",
      "--provider", "openrouter-api",
      "--model", "anthropic/claude-sonnet",
      "--key-env", "OPENROUTER_API_KEY",
    ], {
      stdout,
      stderr,
      interactive: true,
      automation: false,
      async createRuntime() { throw new Error("runtime must not start"); },
      async confirm(message) {
        disclosure = message;
        return true;
      },
      async setupEnvironment(input) {
        received = input;
        return {
          id: "byok:openrouter-api:stable",
          label: "OpenRouter API BYOK",
          providerId: input.providerId,
          modelId: input.modelId,
          credentialEnvironmentVariable:
            input.credentialEnvironmentVariable,
          primary: true,
          billingSelection: input.billingSelection,
        };
      },
    });

    expect(exitCode).toBe(0);
    expect(received).toEqual({
      providerId: "openrouter-api",
      modelId: "anthropic/claude-sonnet",
      credentialEnvironmentVariable: "OPENROUTER_API_KEY",
      billingSelection: "strict_primary_only",
    });
    expect(disclosure).toContain("one-way credential fingerprint");
    expect(disclosure).toContain("reviewed fixed HTTPS origin");
    expect(stdout.value).toContain("OPENROUTER_API_KEY (value not stored");
    expect(stdout.value).not.toContain("private");
    expect(stderr.value).toBe("");
  });

  it("supports explicit declared billing fallback and rejects unattended BYOK setup", async () => {
    const args = [
      "setup", "byok",
      "--provider", "opencode-go",
      "--model", "model",
      "--key-env", "OPENCODE_API_KEY",
      "--billing", "allow-additional",
    ];
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    let called = false;
    expect(await runCli(args, {
      stdout,
      stderr,
      interactive: false,
      automation: true,
      async createRuntime() { throw new Error("runtime must not start"); },
      async setupEnvironment() {
        called = true;
        throw new Error("unexpected");
      },
    })).toBe(2);
    expect(called).toBe(false);
    expect(stderr.value).toContain("interactive local terminal");

    const interactiveOut = new TextOutput();
    const interactiveErr = new TextOutput();
    let billing: string | undefined;
    expect(await runCli(args, {
      stdout: interactiveOut,
      stderr: interactiveErr,
      interactive: true,
      automation: false,
      async createRuntime() { throw new Error("runtime must not start"); },
      async confirm() { return true; },
      async setupEnvironment(input) {
        billing = input.billingSelection;
        return {
          id: "byok:opencode-go:stable",
          label: "OpenCode Go BYOK",
          providerId: input.providerId,
          modelId: input.modelId,
          credentialEnvironmentVariable:
            input.credentialEnvironmentVariable,
          primary: false,
          billingSelection: input.billingSelection,
        };
      },
    })).toBe(0);
    expect(billing).toBe("allow_declared_additional");
    expect(interactiveErr.value).toBe("");
  });

  it("rejects duplicate or unsafe BYOK flags before rendering a disclosure", async () => {
    for (const args of [
      [
        "setup", "byok", "--provider", "openrouter-api", "--model", "model",
        "--key-env", "OPENROUTER_API_KEY", "--billing", "strict",
        "--billing", "strict",
      ],
      [
        "setup", "byok", "--provider", "openrouter-api\nunsafe", "--model",
        "model", "--key-env", "OPENROUTER_API_KEY",
      ],
      [
        "setup", "byok", "--provider", "openrouter-api", "--model", "model",
        "--key-env", "OPENROUTER_CREDENTIAL",
      ],
    ]) {
      let confirmed = false;
      let configured = false;
      const stderr = new TextOutput();
      expect(await runCli(args, {
        stdout: new TextOutput(),
        stderr,
        interactive: true,
        automation: false,
        async createRuntime() { throw new Error("runtime must not start"); },
        async confirm() { confirmed = true; return true; },
        async setupEnvironment() {
          configured = true;
          throw new Error("setup must not start");
        },
      })).toBe(2);
      expect(confirmed).toBe(false);
      expect(configured).toBe(false);
      expect(stderr.value).toContain("recurs setup byok");
    }
  });

  it("renders local setup failures without an opaque diagnostic", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    const exitCode = await runCli([
      "setup", "local", "--url", "http://127.0.0.1:11434/v1", "--model", "missing",
    ], {
      stdout,
      stderr,
      async createRuntime() { throw new Error("runtime must not start"); },
      async setupLocal() {
        throw new LocalConnectionError("model_unavailable", "Selected local model was not reported by the server");
      },
    });
    expect(exitCode).toBe(2);
    expect(stderr.value).toBe("Error: Selected local model was not reported by the server\n");
    expect(stderr.value).not.toContain("diagnostic");
  });

  it("guides OpenAI API setup through exact disclosures and model selection", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    let received: unknown;
    const disclosure = openAIDisclosure;

    const exitCode = await runCli(["setup", "openai"], {
      stdout,
      stderr,
      interactive: true,
      async confirm(message) {
        expect(message).toContain("separate from ChatGPT");
        expect(message).toContain("system proxy");
        expect(message).toContain("native credential authority");
        return true;
      },
      async selectOpenAIModel(modelIds) {
        expect(modelIds).toEqual([
          "gpt-5.6-luna",
          "gpt-5.6-sol",
          "gpt-5.6-terra",
        ]);
        return "gpt-5.6-sol";
      },
      async createRuntime() {
        throw new Error("runtime must not start");
      },
      openAIOnboarding: {
        disclosure,
        modelIds: openAIModelIds,
        async setup(input) {
          received = input;
          return {
            state: "ready" as const,
            disposition: "created" as const,
            connection: {
              id: "71000000-0000-4000-8000-000000000001",
              label: "OpenAI API" as const,
              providerId: "openai-api" as const,
              adapterId: "openai-responses" as const,
              kind: "brokered_model_provider" as const,
              modelId: "gpt-5.6-sol",
              primary: true,
              account: "verified (identifier redacted)" as const,
              activation: "stored_pending_runtime_gate" as const,
              billingSources: ["metered_api"] as const,
            },
            cleanupPending: false,
          };
        },
        async recover() {
          return { state: "none" as const };
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(received).toEqual({
      modelId: "gpt-5.6-sol",
      acknowledgement: {
        policyRevision: disclosure.policyRevision,
        billingPolicyRevision: disclosure.billingPolicyRevision,
        billingDisclosureRevision: disclosure.billingDisclosureRevision,
        mode: "strict_primary_only",
      },
    });
    expect(stdout.value).toContain("Stored — OpenAI API · gpt-5.6-sol");
    expect(stdout.value).toContain("ready through the signed native authority");
    expect(stdout.value).not.toContain("Ready —");
    expect(stdout.value).not.toContain("sha256:");
    expect(stderr.value).toBe("");
  });

  it("activates Anthropic with an exact model through the native authority", async () => {
    const stdout = new TextOutput();
    let received: unknown;
    const disclosure = {
      ...openAIDisclosure,
      providerId: "anthropic-api" as const,
      displayName: "Anthropic API" as const,
      endpoint: "https://api.anthropic.com/v1" as const,
      billingNotice:
        "Anthropic API billing is separate from Claude subscriptions." as const,
      capabilityProfileRevision: "anthropic-messages-v1" as const,
    };

    const exitCode = await runCli(
      ["setup", "anthropic", "--model", "claude-opus-4-6"],
      {
        stdout,
        stderr: new TextOutput(),
        interactive: true,
        automation: false,
        async confirm(message) {
          expect(message).toContain("separate from Claude subscriptions");
          return true;
        },
        async createRuntime() {
          throw new Error("runtime must not start");
        },
        anthropicOnboarding: {
          provider: "anthropic",
          disclosure,
          modelIds: [],
          async setup(input) {
            received = input;
            return {
              state: "ready" as const,
              disposition: "created" as const,
              connection: {
                id: "71000000-0000-4000-8000-000000000001",
                label: "Anthropic API" as const,
                providerId: "anthropic-api" as const,
                adapterId: "anthropic-messages" as const,
                kind: "brokered_model_provider" as const,
                modelId: "claude-opus-4-6",
                primary: true,
                account: "verified (identifier redacted)" as const,
                activation: "stored_pending_runtime_gate" as const,
                billingSources: ["metered_api"] as const,
              },
              cleanupPending: false,
            };
          },
          async recover() { return { state: "none" as const }; },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(received).toMatchObject({
      provider: "anthropic",
      modelId: "claude-opus-4-6",
    });
    expect(stdout.value).toContain("Stored — Anthropic API · claude-opus-4-6");
  });

  it("activates a Kimi Code plan with an exact model", async () => {
    const stdout = new TextOutput();
    let received: unknown;
    const disclosure = {
      ...openAIDisclosure,
      providerId: "kimi-code" as const,
      displayName: "Kimi Code" as const,
      endpoint: "https://api.kimi.com/coding/v1" as const,
      primaryBillingSource: "included_subscription" as const,
      billingNotice:
        "Kimi Code usage is governed by the connected coding-plan subscription." as const,
      capabilityProfileRevision: "openai-chat-completions-v1" as const,
    };

    const exitCode = await runCli(
      ["setup", "kimi", "--model", "kimi-k2.5"],
      {
        stdout,
        stderr: new TextOutput(),
        interactive: true,
        automation: false,
        async confirm(message) {
          expect(message).toContain("coding-plan subscription");
          return true;
        },
        kimiOnboarding: {
          provider: "kimi",
          disclosure,
          modelIds: [],
          async setup(input) {
            received = input;
            return {
              state: "ready" as const,
              disposition: "created" as const,
              connection: {
                id: "71000000-0000-4000-8000-000000000001",
                label: "Kimi Code" as const,
                providerId: "kimi-code" as const,
                adapterId: "openai-chat-completions" as const,
                kind: "brokered_model_provider" as const,
                modelId: "kimi-k2.5",
                primary: true,
                account: "verified (identifier redacted)" as const,
                activation: "stored_pending_runtime_gate" as const,
                billingSources: ["included_subscription"] as const,
              },
              cleanupPending: false,
            };
          },
          async recover() { return { state: "none" as const }; },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(received).toMatchObject({ provider: "kimi", modelId: "kimi-k2.5" });
    expect(stdout.value).toContain("Stored — Kimi Code · kimi-k2.5");
  });

  it("never starts OpenAI credential capture without every local consent gate", async () => {
    for (const [argv, interactive, automation, accepted] of [
      [["setup", "openai"], false, false, true],
      [["setup", "openai"], true, true, true],
      [["setup", "openai"], true, false, false],
      [["setup", "openai", "--model", "gpt-5.6"], true, false, true],
      [["setup", "openai", "--model"], true, false, true],
    ] as const) {
      let setupCalls = 0;
      const stderr = new TextOutput();
      const exitCode = await runCli(argv, {
        stdout: new TextOutput(),
        stderr,
        interactive,
        automation,
        async confirm() { return accepted; },
        async selectOpenAIModel() { return "gpt-5.6-sol"; },
        async createRuntime() { throw new Error("runtime must not start"); },
        openAIOnboarding: {
          disclosure: openAIDisclosure,
          modelIds: openAIModelIds,
          async setup() {
            setupCalls += 1;
            throw new Error("setup must not start");
          },
          async recover() { return { state: "none" }; },
        },
      });
      expect(exitCode).toBe(2);
      expect(setupCalls).toBe(0);
      expect(stderr.value).not.toContain("sk-");
    }
  });

  it("recovers interrupted OpenAI setup and safely handles native failures", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    let recoveryCalls = 0;
    const base = {
      stdout,
      stderr,
      interactive: true,
      automation: false,
      async createRuntime() { throw new Error("runtime must not start"); },
      openAIOnboarding: {
        disclosure: openAIDisclosure,
        modelIds: openAIModelIds,
        async setup() { throw new Error("setup must not start"); },
        async recover() {
          recoveryCalls += 1;
          return recoveryCalls === 1
            ? { state: "discarded" as const, connectionId: "openai-1" }
            : Promise.reject(new Error(`sk-proj-${"X".repeat(48)}`));
        },
      },
    };

    expect(await runCli(["setup", "openai", "--recover"], base)).toBe(0);
    expect(stdout.value).toContain("discarded inactive OpenAI activation openai-1");
    expect(await runCli(["setup", "openai", "--recover"], base)).toBe(2);
    expect(stderr.value).toMatch(/Error: Unexpected failure \(diagnostic [^)]+\)\n/u);
    expect(stderr.value).not.toContain("sk-proj-");
  });

  it("runs interactive Codex onboarding only after the billing disclosure is accepted", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    const workspace = "/tmp/recurs-codex-workspace";
    let received: unknown;
    const exitCode = await runCli(["setup", "codex"], {
      stdout,
      stderr,
      cwd: workspace,
      interactive: true,
      async confirm(message) {
        expect(message).toContain("prepaid credits");
        expect(message).toContain("automatically");
        return true;
      },
      async createRuntime() { throw new Error("runtime must not start"); },
      async setupCodex(input) {
        received = input;
        return {
          id: "codex-1",
          label: "Codex with ChatGPT",
          modelId: "gpt-test",
          planOnly: true,
          primary: false,
        };
      },
    });

    expect(exitCode).toBe(0);
    expect(received).toEqual({
      cwd: workspace,
      interactive: true,
      billingSelection: "allow_declared_additional",
    });
    expect(stdout.value).toContain("Codex with ChatGPT · gpt-test");
    expect(stdout.value).toContain("Plan-only");
    expect(stdout.value).toContain("Saved as secondary");
    expect(stdout.value).toContain("account set-primary");
    expect(stdout.value).not.toContain("owner@example.com");
    expect(stderr.value).toBe("");
  });

  it("never launches Codex login from noninteractive or declined setup", async () => {
    for (const [interactive, automation, accepted] of [
      [false, false, true],
      [true, false, false],
      [true, true, true],
    ] as const) {
      const stdout = new TextOutput();
      const stderr = new TextOutput();
      let setupCalls = 0;
      const exitCode = await runCli(["setup", "codex"], {
        stdout,
        stderr,
        cwd: "/tmp/workspace",
        interactive,
        automation,
        async confirm() { return accepted; },
        async createRuntime() { throw new Error("runtime must not start"); },
        async setupCodex() {
          setupCalls += 1;
          return {
            id: "codex-1",
            label: "Codex with ChatGPT",
            modelId: "gpt-test",
            planOnly: true,
            primary: false,
          };
        },
      });
      expect(exitCode).toBe(2);
      expect(setupCalls).toBe(0);
      expect(stderr.value).not.toContain("owner@example.com");
    }
  });

  it("renders provider catalog text/JSON and redacted account JSON", async () => {
    const provider = {
      id: "openai-codex-chatgpt",
      displayName: "Codex with ChatGPT",
      status: "runnable" as const,
      supportStatus: "conditional" as const,
      adapterKind: "agent_runtime" as const,
      accessKind: "subscription" as const,
      protocol: "acp" as const,
      connectionOwner: "vendor_runtime" as const,
      billing: {
        primarySource: "included_subscription" as const,
        possibleAdditionalSources: ["prepaid_credits" as const],
        providerFallback: "automatic" as const,
      },
      restrictions: ["Local, user-present use only."],
    };
    const account = {
      id: "codex-1",
      label: "Codex with ChatGPT",
      providerId: "openai-codex-chatgpt",
      adapterId: "codex-acp",
      kind: "delegated_agent" as const,
      modelId: "gpt-test",
      primary: true,
      account: "verified (identifier redacted)" as const,
      execution: "Plan-only" as const,
      billingSources: [
        "included_subscription" as const,
        "prepaid_credits" as const,
      ],
      agentRoles: [] as const,
    };
    for (const argv of [
      ["provider", "list"],
      ["provider", "list", "--all", "--json"],
      ["account", "list", "--json"],
    ]) {
      const stdout = new TextOutput();
      const stderr = new TextOutput();
      let includeBlocked: boolean | undefined;
      const code = await runCli(argv, {
        stdout,
        stderr,
        async createRuntime() { throw new Error("runtime must not start"); },
        async listProviders(input) {
          includeBlocked = input.includeBlocked;
          return [provider];
        },
        async listAccounts() { return [account]; },
      });
      expect(code).toBe(0);
      expect(stderr.value).toBe("");
      expect(stdout.value).toContain("openai-codex-chatgpt");
      if (argv[0] === "provider") {
        expect(stdout.value).toContain("vendor_runtime");
      }
      if (argv[0] === "provider" && argv.includes("--all")) {
        expect(includeBlocked).toBe(true);
        expect(JSON.parse(stdout.value)).toMatchObject({
          version: 1,
          providers: [{ status: "runnable" }],
        });
      }
      if (argv[0] === "account") {
        expect(JSON.parse(stdout.value)).toMatchObject({
          version: 1,
          accounts: [{ account: "verified (identifier redacted)" }],
        });
        expect(stdout.value).not.toContain("owner@example.com");
        expect(stdout.value).not.toContain("accountSubjectFingerprint");
      }
    }
  });

  it("discovers the public catalog and fixed local runtimes as separate sources", async () => {
    const catalogOut = new TextOutput();
    const catalogErr = new TextOutput();
    let query: string | undefined;
    expect(await runCli(["provider", "catalog", "kimi", "coding", "--json"], {
      stdout: catalogOut,
      stderr: catalogErr,
      async createRuntime() { throw new Error("runtime must not start"); },
      async discoverProviders(value) {
        query = value;
        return {
          source: "https://models.dev/api.json",
          providers: [{
            id: "kimi-for-coding",
            name: "Kimi For Coding",
            wire: "openai-compatible",
            modelCount: 2,
            modelIds: ["k2p7", "k3"],
          }],
        };
      },
    })).toBe(0);
    expect(query).toBe("kimi coding");
    expect(JSON.parse(catalogOut.value)).toMatchObject({
      version: 1,
      source: "https://models.dev/api.json",
      providers: [{ id: "kimi-for-coding" }],
    });
    expect(catalogErr.value).toBe("");

    const localOut = new TextOutput();
    const localErr = new TextOutput();
    expect(await runCli(["provider", "detect"], {
      stdout: localOut,
      stderr: localErr,
      async createRuntime() { throw new Error("runtime must not start"); },
      async detectProviders() {
        return [{
          id: "ollama",
          name: "Ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          detected: true,
        }];
      },
    })).toBe(0);
    expect(localOut.value).toContain("Ollama — detected");
    expect(localErr.value).toBe("");
  });

  it("renders credential-visible provider models in text and JSON", async () => {
    const models = [{
      id: "claude-sonnet-visible",
      displayName: "Claude Sonnet Visible",
      createdAt: "2026-07-01T00:00:00Z",
      maxInputTokens: 200_000,
      maxOutputTokens: 64_000,
    }];
    for (const json of [false, true]) {
      const stdout = new TextOutput();
      const stderr = new TextOutput();
      let received: readonly string[] | undefined;
      const argv = [
        "provider", "models",
        "--provider", "anthropic-api",
        "--key-env", "ANTHROPIC_API_KEY",
        ...(json ? ["--json"] : []),
      ];
      expect(await runCli(argv, {
        stdout,
        stderr,
        async createRuntime() { throw new Error("runtime must not start"); },
        async discoverEnvironmentModels(providerId, environmentVariable) {
          received = [providerId, environmentVariable];
          return models;
        },
      })).toBe(0);
      expect(received).toEqual(["anthropic-api", "ANTHROPIC_API_KEY"]);
      if (json) {
        expect(JSON.parse(stdout.value)).toMatchObject({
          version: 1,
          providerId: "anthropic-api",
          models: [{ id: "claude-sonnet-visible" }],
        });
      } else {
        expect(stdout.value).toContain("Credential-visible models for anthropic-api");
        expect(stdout.value).toContain(
          "Claude Sonnet Visible — claude-sonnet-visible",
        );
        expect(stdout.value).toContain("Input: 200000 tokens");
      }
      expect(stderr.value).toBe("");
    }
  });

  it("renders a safe provider-model authentication failure", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    expect(await runCli([
      "provider", "models",
      "--provider", "anthropic-api",
      "--key-env", "ANTHROPIC_API_KEY",
    ], {
      stdout,
      stderr,
      async createRuntime() { throw new Error("runtime must not start"); },
      async discoverEnvironmentModels() {
        throw new EnvironmentConnectionError(
          "credential_rejected",
          "The provider rejected the environment credential",
        );
      },
    })).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toBe(
      "Error: The provider rejected the environment credential\n",
    );
  });

  it("rejects malformed provider/account list flags without calling services", async () => {
    for (const argv of [
      ["provider", "list", "--bad"],
      ["provider", "show"],
      ["provider", "models", "--provider", "anthropic-api", "--key-env", "ANTHROPIC_CREDENTIAL"],
      ["account", "list", "--all"],
    ]) {
      const stdout = new TextOutput();
      const stderr = new TextOutput();
      let called = false;
      expect(await runCli(argv, {
        stdout,
        stderr,
        async createRuntime() { throw new Error("runtime must not start"); },
        async listProviders() { called = true; return []; },
        async listAccounts() { called = true; return []; },
      })).toBe(2);
      expect(called).toBe(false);
      expect(stderr.value).toContain("provider list");
    }
  });

  it("selects one exact primary account and renders pin-preserving copy", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    let selected: string | undefined;

    const code = await runCli(["account", "set-primary", "codex-1"], {
      stdout,
      stderr,
      async createRuntime() { throw new Error("runtime must not start"); },
      async setPrimaryAccount(id) {
        selected = id;
        return {
          id,
          label: "Codex with ChatGPT",
          providerId: "openai-codex-chatgpt",
          adapterId: "codex-acp",
          kind: "delegated_agent",
          modelId: "gpt-test",
          primary: true,
          account: "verified (identifier redacted)",
          execution: "Plan-only",
          billingSources: ["included_subscription", "prepaid_credits"],
          agentRoles: [],
        };
      },
    });

    expect(code).toBe(0);
    expect(selected).toBe("codex-1");
    expect(stdout.value).toContain("Primary connection — codex-1");
    expect(stdout.value).toContain("Existing sessions keep their pinned backend");
    expect(stderr.value).toBe("");
  });

  it("confirms and assigns or clears one exact team-agent route", async () => {
    for (const [target, expected] of [
      ["worker-1", "worker-1"],
      ["parent", null],
    ] as const) {
      const stdout = new TextOutput();
      const stderr = new TextOutput();
      let assigned: { role: string; id: string | null } | undefined;
      const code = await runCli(["account", "route", "implement", target], {
        stdout,
        stderr,
        interactive: true,
        automation: false,
        async confirm(message) {
          expect(message).toContain("provider billing still applies");
          return true;
        },
        async createRuntime() { throw new Error("runtime must not start"); },
        async setAccountAgentRoute(role, id) {
          assigned = { role, id };
          return { role, connectionId: id };
        },
      });
      expect(code).toBe(0);
      expect(assigned).toEqual({ role: "implement", id: expected });
      expect(stdout.value).toContain(
        expected === null ? "inherit the parent backend" : "when the operating mode",
      );
      expect(stderr.value).toBe("");
    }
  });

  it("verifies one exact account only from a local manual terminal", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    let verified: string | undefined;

    expect(await runCli(["account", "verify", "local-1"], {
      stdout,
      stderr,
      cwd: "/tmp/workspace",
      interactive: true,
      automation: false,
      async createRuntime() { throw new Error("runtime must not start"); },
      async verifyAccount(id) {
        verified = id;
        return {
          verified: true,
          connection: {
            id,
            label: "Local model",
            providerId: "local-openai-compatible",
            adapterId: "openai-chat-completions",
            kind: "local_openai_compatible",
            modelId: "qwen",
            primary: true,
            account: "local endpoint (no credential)",
            execution: "Act + Plan",
            billingSources: ["local_compute"],
          },
        };
      },
    })).toBe(0);

    expect(verified).toBe("local-1");
    expect(stdout.value).toContain("Verified — local-1 · qwen");
    expect(stderr.value).toBe("");

    const byokOutput = new TextOutput();
    expect(await runCli(["account", "verify", "byok-1"], {
      stdout: byokOutput,
      stderr: new TextOutput(),
      cwd: "/tmp/workspace",
      interactive: true,
      automation: false,
      async createRuntime() { throw new Error("runtime must not start"); },
      async verifyAccount(id) {
        return {
          verified: true,
          connection: {
            id,
            label: "OpenRouter BYOK",
            providerId: "openrouter-api",
            adapterId: "openai-chat-completions",
            kind: "environment_model_provider",
            modelId: "provider/model",
            primary: true,
            account: "environment credential (value not stored)",
            execution: "Act + Plan",
            billingSources: ["prepaid_credits"],
          },
        };
      },
    })).toBe(0);
    expect(byokOutput.value).toContain("Credential binding verified — byok-1");

    for (const [interactive, automation] of [
      [false, false],
      [true, true],
    ] as const) {
      let called = false;
      expect(await runCli(["account", "verify", "local-1"], {
        stdout: new TextOutput(),
        stderr: new TextOutput(),
        interactive,
        automation,
        async createRuntime() { throw new Error("runtime must not start"); },
        async verifyAccount() { called = true; throw new Error("unexpected"); },
      })).toBe(2);
      expect(called).toBe(false);
    }
  });

  it("disconnects metadata only after explicit local confirmation", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    let disconnected: string | undefined;

    expect(await runCli(["account", "disconnect", "codex-1"], {
      stdout,
      stderr,
      interactive: true,
      automation: false,
      async confirm(message) {
        expect(message).toContain("vendor authentication");
        expect(message).toContain("codex-1");
        return true;
      },
      async createRuntime() { throw new Error("runtime must not start"); },
      async disconnectAccount(id) {
        disconnected = id;
        return {
          connectionId: id,
          primaryCleared: true,
          remainingConnections: 1,
        };
      },
    })).toBe(0);

    expect(disconnected).toBe("codex-1");
    expect(stdout.value).toContain("Disconnected codex-1");
    expect(stdout.value).toContain("Vendor authentication was not changed");
    expect(stderr.value).toBe("");

    for (const [interactive, automation, accepted] of [
      [false, false, true],
      [true, true, true],
      [true, false, false],
    ] as const) {
      let called = false;
      expect(await runCli(["account", "disconnect", "codex-1"], {
        stdout: new TextOutput(),
        stderr: new TextOutput(),
        interactive,
        automation,
        async confirm() { return accepted; },
        async createRuntime() { throw new Error("runtime must not start"); },
        async disconnectAccount() { called = true; throw new Error("unexpected"); },
      })).toBe(2);
      expect(called).toBe(false);
    }
  });

  it("rejects malformed account mutations before calling lifecycle services", async () => {
    for (const argv of [
      ["account", "set-primary"],
      ["account", "set-primary", "codex-1", "extra"],
      ["account", "verify", "--json"],
      ["account", "disconnect", "codex-1", "--yes"],
      ["account", "disconnect", "bad\u001b[31m-id"],
      ["account", "set-primary", "bad\u202e-id"],
      ["account", "route", "explore", "codex-1"],
      ["account", "route", "review", "bad id"],
      ["account", "unknown", "codex-1"],
    ]) {
      let called = false;
      let confirmCalls = 0;
      const stdout = new TextOutput();
      const stderr = new TextOutput();
      expect(await runCli(argv, {
        stdout,
        stderr,
        interactive: true,
        automation: false,
        async confirm() { confirmCalls += 1; return true; },
        async createRuntime() { throw new Error("runtime must not start"); },
        async setPrimaryAccount() { called = true; throw new Error("unexpected"); },
        async verifyAccount() { called = true; throw new Error("unexpected"); },
        async disconnectAccount() { called = true; throw new Error("unexpected"); },
      })).toBe(2);
      expect(called).toBe(false);
      expect(confirmCalls).toBe(0);
      expect(stdout.value).toBe("");
      expect(stderr.value).toContain("account set-primary");
    }
  });

  it("maps lifecycle configuration and cancellation failures to stable exit codes", async () => {
    const configurationStderr = new TextOutput();
    expect(await runCli(["account", "set-primary", "missing"], {
      stdout: new TextOutput(),
      stderr: configurationStderr,
      async createRuntime() { throw new Error("runtime must not start"); },
      async setPrimaryAccount() {
        throw new ConnectionLifecycleError(
          "connection_not_found",
          "Connection not found",
        );
      },
    })).toBe(2);
    expect(configurationStderr.value).toBe("Error: Connection not found\n");

    const cancellationStderr = new TextOutput();
    expect(await runCli(["account", "verify", "codex-1"], {
      stdout: new TextOutput(),
      stderr: cancellationStderr,
      interactive: true,
      automation: false,
      async createRuntime() { throw new Error("runtime must not start"); },
      async verifyAccount() {
        throw new ConnectionLifecycleError(
          "cancelled",
          "Connection operation was cancelled",
        );
      },
    })).toBe(130);
    expect(cancellationStderr.value).toContain("cancelled");
  });

  it("preserves a canonical provider failure through standalone coordination", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-provider-final-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    const canary = "RECURS_STANDALONE_PROVIDER_CANARY";
    const provider = new ScriptedProvider([
      new ProviderError("authentication", canary, false),
    ]);

    const exitCode = await runCli(["run", "inspect"], {
      stdout,
      stderr,
      createRuntime: (events) => createStandaloneRuntime(events, {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        provider,
      }),
    });

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("Error: Provider authentication failed\n");
    expect(`${stdout.value}${stderr.value}`).not.toContain(canary);
  });

  it("renders an unknown started failure with the coordinator diagnostic id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-started-final-"));
    directories.push(root);
    const sessions = new JsonlSessionStore(path.join(root, "sessions"));
    const pin = testBackendPin();
    await sessions.createPinnedSession({
      id: "s1",
      at: testAt,
      cwd: root,
      backend: pin,
    });
    const diagnosticId = "00000000-0000-4000-8000-000000000123";
    const canary = "RECURS_UNKNOWN_STARTED_CANARY";
    const resolver: BackendResolver = {
      async resolve(input) {
        return {
          kind: "direct",
          pin,
          authorization: bindRunAuthorization({
            id: "authorization",
            operation: "run",
            sessionId: input.sessionId,
            operationId: input.operationId,
            turnId: input.turnId,
            pin,
            connectionRevision: 1,
            policyRevision: pin.policyRevisionAtCreation,
            context: input.context,
            maxRequests: 1,
            expiresAt: "2099-01-01T00:00:00.000Z",
          }, new Date(testAt)),
          async createProvider() {
            return new ScriptedProvider([]);
          },
        };
      },
    };
    const coordinator = new BackendRunCoordinator({
      sessions,
      resolver,
      direct: {
        async run() {
          throw new Error(canary, { cause: new Error(`${canary}_CAUSE`) });
        },
      },
      createId: () => diagnosticId,
    });
    const stdout = new TextOutput();
    const stderr = new TextOutput();

    const exitCode = await runCli(["run", "inspect"], {
      stdout,
      stderr,
      async createRuntime() {
        return new RecursRuntime(
          {
            commands: createCommandRegistry({ sessions }),
            coordinator,
            sessions,
            confirm: async () => false,
          },
          await sessions.loadState("s1"),
        );
      },
    });

    expect(exitCode).toBe(1);
    expect(stdout.value).toBe("");
    expect(stderr.value).toBe(
      `Error: Unexpected failure (diagnostic ${diagnosticId})\n`,
    );
    expect(stderr.value.match(new RegExp(diagnosticId, "gu"))).toHaveLength(1);
    expect(stderr.value).not.toContain(canary);
  });

  it.each(["text", "jsonl"] as const)(
    "renders unknown one-shot %s failures with one diagnostic and no raw message",
    async (format) => {
      const stdout = new TextOutput();
      const stderr = new TextOutput();
      const canary = `RECURS_ONE_SHOT_${format.toUpperCase()}_CANARY`;

      const exitCode = await runCli(
        ["run", "inspect", "--format", format],
        {
          stdout,
          stderr,
          async createRuntime() {
            throw new Error(canary, {
              cause: new Error("RECURS_ONE_SHOT_CAUSE_CANARY"),
            });
          },
        },
      );

      expect(exitCode).toBe(1);
      expect(stdout.value).toBe("");
      expect(stderr.value).toMatch(
        /^Error: Unexpected failure \(diagnostic [0-9a-f-]{36}\)\n$/u,
      );
      expect(`${stdout.value}${stderr.value}`).not.toContain(canary);
      expect(`${stdout.value}${stderr.value}`).not.toContain(
        "RECURS_ONE_SHOT_CAUSE_CANARY",
      );
      expect(stderr.value.match(/diagnostic/gu)).toHaveLength(1);
    },
  );

  it("emits normalized JSONL events in run mode", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();

    const exitCode = await runCli(
      ["run", "inspect", "--format", "jsonl"],
      dependencies(stdout, stderr),
    );
    const events = stdout.value
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; version?: number });

    expect(exitCode).toBe(0);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["turn_started", "model_completed", "turn_completed"]),
    );
    expect(events.every((event) => event.version === undefined)).toBe(true);
    expect(stderr.value).toBe("");
  });

  it.each([
    ["ask", "ask_always"],
    ["approved", "approved_for_me"],
    ["full", "full_access"],
  ] as const)(
    "pins the explicit %s permission preset into a fresh one-shot session",
    async (value, permissionMode) => {
      const stdout = new TextOutput();
      const stderr = new TextOutput();
      let runtimeOptions: unknown;

      const exitCode = await runCli(
        ["run", "inspect", "--permissions", value, "--format", "jsonl"],
        {
          stdout,
          stderr,
          async createRuntime(events, options) {
            runtimeOptions = options;
            return createRuntime(events);
          },
        },
      );

      expect(exitCode).toBe(0);
      expect(runtimeOptions).toEqual({
        permissionMode,
        reuseExistingSession: false,
      });
      expect(stderr.value).toBe("");
    },
  );

  it.each([
    ["run", "inspect", "--permissions"],
    ["run", "inspect", "--permissions", "unknown"],
    [
      "run", "inspect", "--permissions", "ask",
      "--permissions", "full",
    ],
  ])("rejects invalid one-shot permission flags before runtime creation", async (...args) => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    let created = false;

    const exitCode = await runCli(args, {
      stdout,
      stderr,
      async createRuntime(events) {
        created = true;
        return createRuntime(events);
      },
    });

    expect(exitCode).toBe(2);
    expect(created).toBe(false);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("recurs run <prompt>");
  });

  it("streams plain text without duplicating the final answer", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();

    const exitCode = await runCli(
      ["run", "inspect", "--format", "text"],
      dependencies(stdout, stderr),
    );

    expect(exitCode).toBe(0);
    expect(stdout.value.match(/inspection complete/gu)).toHaveLength(1);
    expect(stderr.value).toBe("");
  });

  it("returns usage errors without creating a runtime", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    let created = false;

    const exitCode = await runCli(["run", "--format", "xml"], {
      stdout,
      stderr,
      async createRuntime(sink) {
        created = true;
        return createRuntime(sink);
      },
    });

    expect(exitCode).toBe(2);
    expect(created).toBe(false);
    expect(stderr.value).toContain("Usage:");
  });

  it("prints help without requiring a provider", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();

    expect(
      await runCli(["--help"], {
        stdout,
        stderr,
        async createRuntime() {
          throw new Error("must not create runtime");
        },
      }),
    ).toBe(0);
    expect(stdout.value).toContain("recurs run <prompt>");
    expect(stdout.value).toContain("--permissions ask|approved|full");
  });

  it("prints exact redacted native authority diagnostics as text and JSON", async () => {
    const status = {
      state: "ready" as const,
      attestation: {
        protocolVersion: 1 as const,
        launcherVersion: NATIVE_COMPONENT_VERSION,
        brokerVersion: NATIVE_COMPONENT_VERSION,
        platform: "darwin" as const,
        minimumMacosVersion: "14.4" as const,
        productionSigned: true,
        persistentCredentials: true,
        injectedPath: "/SECRET_NATIVE_PATH_CANARY",
      },
      health: {
        keychain: "available" as const,
        broker: "available" as const,
        peerIdentity: "verified" as const,
        injectedDescriptor: "SECRET_NATIVE_FD_CANARY",
      },
      injectedAccount: "SECRET_NATIVE_ACCOUNT_CANARY",
    };
    let runtimeCreated = false;
    const nativeAuthority: NativeAuthorityStatusPort = {
      async status() {
        return status;
      },
    };

    for (const [argv, json] of [
      [["doctor", "native"], false],
      [["doctor", "native", "--json"], true],
    ] as const) {
      const stdout = new TextOutput();
      const stderr = new TextOutput();

      const exitCode = await runCli(argv, {
        stdout,
        stderr,
        nativeAuthority,
        async createRuntime() {
          runtimeCreated = true;
          throw new Error("runtime must not start");
        },
      });

      expect(exitCode).toBe(0);
      expect(stderr.value).toBe("");
      expect(stdout.value).toContain(NATIVE_COMPONENT_VERSION);
      expect(stdout.value).toContain("available");
      if (json) {
        expect(JSON.parse(stdout.value)).toEqual({
          version: 1,
          nativeAuthority: {
            state: "ready",
            attestation: {
              protocolVersion: 1,
              launcherVersion: NATIVE_COMPONENT_VERSION,
              brokerVersion: NATIVE_COMPONENT_VERSION,
              platform: "darwin",
              minimumMacosVersion: "14.4",
              productionSigned: true,
              persistentCredentials: true,
            },
            health: {
              keychain: "available",
              broker: "available",
              peerIdentity: "verified",
            },
          },
        });
      }
      expect(stdout.value).not.toMatch(
        /SECRET_NATIVE|injected|account|descriptor|path/iu,
      );
    }
    expect(runtimeCreated).toBe(false);
  });

  it("prints fixed unavailable native status and rejects invalid doctor flags", async () => {
    let calls = 0;
    const nativeAuthority: NativeAuthorityStatusPort = {
      async status() {
        calls += 1;
        return {
          state: "unavailable",
          reason: "production_signing_required",
        };
      },
    };

    for (const argv of [
      ["doctor", "native", "--bad"],
      ["doctor", "native", "--json", "--json"],
      ["doctor", "other"],
    ]) {
      const stdout = new TextOutput();
      const stderr = new TextOutput();
      expect(await runCli(argv, {
        stdout,
        stderr,
        nativeAuthority,
        async createRuntime() {
          throw new Error("runtime must not start");
        },
      })).toBe(2);
      expect(stdout.value).toBe("");
      expect(stderr.value).toContain("doctor native");
    }
    expect(calls).toBe(0);

    const stdout = new TextOutput();
    const stderr = new TextOutput();
    expect(await runCli(["doctor", "native", "--json"], {
      stdout,
      stderr,
      nativeAuthority,
      async createRuntime() {
        throw new Error("runtime must not start");
      },
    })).toBe(0);
    expect(JSON.parse(stdout.value)).toEqual({
      version: 1,
      nativeAuthority: {
        state: "unavailable",
        reason: "production_signing_required",
      },
    });
    expect(stderr.value).toBe("");
    expect(calls).toBe(1);
  });

  it("maps native diagnostic cancellation to exit 130 without its reason", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const nativeAuthority: NativeAuthorityStatusPort = {
      async status(signal) {
        receivedSignal = signal;
        throw new DOMException(
          "The operation was aborted.",
          "AbortError",
        );
      },
    };

    expect(await runCli(["doctor", "native"], {
      stdout,
      stderr,
      nativeAuthority,
      signal: controller.signal,
      async createRuntime() {
        throw new Error("runtime must not start");
      },
    })).toBe(130);
    expect(receivedSignal).toBe(controller.signal);
    expect(stdout.value).toBe("");
    expect(stderr.value).toBe("Error: Native authority check was cancelled\n");
  });

  it("opens the interactive CLI and routes local quit without a prompt run", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();

    const exitCode = await runCli([], {
      stdin: Readable.from(["/quit\n"]),
      stdout,
      stderr,
      interactive: true,
      createRuntime,
    });

    expect(exitCode).toBe(0);
    expect(stdout.value).toContain("Recurs — local harness mode");
    expect(stderr.value).toBe("");
  });

  it("marks an interactive REPL with exact user-present provenance", async () => {
      const stdout = new TextOutput();
      const stderr = new TextOutput();
      let invocation: HostInvocation | undefined;
      const runtime = {
        setConfirmHandler() {},
        cancel() { return false; },
        async submit(_input: string, received?: HostInvocation) {
          invocation = received;
          return {
            finalText: "done",
            stopReason: "complete",
            usage: null,
            changedFiles: [],
            evidence: [],
          };
        },
      } as unknown as RecursRuntime;

      expect(await runCli([], {
        stdin: Readable.from(["inspect\n"]),
        stdout,
        stderr,
        interactive: true,
        automation: false,
        async createRuntime() { return runtime; },
      })).toBe(0);

      expect(invocation).toMatchObject({
        invocation: "repl",
        userPresent: true,
        remote: false,
        scripted: false,
        embedding: "cli",
      });
      expect(stderr.value).toBe("");
  });

  it.each([
    [false, false],
    [true, true],
  ] as const)(
    "rejects interactive CLI startup for interactive=%s automation=%s",
    async (interactive, automation) => {
      const stdout = new TextOutput();
      const stderr = new TextOutput();
      let created = false;

      expect(await runCli([], {
        stdin: Readable.from(["inspect\n"]),
        stdout,
        stderr,
        interactive,
        automation,
        async createRuntime() {
          created = true;
          return await createRuntime({ async emit() {} });
        },
      })).toBe(2);
      expect(created).toBe(false);
      expect(stdout.value).toBe("");
      expect(stderr.value).toContain("user-present local terminal");
      expect(stderr.value).toContain("recurs run");
    },
  );

  it.each([
    [
      new RuntimeError("provider_not_configured", "provider missing"),
      2,
      "provider missing",
    ],
    [
      new AgentLoopError("cancelled", "RECURS_AGENT_CANCEL_CANARY"),
      130,
      "Agent run cancelled",
    ],
    [
      new AgentLoopError("provider_failed", "RECURS_AGENT_PROVIDER_CANARY"),
      1,
      "Provider request failed",
    ],
    [
      new AgentLoopError("stuck_loop", "RECURS_AGENT_TOOL_NAME_CANARY"),
      1,
      "Repeated tool interaction detected",
    ],
  ] as const)("maps terminal errors to documented exit codes", async (
    error,
    code,
    safeMessage,
  ) => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();

    const exitCode = await runCli(["run", "inspect"], {
      stdout,
      stderr,
      async createRuntime() {
        return {
          async submit() {
            throw error;
          },
        } as unknown as RecursRuntime;
      },
    });

    expect(exitCode).toBe(code);
    expect(stderr.value).toContain(safeMessage);
    if (error.message !== safeMessage) {
      expect(stderr.value).not.toContain(error.message);
    }
  });

  it("emits a machine-readable configuration error in JSONL mode", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();
    const error = new RuntimeError(
      "provider_not_configured",
      "No model connection is ready",
    );

    const exitCode = await runCli(
      ["run", "inspect", "--format", "jsonl"],
      {
        stdout,
        stderr,
        async createRuntime() {
          return {
            async submit() {
              throw error;
            },
          } as unknown as RecursRuntime;
        },
      },
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout.value)).toMatchObject({
      version: 1,
      type: "configuration_error",
      error: {
        phase: "preflight",
        code: "connection_invalid",
        safeMessage: "No model connection is ready",
      },
    });
    expect(stderr.value).toBe("");
  });

  it("closes one-shot runtime resources after success and failure", async () => {
    for (const failure of [false, true]) {
      const stdout = new TextOutput();
      const stderr = new TextOutput();
      let closed = 0;
      const runtime = {
        async submit() {
          if (failure) throw new AgentLoopError("provider_failed", "failed");
          return {
            finalText: "done",
            stopReason: "complete",
            usage: null,
            changedFiles: [],
            evidence: [],
          };
        },
        async close() { closed += 1; },
      } as unknown as RecursRuntime;

      expect(await runCli(["run", "inspect"], {
        stdout,
        stderr,
        async createRuntime() { return runtime; },
      })).toBe(failure ? 1 : 0);
      expect(closed).toBe(1);
    }
  });

  it("fails safely when one-shot runtime resources cannot close", async () => {
    for (const failure of [false, true]) {
      const stdout = new TextOutput();
      const stderr = new TextOutput();
      const runtime = {
        async submit() {
          if (failure) {
            throw new RuntimeError(
              "provider_not_configured",
              "No model connection is ready",
            );
          }
          return {
            finalText: "done",
            stopReason: "complete",
            usage: null,
            changedFiles: [],
            evidence: [],
          };
        },
        async close() { throw new Error("private cleanup detail"); },
      } as unknown as RecursRuntime;

      expect(await runCli(["run", "inspect"], {
        stdout,
        stderr,
        async createRuntime() { return runtime; },
      })).toBe(failure ? 2 : 1);
      expect(stderr.value).toContain(
        "Error: Runtime resources could not be closed safely",
      );
      expect(stderr.value).not.toContain("private cleanup detail");
    }
  });
});
