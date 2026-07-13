import { PassThrough, Readable, Writable } from "node:stream";

import {
  NATIVE_COMPONENT_VERSION,
  type BackendResolver,
  type HostInvocation,
  type NativeAuthorityStatusPort,
} from "@recurs/contracts";
import {
  ConnectionLifecycleError,
  NativeAuthorityService,
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  RecursRuntime,
  LocalConnectionError,
  RuntimeError,
  createCommandRegistry,
  createOneShotNativeAuthorityStatusPort,
  createStandaloneRuntime,
  isAutomationEnvironment,
  runCli,
  type CliDependencies,
} from "../src/index.js";
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

  it("rejects malformed provider/account list flags without calling services", async () => {
    for (const argv of [
      ["provider", "list", "--bad"],
      ["provider", "show"],
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
        };
      },
    });

    expect(code).toBe(0);
    expect(selected).toBe("codex-1");
    expect(stdout.value).toContain("Primary connection — codex-1");
    expect(stdout.value).toContain("Existing sessions keep their pinned backend");
    expect(stderr.value).toBe("");
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

  it("closes the one-shot native authority after a successful status", async () => {
    const socket = new PassThrough();
    const service = new NativeAuthorityService(
      {
        async status() {
          return { state: "unavailable", reason: "keychain_unavailable" };
        },
      },
      () => socket.destroy(),
    );
    const port = createOneShotNativeAuthorityStatusPort(
      async () => service,
    );
    await expect(port.status()).resolves.toEqual({
      state: "unavailable",
      reason: "keychain_unavailable",
    });
    expect(socket.destroyed).toBe(true);
  });

  it("closes the one-shot native authority when health is cancelled", async () => {
    const controller = new AbortController();
    const socket = new PassThrough();
    const removeListener = vi.spyOn(
      controller.signal,
      "removeEventListener",
    );
    let abortListener: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const service = new NativeAuthorityService(
      {
        status(signal) {
          return new Promise((_resolve, reject) => {
            abortListener = () => {
              reject(new DOMException(
                "SECRET_HEALTH_ABORT_CANARY",
                "AbortError",
              ));
            };
            signal?.addEventListener("abort", abortListener);
            markStarted?.();
          });
        },
      },
      () => {
        if (abortListener !== undefined) {
          controller.signal.removeEventListener("abort", abortListener);
        }
        socket.destroy();
      },
    );
    const port = createOneShotNativeAuthorityStatusPort(
      async () => service,
    );

    const pending = port.status(controller.signal);
    await started;
    controller.abort("SECRET_CONTROLLER_ABORT_CANARY");
    const error = await pending.catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "AbortError",
      message: "The operation was aborted.",
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_");
    expect(socket.destroyed).toBe(true);
    expect(removeListener).toHaveBeenCalledWith("abort", abortListener);
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
});
