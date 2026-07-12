import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CodexOnboardingError,
  FileConnectionRegistry,
  connectionRegistryPath,
  setupCodexConnection,
  type CodexRuntimeProbeResult,
  type CodexRuntimeVerification,
  type CodexOnboardingRuntime,
} from "@recurs/app";

const directories: string[] = [];
const at = "2026-07-11T01:02:03.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-codex-setup-"));
  directories.push(directory);
  return directory;
}

function inspection(
  status: CodexRuntimeVerification["status"],
  chatGptAdvertised = true,
): CodexRuntimeVerification {
  return {
    inspection: {
      protocolVersion: 1,
      agentInfo: {
        name: "@agentclientprotocol/codex-acp",
        version: "1.1.2",
      },
      authMethods: [
        { id: "api-key", name: "API Key", type: "agent" },
        ...(chatGptAdvertised
          ? [{ id: "chat-gpt", name: "ChatGPT", type: "agent" as const }]
          : []),
      ],
      sessionCapabilities: { resume: true, close: true },
    },
    status,
  };
}

class FakeCodexRuntime implements CodexOnboardingRuntime {
  readonly adapterId = "codex-acp";
  readonly adapterVersion = "1.1.2";
  readonly capabilityProfileRevision =
    "codex-acp-1.1.2-codex-0.144.0-plan-only-v2";
  readonly inspections: CodexRuntimeVerification[];
  readonly probeResult: CodexRuntimeProbeResult;
  inspectCalls = 0;
  authenticationCalls = 0;
  probeCalls = 0;
  probeFailure: Error | null = null;

  constructor(
    inspections: CodexRuntimeVerification[],
    probeResult: CodexRuntimeProbeResult = {
      modelId: "gpt-test",
      modeId: "read-only",
      executionMode: "plan",
    },
  ) {
    this.inspections = inspections;
    this.probeResult = probeResult;
  }

  async inspect(): Promise<CodexRuntimeVerification> {
    const value = this.inspections[Math.min(
      this.inspectCalls,
      this.inspections.length - 1,
    )];
    this.inspectCalls += 1;
    if (value === undefined) throw new Error("missing fake inspection");
    return structuredClone(value);
  }

  async authenticateChatGpt(): Promise<void> {
    this.authenticationCalls += 1;
  }

  async probe(): Promise<CodexRuntimeProbeResult> {
    this.probeCalls += 1;
    if (this.probeFailure !== null) throw this.probeFailure;
    return structuredClone(this.probeResult);
  }
}

