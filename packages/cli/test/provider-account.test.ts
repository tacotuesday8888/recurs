import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type CodexOnboardingRuntime,
  type CodexRuntimeProbeResult,
  type CodexRuntimeVerification,
  codexAccountSubjectFingerprint,
  FileConnectionRegistry,
  type DelegatedConnectionRecord,
} from "@recurs/app";
import {
  CodexAppServerCatalogError,
  type CodexSubscriptionCatalog,
} from "@recurs/runtimes";
import { afterEach, describe, expect, it } from "vitest";

import {
  disconnectAccount,
  listAccountSummaries,
  listProviderCapabilities,
  listProviderSummaries,
  setPrimaryAccount,
  setupCodexSubscription,
  verifyAccount,
  verifyCodexSubscriptionConnection,
} from "../src/index.js";

const directories: string[] = [];

const appServerCatalog: CodexSubscriptionCatalog = {
  accountSubjectFingerprint: `sha256:${"c".repeat(64)}`,
  accountDisplayLabel: "ChatGPT Pro subscription",
  planType: "pro",
  models: [
    {
      id: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: ["low", "medium", "high", "ultra"],
    },
    {
      id: "gpt-5.6-terra",
      displayName: "GPT-5.6 Terra",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high", "ultra"],
    },
    {
      id: "gpt-5.6-luna",
      displayName: "GPT-5.6 Luna",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high", "max"],
    },
  ],
};

function inspection(
  email: string,
): CodexRuntimeVerification {
  return {
    inspection: {
      protocolVersion: 1,
      agentInfo: {
        name: "@agentclientprotocol/codex-acp",
        version: "1.1.7",
      },
      authMethods: [{ id: "chat-gpt", name: "ChatGPT", type: "agent" }],
      sessionCapabilities: { resume: true, close: true },
    },
    status: { type: "chat-gpt", email },
  };
}

class VerificationRuntime implements CodexOnboardingRuntime {
  readonly adapterId = "codex-acp";
  readonly adapterVersion = "1.1.7";
  readonly capabilityProfileRevision =
    "codex-acp-1.1.7-codex-0.145.0-plan-only-v2";
  authenticationCalls = 0;
  inspectionCalls = 0;

  constructor(
    readonly verification: CodexRuntimeVerification,
    readonly probeResult: CodexRuntimeProbeResult = {
      modelId: "gpt-test",
      modeId: "read-only",
      executionMode: "plan",
    },
  ) {}

  async inspect(): Promise<CodexRuntimeVerification> {
    this.inspectionCalls += 1;
    return structuredClone(this.verification);
  }

  async authenticateChatGpt(): Promise<void> {
    this.authenticationCalls += 1;
    throw new Error("verification must not authenticate");
  }

  async probe(): Promise<CodexRuntimeProbeResult> {
    return structuredClone(this.probeResult);
  }
}

