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
import { afterEach, describe, expect, it } from "vitest";

import {
  disconnectAccount,
  listAccountSummaries,
  listProviderSummaries,
  setPrimaryAccount,
  verifyAccount,
  verifyCodexSubscriptionConnection,
} from "../src/index.js";

const directories: string[] = [];

function inspection(
  email: string,
): CodexRuntimeVerification {
  return {
    inspection: {
      protocolVersion: 1,
      agentInfo: {
        name: "@agentclientprotocol/codex-acp",
        version: "1.1.2",
      },
      authMethods: [{ id: "chat-gpt", name: "ChatGPT", type: "agent" }],
      sessionCapabilities: { resume: true, close: true },
    },
    status: { type: "chat-gpt", email },
  };
}

class VerificationRuntime implements CodexOnboardingRuntime {
  readonly adapterId = "codex-acp";
  readonly adapterVersion = "1.1.2";
  readonly capabilityProfileRevision =
    "codex-acp-1.1.2-codex-0.144.0-plan-only-v2";
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
    accountSubjectFingerprint:
      codexAccountSubjectFingerprint("private-owner@example.com"),
    policyRevision: "openai-codex-chatgpt-2026-07-11",
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

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("provider and account projections", () => {
  it("lists the truthful runnable/broker catalog without making blocked paths ready", () => {
    const normal = listProviderSummaries(false);
    const all = listProviderSummaries(true);
    expect(normal.length).toBeLessThan(all.length);
    expect(normal.find((entry) => entry.id === "openai-codex-chatgpt"))
      .toMatchObject({
        status: "runnable",
        accessKind: "subscription",
        adapterKind: "agent_runtime",
        connectionOwner: "vendor_runtime",
        billing: {
          primarySource: "included_subscription",
          possibleAdditionalSources: ["prepaid_credits"],
          providerFallback: "automatic",
        },
      });
    expect(normal.find((entry) => entry.id === "openai-api"))
      .toMatchObject({
        status: "requires_native_broker",
        connectionOwner: "recurs_broker",
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