describe("Codex subscription onboarding", () => {
  it("reuses verified ChatGPT auth, probes Plan mode, and persists only non-secret metadata", async () => {
    const directory = await root();
    const workspace = path.join(directory, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const runtime = new FakeCodexRuntime([
      inspection({ type: "chat-gpt", email: "owner@example.com" }),
    ]);

    const connection = await setupCodexConnection(directory, {
      cwd: workspace,
      interactive: false,
      billingSelection: "allow_declared_additional",
      now: at,
    }, { runtime });

    expect(runtime.authenticationCalls).toBe(0);
    expect(runtime.probeCalls).toBe(1);
    expect(connection).toMatchObject({
      schemaVersion: 1,
      kind: "delegated_agent",
      providerId: "openai-codex-chatgpt",
      adapterId: "codex-acp",
      accountLabel: "owner@example.com",
      organizationLabel: null,
      modelId: "gpt-test",
      executionMode: "plan",
      planOnly: true,
      primary: true,
      billingSelection: {
        mode: "allow_declared_additional",
        allowedSources: ["included_subscription", "prepaid_credits"],
      },
    });

    const document = await new FileConnectionRegistry(directory).read();
    expect(document.primaryConnectionId).toBe(connection.id);
    expect(document.connections).toHaveLength(1);
    expect(document.connections[0]).toMatchObject({
      accountSubjectFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      organizationLabel: null,
      policyRevision: "openai-codex-chatgpt-2026-07-11",
    });
    const serialized = await readFile(connectionRegistryPath(directory), "utf8");
    for (const forbidden of [
      "authMethod",
      "vendorSession",
      "CODEX_HOME",
      "auth.json",
      "accessToken",
      "planTier",
      "organizationId",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("keeps later accounts secondary and preserves that state on re-verification", async () => {
    const directory = await root();
    const workspace = path.join(directory, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));

    const first = await setupCodexConnection(directory, {
      cwd: workspace,
      interactive: false,
      billingSelection: "allow_declared_additional",
      now: "2026-07-12T00:00:00.000Z",
    }, {
      runtime: new FakeCodexRuntime([
        inspection({ type: "chat-gpt", email: "first@example.com" }),
      ]),
    });
    const second = await setupCodexConnection(directory, {
      cwd: workspace,
      interactive: false,
      billingSelection: "allow_declared_additional",
      now: "2026-07-12T00:01:00.000Z",
    }, {
      runtime: new FakeCodexRuntime([
        inspection({ type: "chat-gpt", email: "second@example.com" }),
      ]),
    });
    const reverified = await setupCodexConnection(directory, {
      cwd: workspace,
      interactive: false,
      billingSelection: "allow_declared_additional",
      now: "2026-07-12T00:02:00.000Z",
    }, {
      runtime: new FakeCodexRuntime([
        inspection({ type: "chat-gpt", email: "second@example.com" }),
      ]),
    });

    expect(first.primary).toBe(true);
    expect(second.primary).toBe(false);
    expect(reverified).toMatchObject({ id: second.id, primary: false });
    const document = await new FileConnectionRegistry(directory).read();
    expect(document.primaryConnectionId).toBe(first.id);
    expect(document.connections).toHaveLength(2);
  });

  it("does not choose a Codex primary when other records exist without one", async () => {
    const directory = await root();
    const workspace = path.join(directory, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    await new FileConnectionRegistry(directory).commit(0, (draft) => {
      draft.connections.push({
        kind: "local_openai_compatible",
        id: "local-existing",
        providerId: "local-openai-compatible",
        adapterId: "openai-chat-completions",
        label: "Local model",
        baseUrl: "http://127.0.0.1:11434/v1",
        modelId: "qwen",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z",
      });
    });

    const connection = await setupCodexConnection(directory, {
      cwd: workspace,
      interactive: false,
      billingSelection: "allow_declared_additional",
      now: "2026-07-12T00:01:00.000Z",
    }, {
      runtime: new FakeCodexRuntime([
        inspection({ type: "chat-gpt", email: "owner@example.com" }),
      ]),
    });

    expect(connection.primary).toBe(false);
    expect((await new FileConnectionRegistry(directory).read()).primaryConnectionId)
      .toBeNull();
  });

  it("uses only dynamically advertised ChatGPT auth and rechecks status", async () => {
    const directory = await root();
    const workspace = path.join(directory, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const runtime = new FakeCodexRuntime([
      inspection({ type: "unauthenticated" }),
      inspection({ type: "chat-gpt", email: "signed-in@example.com" }),
    ]);

    await expect(setupCodexConnection(directory, {
      cwd: workspace,
      interactive: true,
      billingSelection: "allow_declared_additional",
      now: at,
    }, { runtime })).resolves.toMatchObject({
      accountLabel: "signed-in@example.com",
    });
    expect(runtime.authenticationCalls).toBe(1);
    expect(runtime.inspectCalls).toBe(2);
    expect(runtime.probeCalls).toBe(1);
  });

  it("never opens login without interaction or without an advertised chat-gpt method", async () => {
    const directory = await root();
    const workspace = path.join(directory, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const noninteractive = new FakeCodexRuntime([
      inspection({ type: "unauthenticated" }),
    ]);
    await expect(setupCodexConnection(directory, {
      cwd: workspace,
      interactive: false,
      billingSelection: "allow_declared_additional",
      now: at,
    }, { runtime: noninteractive })).rejects.toMatchObject({
      code: "interaction_required",
    });
    expect(noninteractive.authenticationCalls).toBe(0);

    const noBrowser = new FakeCodexRuntime([
      inspection({ type: "unauthenticated" }, false),
    ]);
    await expect(setupCodexConnection(directory, {
      cwd: workspace,
      interactive: true,
      billingSelection: "allow_declared_additional",
      now: at,
    }, { runtime: noBrowser })).rejects.toMatchObject({
      code: "chatgpt_login_unavailable",
    });
    expect(noBrowser.authenticationCalls).toBe(0);
    await expect(new FileConnectionRegistry(directory).read()).resolves
      .toMatchObject({ connections: [] });
  });

  it.each([
    { type: "api-key" as const },
    { type: "gateway" as const, name: "custom" },
  ])("does not misclassify $type auth as a ChatGPT subscription", async (status) => {
    const directory = await root();
    const workspace = path.join(directory, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const runtime = new FakeCodexRuntime([inspection(status)]);
    await expect(setupCodexConnection(directory, {
      cwd: workspace,
      interactive: true,
      billingSelection: "allow_declared_additional",
      now: at,
    }, { runtime })).rejects.toMatchObject({ code: "wrong_account_kind" });
    expect(runtime.authenticationCalls).toBe(0);
    expect(runtime.probeCalls).toBe(0);
  });

  it("requires the truthful automatic prepaid-credit billing acknowledgement", async () => {
    const directory = await root();
    const workspace = path.join(directory, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const runtime = new FakeCodexRuntime([
      inspection({ type: "chat-gpt", email: "owner@example.com" }),
    ]);
    await expect(setupCodexConnection(directory, {
      cwd: workspace,
      interactive: true,
      billingSelection: "strict_primary_only" as "allow_declared_additional",
      now: at,
    }, { runtime })).rejects.toMatchObject({
      code: "billing_acknowledgement_required",
    });
    expect(runtime.inspectCalls).toBe(0);
    expect(runtime.probeCalls).toBe(0);
  });

  it("commits nothing when status identity or the capability probe is unusable", async () => {
    const directory = await root();
    const workspace = path.join(directory, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const missingIdentity = new FakeCodexRuntime([
      inspection({ type: "chat-gpt", email: "" }),
    ]);
    await expect(setupCodexConnection(directory, {
      cwd: workspace,
      interactive: false,
      billingSelection: "allow_declared_additional",
      now: at,
    }, { runtime: missingIdentity })).rejects.toMatchObject({
      code: "account_identity_unavailable",
    });

    const failedProbe = new FakeCodexRuntime([
      inspection({ type: "chat-gpt", email: "owner@example.com" }),
    ]);
    failedProbe.probeFailure = new Error("vendor session canary");
    await expect(setupCodexConnection(directory, {
      cwd: workspace,
      interactive: false,
      billingSelection: "allow_declared_additional",
      now: at,
    }, { runtime: failedProbe })).rejects.toBeInstanceOf(CodexOnboardingError);
    await expect(new FileConnectionRegistry(directory).read()).resolves
      .toMatchObject({ connections: [] });
  });

  it("rejects runtime identity drift and redacts runtime construction failures", async () => {
    const directory = await root();
    const workspace = path.join(directory, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const drifted = new FakeCodexRuntime([
      inspection({ type: "chat-gpt", email: "owner@example.com" }),
    ]);
    Object.defineProperty(drifted, "capabilityProfileRevision", {
      value: "unreviewed-profile",
    });
    await expect(setupCodexConnection(directory, {
      cwd: workspace,
      interactive: false,
      billingSelection: "allow_declared_additional",
      now: at,
    }, { runtime: drifted })).rejects.toMatchObject({
      code: "adapter_unavailable",
    });

    const canary = "VENDOR_RUNTIME_SECRET_CANARY";
    let caught: unknown;
    try {
      await setupCodexConnection(directory, {
        cwd: workspace,
        interactive: false,
        billingSelection: "allow_declared_additional",
        now: at,
      }, {
        createRuntime() {
          throw new Error(canary);
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CodexOnboardingError);
    expect((caught as Error).message).not.toContain(canary);
  });
});
