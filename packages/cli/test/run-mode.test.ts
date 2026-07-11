import { Readable, Writable } from "node:stream";

import type { BackendResolver } from "@recurs/contracts";
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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  RecursRuntime,
  LocalConnectionError,
  RuntimeError,
  createCommandRegistry,
  createStandaloneRuntime,
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
        return { label: "Local model", ...input };
      },
    });

    expect(exitCode).toBe(0);
    expect(received).toEqual({
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen-coder",
    });
    expect(stdout.value).toContain("Ready — Local model · qwen-coder");
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
          label: "Codex with ChatGPT",
          modelId: "gpt-test",
          planOnly: true,
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
    expect(stdout.value).not.toContain("owner@example.com");
    expect(stderr.value).toBe("");
  });

  it("never launches Codex login from noninteractive or declined setup", async () => {
    for (const [interactive, accepted] of [
      [false, true],
      [true, false],
    ] as const) {
      const stdout = new TextOutput();
      const stderr = new TextOutput();
      let setupCalls = 0;
      const exitCode = await runCli(["setup", "codex"], {
        stdout,
        stderr,
        cwd: "/tmp/workspace",
        interactive,
        async confirm() { return accepted; },
        async createRuntime() { throw new Error("runtime must not start"); },
        async setupCodex() {
          setupCalls += 1;
          return {
            label: "Codex with ChatGPT",
            modelId: "gpt-test",
            planOnly: true,
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

  it("opens the interactive CLI and routes local quit without a prompt run", async () => {
    const stdout = new TextOutput();
    const stderr = new TextOutput();

    const exitCode = await runCli([], {
      stdin: Readable.from(["/quit\n"]),
      stdout,
      stderr,
      createRuntime,
    });

    expect(exitCode).toBe(0);
    expect(stdout.value).toContain("Recurs — local harness mode");
    expect(stderr.value).toBe("");
  });

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