function codexRecord(): DelegatedConnectionRecord {
  return {
    kind: "delegated_agent",
    id: "codex-1",
    providerId: "openai-codex-chatgpt",
    adapterId: "codex-acp",
    label: "Codex with ChatGPT",
    accountLabel: "private-owner@example.com",
    organizationLabel: null,
    modelId: "gpt-test",
    runtimeCapabilityProfileRevision:
      "codex-acp-1.1.7-codex-0.145.0-plan-only-v2",
    accountSubjectFingerprint:
      codexAccountSubjectFingerprint("private-owner@example.com"),
    policyRevision: "openai-codex-chatgpt-2026-07-24",
    billingPolicy: {
      revision: "billing:openai-codex-chatgpt:2026-07-11",
      disclosureRevision:
        "billing-disclosure:openai-codex-chatgpt:2026-07-11",
      primarySource: "included_subscription",
      possibleAdditionalSources: ["prepaid_credits"],
      providerFallback: "automatic",
      availableSelections: ["allow_declared_additional"],
    },
    billingSelection: {
      mode: "allow_declared_additional",
      policyRevision: "billing:openai-codex-chatgpt:2026-07-11",
      disclosureRevision:
        "billing-disclosure:openai-codex-chatgpt:2026-07-11",
      allowedSources: ["included_subscription", "prepaid_credits"],
      acknowledgedAt: "2026-07-11T00:00:00.000Z",
    },
    verifiedAt: "2026-07-11T00:00:00.000Z",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}

function codexAppServerRecord(): DelegatedConnectionRecord {
  return {
    ...codexRecord(),
    id: "codex-app-server-1",
    adapterId: "codex-app-server",
    label: "GPT-5.6 Sol · ChatGPT",
    accountLabel: "ChatGPT Pro subscription",
    modelId: "gpt-5.6-sol",
    reasoningEffort: "high",
    runtimeCapabilityProfileRevision:
      "codex-app-server-0.145.0-host-tools-v2",
    accountSubjectFingerprint: appServerCatalog.accountSubjectFingerprint,
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("provider and account projections", () => {
  it("classifies readiness from executable facts rather than manifest presence", () => {
    const matrix = listProviderCapabilities({
      now: new Date("2026-08-07T12:00:00.000Z"),
    });

    expect(matrix.find((entry) => entry.providerId === "openai-api"))
      .toMatchObject({
        category: "activatable",
        missingCapabilities: [],
        implementationCoverage: "complete",
        liveVerification: { status: "not_run" },
      });
    expect(matrix.find((entry) => entry.providerId === "zai-api"))
      .toMatchObject({
        category: "cataloged",
        missingCapabilities: ["model_discovery_readiness_probe"],
        implementationCoverage: "partial",
        liveVerification: { status: "not_run" },
      });
    expect(matrix.find((entry) =>
      entry.providerId === "github-copilot-subscription"
    )).toMatchObject({
      category: "conditional",
      adapterId: "github-copilot-sdk",
      missingCapabilities: [],
      implementationCoverage: "complete",
      liveVerification: { status: "not_run" },
    });
    expect(matrix.find((entry) => entry.providerId === "aws-bedrock"))
      .toMatchObject({
        category: "cataloged",
        implementationCoverage: "none",
        liveVerification: { status: "not_run" },
      });
    const activatable = matrix.find((entry) =>
      entry.providerId === "openai-api"
    );
    expect(activatable).not.toHaveProperty("configured");
    expect(activatable).not.toHaveProperty("authenticated");
    expect(activatable).not.toHaveProperty("verification.scripted");
  });

  it("keeps conditional and approval-blocked policy ahead of implementation evidence", () => {
    const matrix = listProviderCapabilities({
      now: new Date("2026-08-07T12:00:00.000Z"),
      liveVerification: [{
        providerId: "openai-codex-chatgpt",
        status: "passed",
        checkedAt: "2026-08-07T11:30:00.000Z",
      }],
    });

    expect(matrix.find((entry) =>
      entry.providerId === "openai-codex-chatgpt"
    )).toMatchObject({
      category: "conditional",
      missingCapabilities: [],
      implementationCoverage: "complete",
      liveVerification: {
        status: "passed",
        checkedAt: "2026-08-07T11:30:00.000Z",
      },
    });
    expect(matrix.find((entry) =>
      entry.providerId === "anthropic-claude-subscription"
    )).toMatchObject({ category: "blocked" });
    expect(matrix.find((entry) =>
      entry.providerId === "zai-glm-coding-plan"
    )).toMatchObject({ category: "blocked" });
  });

  it("requires current successful evidence before reporting live-tested", () => {
    const now = new Date("2026-08-07T12:00:00.000Z");
    const current = listProviderCapabilities({
      now,
      liveVerification: [{
        providerId: "openai-api",
        status: "passed",
        checkedAt: "2026-08-07T11:30:00.000Z",
      }],
    });
    const stale = listProviderCapabilities({
      now,
      liveVerification: [{
        providerId: "openai-api",
        status: "passed",
        checkedAt: "2026-08-05T11:30:00.000Z",
      }],
    });
    const failed = listProviderCapabilities({
      now,
      liveVerification: [{
        providerId: "openai-api",
        status: "failed",
        checkedAt: "2026-08-07T11:30:00.000Z",
      }],
    });

    expect(current.find((entry) => entry.providerId === "openai-api"))
      .toMatchObject({
        category: "live-tested",
        liveVerification: { status: "passed" },
      });
    expect(stale.find((entry) => entry.providerId === "openai-api"))
      .toMatchObject({
        category: "activatable",
        liveVerification: { status: "stale" },
      });
    expect(failed.find((entry) => entry.providerId === "openai-api"))
      .toMatchObject({
        category: "activatable",
        liveVerification: { status: "failed" },
      });
  });

  it("returns a redacted closed projection for requested unknown providers", () => {
    const matrix = listProviderCapabilities({
      providerIds: ["unknown-provider"],
      now: new Date("2026-08-07T12:00:00.000Z"),
    });

    expect(matrix).toEqual([{
      providerId: "unknown-provider",
      displayName: "unknown-provider",
      category: "unsupported",
      adapterId: null,
      missingCapabilities: [
        "authentication",
        "model_discovery_readiness_probe",
        "streaming",
        "tools",
        "usage",
        "errors",
        "onboarding_backend",
      ],
      implementationCoverage: "none",
      liveVerification: { status: "not_run" },
    }]);
    expect(Object.isFrozen(matrix)).toBe(true);
    expect(Object.isFrozen(matrix[0])).toBe(true);
    expect(JSON.stringify(matrix)).not.toContain("credential");
    expect(() => listProviderCapabilities({
      providerIds: ["unknown-provider"],
      liveVerification: [{
        providerId: "unknown-provider",
        status: "passed",
        checkedAt: "2026-08-07T11:30:00.000Z",
      }],
      now: new Date("2026-08-07T12:00:00.000Z"),
    })).toThrow("Provider live verification evidence is invalid");
  });

  it("sets up Sol, Terra, and Luna from one existing Codex login", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-codex-setup-"));
    directories.push(directory);
    const codexHome = path.join(directory, "codex-home");
    let inspections = 0;
    const configured = await setupCodexSubscription(directory, {
      cwd: directory,
      interactive: true,
      billingSelection: "allow_declared_additional",
      now: "2026-07-24T00:00:00.000Z",
    }, {
      codexHome,
      async inspectCatalog() {
        inspections += 1;
        if (inspections === 1) {
          throw new CodexAppServerCatalogError(
            "authentication_required",
            "login required",
          );
        }
        return appServerCatalog;
      },
      async authenticateChatGpt() {},
    });

    expect(configured).toMatchObject({
      modelId: "gpt-5.6-sol",
      planOnly: false,
      primary: true,
      configuredModels: [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
      ],
    });
    expect(inspections).toBe(2);
    const document = await new FileConnectionRegistry(directory).read();
    expect(document.agentRoutes).toEqual({
      implement: expect.any(String),
      review: expect.any(String),
      repair: expect.any(String),
    });
    expect(document.connections).toHaveLength(3);
  });

  it("lists the truthful runnable/broker catalog without making blocked paths ready", () => {
    const normal = listProviderSummaries(false);
    const all = listProviderSummaries(true);
    expect(normal.length).toBeLessThan(all.length);
    expect(normal.find((entry) => entry.id === "openai-codex-chatgpt"))
      .toMatchObject({
        status: "runnable",
        accessKind: "subscription",
        adapterKind: "agent_runtime",
        protocol: "official_runtime",
        connectionOwner: "vendor_runtime",
        billing: {
          primarySource: "included_subscription",
          possibleAdditionalSources: ["prepaid_credits"],
          providerFallback: "automatic",
        },
      });
    expect(normal.find((entry) => entry.id === "openai-api"))
      .toMatchObject({
        status: "runnable_byok",
        connectionOwner: "process_environment",
      });
    expect(normal.find((entry) => entry.id === "openrouter-api"))
      .toMatchObject({
        status: "runnable_byok",
        connectionOwner: "process_environment",
      });
    expect(normal.find((entry) => entry.id === "xai-api"))
      .toMatchObject({
        status: "runnable_byok",
        protocol: "openai_chat",
        connectionOwner: "process_environment",
      });
    expect(all.some((entry) => entry.status === "blocked")).toBe(true);
  });

  it("returns useful account metadata while omitting account identifiers and endpoints", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-account-list-"));
    directories.push(directory);
    const email = "private-owner@example.com";
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const record: DelegatedConnectionRecord = {
      ...codexRecord(),
      accountLabel: email,
      accountSubjectFingerprint: fingerprint,
    };
    const registry = new FileConnectionRegistry(directory);
    await registry.commit(0, (draft) => {
      draft.connections.push(record);
      draft.primaryConnectionId = record.id;
    });

    const summaries = await listAccountSummaries(directory);
    expect(summaries).toEqual([{
      id: "codex-1",
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
    }]);
    const serialized = JSON.stringify(summaries);
    expect(serialized).not.toContain(email);
    expect(serialized).not.toContain(fingerprint);
    expect(serialized).not.toContain("accountLabel");
    expect(serialized).not.toContain("organizationLabel");
  });

  it("verifies Codex on the exact account/model without authenticating", async () => {
    const record = codexRecord();
    const runtime = new VerificationRuntime(
      inspection("private-owner@example.com"),
    );

    await expect(verifyCodexSubscriptionConnection(
      record,
      "/tmp/workspace",
      new AbortController().signal,
      { runtime },
    )).resolves.toEqual({ status: "verified" });
    expect(runtime.authenticationCalls).toBe(0);

    await expect(verifyCodexSubscriptionConnection(
      record,
      "/tmp/workspace",
      new AbortController().signal,
      { runtime: new VerificationRuntime(inspection("switched@example.com")) },
    )).resolves.toEqual({
      status: "failed",
      reason: "account_mismatch",
    });

    await expect(verifyCodexSubscriptionConnection(
      record,
      "/tmp/workspace",
      new AbortController().signal,
      {
        runtime: new VerificationRuntime(
          inspection("private-owner@example.com"),
          { modelId: "other", modeId: "read-only", executionMode: "plan" },
        ),
      },
    )).resolves.toEqual({
      status: "failed",
      reason: "model_unavailable",
    });

    const incompleteInspection = inspection("private-owner@example.com");
    await expect(verifyCodexSubscriptionConnection(
      record,
      "/tmp/workspace",
      new AbortController().signal,
      {
        runtime: new VerificationRuntime({
          ...incompleteInspection,
          inspection: {
            ...incompleteInspection.inspection,
            sessionCapabilities: { resume: false, close: true },
          },
        }),
      },
    )).resolves.toEqual({
      status: "failed",
      reason: "adapter_unavailable",
    });

    const staleRuntime = new VerificationRuntime(
      inspection("private-owner@example.com"),
    );
    await expect(verifyCodexSubscriptionConnection(
      { ...record, policyRevision: "stale-policy" },
      "/tmp/workspace",
      new AbortController().signal,
      { runtime: staleRuntime },
    )).resolves.toEqual({
      status: "failed",
      reason: "policy_stale",
    });
    expect(staleRuntime.inspectionCalls).toBe(0);

    const oldProfileRuntime = new VerificationRuntime(
      inspection("private-owner@example.com"),
    );
    await expect(verifyCodexSubscriptionConnection(
      {
        ...record,
        runtimeCapabilityProfileRevision:
          "codex-acp-1.1.2-codex-0.144.0-plan-only-v2",
      },
      "/tmp/workspace",
      new AbortController().signal,
      { runtime: oldProfileRuntime },
    )).resolves.toEqual({
      status: "failed",
      reason: "policy_stale",
    });
    expect(oldProfileRuntime.inspectionCalls).toBe(0);
  });

  it("verifies an app-server connection against its exact account, model, and effort", async () => {
    const record = codexAppServerRecord();
    const signal = new AbortController().signal;
    await expect(verifyCodexSubscriptionConnection(
      record,
      "/tmp/workspace",
      signal,
      { async inspectCatalog() { return appServerCatalog; } },
    )).resolves.toEqual({ status: "verified" });
    await expect(verifyCodexSubscriptionConnection(
      { ...record, accountSubjectFingerprint: `sha256:${"d".repeat(64)}` },
      "/tmp/workspace",
      signal,
      { async inspectCatalog() { return appServerCatalog; } },
    )).resolves.toEqual({ status: "failed", reason: "account_mismatch" });
    await expect(verifyCodexSubscriptionConnection(
      { ...record, modelId: "missing-model" },
      "/tmp/workspace",
      signal,
      { async inspectCatalog() { return appServerCatalog; } },
    )).resolves.toEqual({ status: "failed", reason: "model_unavailable" });

    let oldProfileInspections = 0;
    await expect(verifyCodexSubscriptionConnection(
      {
        ...record,
        runtimeCapabilityProfileRevision:
          "codex-app-server-0.144.0-host-tools-v1",
      },
      "/tmp/workspace",
      signal,
      {
        async inspectCatalog() {
          oldProfileInspections += 1;
          return appServerCatalog;
        },
      },
    )).resolves.toEqual({ status: "failed", reason: "policy_stale" });
    expect(oldProfileInspections).toBe(0);
  });

  it("uses the application lifecycle service for primary selection and disconnection", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-account-mutate-"));
    directories.push(directory);
    const registry = new FileConnectionRegistry(directory);
    const delegated = codexRecord();
    await registry.commit(0, (draft) => {
      draft.connections.push({
        kind: "local_openai_compatible",
        id: "local-1",
        providerId: "local-openai-compatible",
        adapterId: "openai-chat-completions",
        label: "Local model",
        baseUrl: "http://127.0.0.1:11434/v1",
        modelId: "qwen",
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      }, delegated);
      draft.primaryConnectionId = "local-1";
    });

    await expect(setPrimaryAccount(directory, delegated.id)).resolves
      .toMatchObject({ id: delegated.id, primary: true });
    await expect(disconnectAccount(directory, delegated.id)).resolves.toEqual({
      connectionId: delegated.id,
      primaryCleared: true,
      remainingConnections: 1,
    });
    expect((await registry.read()).primaryConnectionId).toBeNull();
  });

  it("verifies an exact account through an injected trusted verifier without mutation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-account-verify-"));
    directories.push(directory);
    const registry = new FileConnectionRegistry(directory);
    const delegated = codexRecord();
    await registry.commit(0, (draft) => {
      draft.connections.push(delegated);
      draft.primaryConnectionId = delegated.id;
    });
    const before = await registry.read();

    await expect(verifyAccount(
      directory,
      delegated.id,
      "/tmp/workspace",
      undefined,
      {
        verifier: {
          async verifyLocal() {
            return { status: "failed", reason: "adapter_unavailable" };
          },
          async verifyDelegated(record) {
            expect(record.id).toBe(delegated.id);
            return { status: "verified" };
          },
        },
      },
    )).resolves.toMatchObject({
      verified: true,
      connection: { id: delegated.id },
    });
    expect((await registry.read()).revision).toBe(before.revision);
  });
});
