import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  nativeOpenAIOnboardingFailure,
  nativeOpenAIOnboardingSucceeded,
  type NativeOpenAIOnboardingCatalogPage,
  type NativeOpenAIOnboardingOutcome,
  type NativeOpenAIOnboardingPort,
} from "@recurs/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  FileConnectionActivationStore,
  FileConnectionRegistry,
  OnboardingCatalog,
  connectionRegistryPath,
  openAIOnboardingDisclosure,
  recoverPendingOpenAIConnection,
  setupOpenAIConnection,
  type OpenAIOnboardingAcknowledgement,
  type PendingConnectionActivation,
} from "../src/index.js";

const AT = "2026-07-14T00:00:00.000Z";
const CONNECTION_ID = "71000000-0000-4000-8000-000000000001";
const FINGERPRINT = `sha256:${"b".repeat(64)}`;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-openai-setup-"));
  directories.push(directory);
  return directory;
}

function page(
  overrides: Partial<NativeOpenAIOnboardingCatalogPage> = {},
): NativeOpenAIOnboardingCatalogPage {
  return {
    cursor: 0,
    totalModelCount: 3,
    nextCursor: 2,
    modelIds: ["gpt-5.6-luna"],
    ...overrides,
  };
}

function acknowledgement(): OpenAIOnboardingAcknowledgement {
  return {
    policyRevision: "openai-api-2026-07-11",
    billingPolicyRevision: "billing:openai-api:2026-07-11",
    billingDisclosureRevision:
      "billing-disclosure:openai-api:2026-07-11",
    mode: "strict_primary_only",
  };
}

class ScriptedNativeOpenAIOnboarding implements NativeOpenAIOnboardingPort {
  readonly calls: string[] = [];
  beginError: unknown;
  verifyError: unknown;
  finalizeError: unknown;
  abortError: unknown;
  reconcileError: unknown;
  beforeBegin: (() => void) | undefined;
  beforeVerify: (() => void) | undefined;
  beforeFinalize: (() => void | Promise<void>) | undefined;
  beginResult: NativeOpenAIOnboardingOutcome<{
    connectionId: string;
    credentialIdentityFingerprint: string;
  }> = nativeOpenAIOnboardingSucceeded({
    connectionId: CONNECTION_ID,
    credentialIdentityFingerprint: FINGERPRINT,
  });
  verifyResult: NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingCatalogPage> =
    nativeOpenAIOnboardingSucceeded(page());
  readonly catalogResults = new Map<
    number,
    NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingCatalogPage>
  >([
    [
      2,
      nativeOpenAIOnboardingSucceeded(
        page({
          cursor: 2,
          nextCursor: null,
          modelIds: ["gpt-5.6-sol", "gpt-5.6-terra"],
        }),
      ),
    ],
  ]);
  finalizeResult = nativeOpenAIOnboardingSucceeded({
    connectionId: CONNECTION_ID,
    selectedModelId: "gpt-5.6-sol",
    verifiedModelCount: 3,
  });
  abortResult = nativeOpenAIOnboardingSucceeded({ aborted: true as const });
  reconcileResult = nativeOpenAIOnboardingSucceeded({
    status: "ready_openai" as const,
  });

  async beginOpenAIOnboarding(
    _signal?: AbortSignal,
    provider: "openai" | "anthropic" = "openai",
  ): Promise<typeof this.beginResult> {
    this.calls.push(provider === "openai" ? "begin" : "begin:anthropic");
    this.beforeBegin?.();
    if (this.beginError !== undefined) throw this.beginError;
    return this.beginResult;
  }

  async verifyOpenAIOnboarding(): Promise<typeof this.verifyResult> {
    this.calls.push("verify");
    this.beforeVerify?.();
    if (this.verifyError !== undefined) throw this.verifyError;
    return this.verifyResult;
  }

  async openAIOnboardingCatalogPage(
    cursor: number,
  ): Promise<NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingCatalogPage>> {
    this.calls.push(`catalog:${cursor}`);
    return this.catalogResults.get(cursor) ??
      nativeOpenAIOnboardingFailure("invalid_request");
  }

  async finalizeOpenAIOnboarding(
    exactModelId: string,
  ): Promise<typeof this.finalizeResult> {
    this.calls.push(`finalize:${exactModelId}`);
    await this.beforeFinalize?.();
    if (this.finalizeError !== undefined) throw this.finalizeError;
    return this.finalizeResult;
  }

  async abortOpenAIOnboarding(): Promise<typeof this.abortResult> {
    this.calls.push("abort");
    if (this.abortError !== undefined) throw this.abortError;
    return this.abortResult;
  }

  async reconcileOpenAIActivation(
    connectionId: string,
    credentialIdentityFingerprint: string,
  ): Promise<typeof this.reconcileResult> {
    this.calls.push(`reconcile:${connectionId}:${credentialIdentityFingerprint}`);
    if (this.reconcileError !== undefined) throw this.reconcileError;
    return this.reconcileResult;
  }
}

function pendingActivation(
  overrides: Partial<PendingConnectionActivation> = {},
): PendingConnectionActivation {
  return {
    connection: {
      kind: "brokered_model_provider",
      id: CONNECTION_ID,
      providerId: "openai-api",
      adapterId: "openai-responses",
      activationProfileId: "openai_api_v1",
      label: "OpenAI API",
      modelId: "gpt-5.6-sol",
      credentialIdentityFingerprint: FINGERPRINT,
      policyRevision: acknowledgement().policyRevision,
      billingPolicy: {
        revision: acknowledgement().billingPolicyRevision,
        disclosureRevision: acknowledgement().billingDisclosureRevision,
        primarySource: "metered_api",
        possibleAdditionalSources: [],
        providerFallback: "none",
        availableSelections: ["strict_primary_only"],
      },
      billingSelection: {
        mode: "strict_primary_only",
        policyRevision: acknowledgement().billingPolicyRevision,
        disclosureRevision: acknowledgement().billingDisclosureRevision,
        allowedSources: ["metered_api"],
        acknowledgedAt: AT,
      },
      verifiedAt: AT,
      createdAt: AT,
      updatedAt: AT,
    },
    stagedAt: AT,
    ...overrides,
  };
}

describe("OpenAI connection onboarding", () => {
  it("commits Anthropic through the same broker-owned lifecycle", async () => {
    const directory = await root();
    const native = new ScriptedNativeOpenAIOnboarding();
    native.verifyResult = nativeOpenAIOnboardingSucceeded(
      page({
        totalModelCount: 1,
        nextCursor: null,
        modelIds: ["claude-opus-4-6"],
      }),
    );
    native.finalizeResult = nativeOpenAIOnboardingSucceeded({
      connectionId: CONNECTION_ID,
      selectedModelId: "claude-opus-4-6",
      verifiedModelCount: 1,
    });
    const entry = new OnboardingCatalog().list({
      includeBlocked: true,
      now: new Date(AT),
    }).find(({ id }) => id === "anthropic-api");
    expect(entry).toBeDefined();

    const result = await setupOpenAIConnection(
      directory,
      {
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        acknowledgement: {
          policyRevision: entry?.policy.revision ?? "",
          billingPolicyRevision: entry?.billing.revision ?? "",
          billingDisclosureRevision: entry?.billing.disclosureRevision ?? "",
          mode: "strict_primary_only",
        },
      },
      { nativeAuthority: native, now: () => new Date(AT) },
    );

    expect(native.calls).toEqual([
      "begin:anthropic",
      "verify",
      "finalize:claude-opus-4-6",
    ]);
    expect(result).toMatchObject({
      state: "ready",
      connection: {
        providerId: "anthropic-api",
        adapterId: "anthropic-messages",
        label: "Anthropic API",
        modelId: "claude-opus-4-6",
      },
    });
    expect(await new FileConnectionRegistry(directory).read()).toMatchObject({
      connections: [{
        providerId: "anthropic-api",
        adapterId: "anthropic-messages",
        activationProfileId: "anthropic_api_v1",
      }],
    });
  });

  it("commits a verified exact model and returns only a runtime-gated summary", async () => {
    const directory = await root();
    const native = new ScriptedNativeOpenAIOnboarding();

    const disclosure = openAIOnboardingDisclosure({
      now: () => new Date(AT),
    });
    expect(disclosure).toMatchObject({
      providerId: "openai-api",
      credentialOwner: "recurs_broker",
      endpoint: "https://api.openai.com/v1",
      policyRevision: acknowledgement().policyRevision,
      billingPolicyRevision: acknowledgement().billingPolicyRevision,
      billingDisclosureRevision:
        acknowledgement().billingDisclosureRevision,
      billingNotice:
        "OpenAI API billing is separate from ChatGPT subscriptions.",
      systemProxyTrust: "trusted_in_v1",
      supportedRunContexts: ["local_cli_user_present"],
    });
    expect(Object.isFrozen(disclosure)).toBe(true);
    expect(Object.isFrozen(disclosure.restrictions)).toBe(true);

    const result = await setupOpenAIConnection(
      directory,
      {
        modelId: "gpt-5.6-sol",
        acknowledgement: acknowledgement(),
      },
      {
        nativeAuthority: native,
        now: () => new Date(AT),
      },
    );

    expect(native.calls).toEqual([
      "begin",
      "verify",
      "catalog:2",
      "finalize:gpt-5.6-sol",
    ]);
    expect(result).toEqual({
      state: "ready",
      disposition: "created",
      connection: {
        id: CONNECTION_ID,
        label: "OpenAI API",
        providerId: "openai-api",
        adapterId: "openai-responses",
        kind: "brokered_model_provider",
        modelId: "gpt-5.6-sol",
        primary: true,
        account: "verified (identifier redacted)",
        activation: "stored_pending_runtime_gate",
        billingSources: ["metered_api"],
      },
      cleanupPending: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(FINGERPRINT);
    expect(await new FileConnectionActivationStore(directory).read()).toEqual({
      schemaVersion: 1,
      activation: null,
    });
    expect(await new FileConnectionRegistry(directory).read()).toMatchObject({
      revision: 1,
      primaryConnectionId: CONNECTION_ID,
      connections: [
        {
          kind: "brokered_model_provider",
          id: CONNECTION_ID,
          providerId: "openai-api",
          adapterId: "openai-responses",
          activationProfileId: "openai_api_v1",
          label: "OpenAI API",
          modelId: "gpt-5.6-sol",
          credentialIdentityFingerprint: FINGERPRINT,
          policyRevision: acknowledgement().policyRevision,
          verifiedAt: AT,
          createdAt: AT,
          updatedAt: AT,
        },
      ],
    });
    expect(await readFile(connectionRegistryPath(directory), "utf8"))
      .not.toContain("sk-");
  });

  it("reports no recovery work when the activation sidecar is absent", async () => {
    const result = await recoverPendingOpenAIConnection(await root(), {
      nativeAuthority: new ScriptedNativeOpenAIOnboarding(),
    });
    expect(result).toEqual({ state: "none" });
  });

  it("cancels recovery before contacting the native authority", async () => {
    const directory = await root();
    await new FileConnectionActivationStore(directory).prepare(
      pendingActivation(),
    );
    const native = new ScriptedNativeOpenAIOnboarding();
    const controller = new AbortController();
    controller.abort();

    const result = await recoverPendingOpenAIConnection(
      directory,
      { nativeAuthority: native },
      { signal: controller.signal },
    );

    expect(result).toEqual({ state: "cancelled", cleanup: "confirmed" });
    expect(native.calls).toEqual([]);
    expect((await new FileConnectionActivationStore(directory).read()).activation)
      .toEqual(pendingActivation());
  });

  it("rejects stale acknowledgement and unreviewed aliases before secret capture", async () => {
    const directory = await root();
    const staleNative = new ScriptedNativeOpenAIOnboarding();
    const stale = await setupOpenAIConnection(
      directory,
      {
        modelId: "gpt-5.6-sol",
        acknowledgement: {
          ...acknowledgement(),
          billingDisclosureRevision: "stale-disclosure",
        },
      },
      { nativeAuthority: staleNative, now: () => new Date(AT) },
    );
    expect(stale).toMatchObject({
      state: "failed",
      phase: "preflight",
      code: "acknowledgement_required",
      recovery: "none",
    });
    expect(staleNative.calls).toEqual([]);

    const aliasNative = new ScriptedNativeOpenAIOnboarding();
    const alias = await setupOpenAIConnection(
      directory,
      { modelId: "gpt-5.6", acknowledgement: acknowledgement() },
      { nativeAuthority: aliasNative, now: () => new Date(AT) },
    );
    expect(alias).toMatchObject({
      state: "failed",
      phase: "preflight",
      code: "model_not_compatible",
    });
    expect(aliasNative.calls).toEqual([]);
  });

  it("blocks expired policy and pending recovery before secret capture", async () => {
    const expiredNative = new ScriptedNativeOpenAIOnboarding();
    const expired = await setupOpenAIConnection(
      await root(),
      { modelId: "gpt-5.6-sol", acknowledgement: acknowledgement() },
      {
        nativeAuthority: expiredNative,
        now: () => new Date("2026-10-12T00:00:00.000Z"),
      },
    );
    expect(expired).toMatchObject({
      state: "failed",
      phase: "preflight",
      code: "policy_unavailable",
    });
    expect(expiredNative.calls).toEqual([]);

    const directory = await root();
    await new FileConnectionActivationStore(directory).prepare(
      pendingActivation(),
    );
    const pendingNative = new ScriptedNativeOpenAIOnboarding();
    const pending = await setupOpenAIConnection(
      directory,
      { modelId: "gpt-5.6-sol", acknowledgement: acknowledgement() },
      { nativeAuthority: pendingNative, now: () => new Date(AT) },
    );
    expect(pending).toMatchObject({
      state: "failed",
      phase: "preflight",
      code: "activation_conflict",
      recovery: "pending_reconciliation",
      connectionId: CONNECTION_ID,
    });
    expect(pendingNative.calls).toEqual([]);
  });

  it("fails closed when the trusted policy clock is invalid", async () => {
    const native = new ScriptedNativeOpenAIOnboarding();
    const result = await setupOpenAIConnection(
      await root(),
      { modelId: "gpt-5.6-sol", acknowledgement: acknowledgement() },
      { nativeAuthority: native, now: () => new Date(Number.NaN) },
    );

    expect(result).toMatchObject({
      state: "failed",
      phase: "preflight",
      code: "policy_unavailable",
      recovery: "none",
    });
    expect(native.calls).toEqual([]);
  });

  it("normalizes native and thrown failures without exposing supplied messages", async () => {
    const hostile = `sk-proj-${"A".repeat(48)}`;
    const failedNative = new ScriptedNativeOpenAIOnboarding();
    failedNative.beginResult = {
      state: "failed",
      code: "invalid_request",
      safeMessage: hostile,
    } as typeof failedNative.beginResult;
    const failed = await setupOpenAIConnection(
      await root(),
      { modelId: "gpt-5.6-sol", acknowledgement: acknowledgement() },
      { nativeAuthority: failedNative, now: () => new Date(AT) },
    );
    expect(failed).toEqual({
      state: "failed",
      phase: "begin",
      code: "invalid_request",
      safeMessage: "The native OpenAI onboarding request is invalid.",
      recovery: "retry",
    });
    expect(JSON.stringify(failed)).not.toContain(hostile);

    const thrownNative = new ScriptedNativeOpenAIOnboarding();
    thrownNative.beginError = new Error(hostile);
    const thrown = await setupOpenAIConnection(
      await root(),
      { modelId: "gpt-5.6-sol", acknowledgement: acknowledgement() },
      { nativeAuthority: thrownNative, now: () => new Date(AT) },
    );
    expect(thrown).toMatchObject({
      state: "failed",
      phase: "begin",
      code: "authority_unavailable",
    });
    expect(JSON.stringify(thrown)).not.toContain(hostile);
  });

  it("aborts when a reviewed model is not credential-visible", async () => {
    const native = new ScriptedNativeOpenAIOnboarding();
    native.verifyResult = nativeOpenAIOnboardingSucceeded(
      page({ modelIds: ["gpt-5.6-sol"] }),
    );
    native.catalogResults.set(
      2,
      nativeOpenAIOnboardingSucceeded(
        page({
          cursor: 2,
          nextCursor: null,
          modelIds: ["gpt-5.6-terra"],
        }),
      ),
    );

    const result = await setupOpenAIConnection(
      await root(),
      { modelId: "gpt-5.6-luna", acknowledgement: acknowledgement() },
      { nativeAuthority: native, now: () => new Date(AT) },
    );

    expect(result).toMatchObject({
      state: "failed",
      phase: "catalog",
      code: "model_not_compatible",
      recovery: "none",
    });
    expect(native.calls).toEqual(["begin", "verify", "catalog:2", "abort"]);
  });

  it("confirms cancellation by aborting with a fresh cleanup signal", async () => {
    const controller = new AbortController();
    const native = new ScriptedNativeOpenAIOnboarding();
    const abortSignals: Array<AbortSignal | undefined> = [];
    native.beforeVerify = () => controller.abort();
    const originalAbort = native.abortOpenAIOnboarding.bind(native);
    native.abortOpenAIOnboarding = async (signal?: AbortSignal) => {
      abortSignals.push(signal);
      return originalAbort();
    };

    const result = await setupOpenAIConnection(
      await root(),
      {
        modelId: "gpt-5.6-sol",
        acknowledgement: acknowledgement(),
        signal: controller.signal,
      },
      { nativeAuthority: native, now: () => new Date(AT) },
    );

    expect(result).toEqual({ state: "cancelled", cleanup: "confirmed" });
    expect(native.calls).toEqual(["begin", "verify", "abort"]);
    expect(abortSignals).toEqual([undefined]);
  });

  it("does not claim clean cancellation when native abort cannot confirm cleanup", async () => {
    const controller = new AbortController();
    const native = new ScriptedNativeOpenAIOnboarding();
    native.beforeVerify = () => controller.abort();
    native.abortResult = nativeOpenAIOnboardingFailure("cleanup_failed");

    const result = await setupOpenAIConnection(
      await root(),
      {
        modelId: "gpt-5.6-sol",
        acknowledgement: acknowledgement(),
        signal: controller.signal,
      },
      { nativeAuthority: native, now: () => new Date(AT) },
    );

    expect(result).toMatchObject({
      state: "failed",
      phase: "cleanup",
      code: "cleanup_failed",
      recovery: "pending_reconciliation",
    });
  });

  it("finishes durable convergence when cancellation races native commit", async () => {
    const controller = new AbortController();
    const native = new ScriptedNativeOpenAIOnboarding();
    native.beforeFinalize = () => controller.abort();

    const result = await setupOpenAIConnection(
      await root(),
      {
        modelId: "gpt-5.6-sol",
        acknowledgement: acknowledgement(),
        signal: controller.signal,
      },
      { nativeAuthority: native, now: () => new Date(AT) },
    );

    expect(result).toMatchObject({ state: "ready", cleanupPending: false });
    expect(native.calls).not.toContain("abort");
  });

  it("reconciles an uncertain prepare rename before native commit", async () => {
    const directory = await root();
    let injected = false;
    const store = new FileConnectionActivationStore(directory, {
      faultInjector(point) {
        if (point === "after_rename" && !injected) {
          injected = true;
          throw new Error("uncertain prepare");
        }
      },
    });
    const native = new ScriptedNativeOpenAIOnboarding();

    const result = await setupOpenAIConnection(
      directory,
      { modelId: "gpt-5.6-sol", acknowledgement: acknowledgement() },
      {
        nativeAuthority: native,
        activationStore: store,
        now: () => new Date(AT),
      },
    );

    expect(result).toMatchObject({ state: "ready", cleanupPending: false });
    expect(native.calls).not.toContain("abort");
  });

  it("aborts after a proven pre-rename persistence failure", async () => {
    const directory = await root();
    const store = new FileConnectionActivationStore(directory, {
      faultInjector(point) {
        if (point === "before_rename") throw new Error("prepare failed");
      },
    });
    const native = new ScriptedNativeOpenAIOnboarding();

    const result = await setupOpenAIConnection(
      directory,
      { modelId: "gpt-5.6-sol", acknowledgement: acknowledgement() },
      {
        nativeAuthority: native,
        activationStore: store,
        now: () => new Date(AT),
      },
    );

    expect(result).toMatchObject({
      state: "failed",
      phase: "prepare",
      code: "persistence_failed",
      recovery: "retry",
    });
    expect(native.calls.at(-1)).toBe("abort");
    expect((await new FileConnectionActivationStore(directory).read()).activation)
      .toBeNull();
  });

  it("retains the exact sidecar when registry commit fails after native success", async () => {
    const directory = await root();
    let renames = 0;
    const store = new FileConnectionActivationStore(directory, {
      faultInjector(point) {
        if (point === "before_rename" && ++renames === 2) {
          throw new Error("registry unavailable");
        }
      },
    });
    const result = await setupOpenAIConnection(
      directory,
      { modelId: "gpt-5.6-sol", acknowledgement: acknowledgement() },
      {
        nativeAuthority: new ScriptedNativeOpenAIOnboarding(),
        activationStore: store,
        now: () => new Date(AT),
      },
    );

    expect(result).toMatchObject({
      state: "failed",
      phase: "registry_commit",
      recovery: "pending_reconciliation",
    });
    expect((await new FileConnectionActivationStore(directory).read()).activation)
      .toEqual(pendingActivation());
  });

  it("distinguishes a completed discard from cleanup still pending", async () => {
    const directory = await root();
    let injected = false;
    const store = new FileConnectionActivationStore(directory, {
      faultInjector(point) {
        if (point === "after_remove" && !injected) {
          injected = true;
          throw new Error("uncertain discard");
        }
      },
    });
    const result = await setupOpenAIConnection(
      directory,
      { modelId: "gpt-5.6-sol", acknowledgement: acknowledgement() },
      {
        nativeAuthority: new ScriptedNativeOpenAIOnboarding(),
        activationStore: store,
        now: () => new Date(AT),
      },
    );

    expect(result).toMatchObject({ state: "ready", cleanupPending: false });
    expect((await new FileConnectionActivationStore(directory).read()).activation)
      .toBeNull();
  });

  it("reports cleanup pending when discard fails before removal", async () => {
    const directory = await root();
    let injected = false;
    const store = new FileConnectionActivationStore(directory, {
      faultInjector(point) {
        if (point === "before_remove" && !injected) {
          injected = true;
          throw new Error("discard not started");
        }
      },
    });
    const result = await setupOpenAIConnection(
      directory,
      { modelId: "gpt-5.6-sol", acknowledgement: acknowledgement() },
      {
        nativeAuthority: new ScriptedNativeOpenAIOnboarding(),
        activationStore: store,
        now: () => new Date(AT),
      },
    );

    expect(result).toMatchObject({ state: "ready", cleanupPending: true });
    expect((await new FileConnectionActivationStore(directory).read()).activation)
      .toEqual(pendingActivation());
  });

  it("retains recovery evidence for an ambiguous native finalize", async () => {
    const directory = await root();
    const hostile = `sk-proj-${"Q".repeat(48)}`;
    const native = new ScriptedNativeOpenAIOnboarding();
    native.finalizeError = new Error(hostile);

    const result = await setupOpenAIConnection(
      directory,
      { modelId: "gpt-5.6-sol", acknowledgement: acknowledgement() },
      { nativeAuthority: native, now: () => new Date(AT) },
    );

    expect(result).toMatchObject({
      state: "failed",
      phase: "native_commit",
      code: "authority_unavailable",
      recovery: "pending_reconciliation",
    });
    expect(JSON.stringify(result)).not.toContain(hostile);
    expect((await new FileConnectionActivationStore(directory).read()).activation)
      .toEqual(pendingActivation());
  });

  it("rejects a mismatched native commit receipt and retains the sidecar", async () => {
    const directory = await root();
    const native = new ScriptedNativeOpenAIOnboarding();
    native.finalizeResult = nativeOpenAIOnboardingSucceeded({
      connectionId: "71000000-0000-4000-8000-000000000099",
      selectedModelId: "gpt-5.6-sol",
      verifiedModelCount: 3,
    });

    const result = await setupOpenAIConnection(
      directory,
      { modelId: "gpt-5.6-sol", acknowledgement: acknowledgement() },
      { nativeAuthority: native, now: () => new Date(AT) },
    );

    expect(result).toMatchObject({
      state: "failed",
      phase: "native_commit",
      code: "reconciliation_required",
    });
    expect((await new FileConnectionActivationStore(directory).read()).activation)
      .not.toBeNull();
  });

  it("rejects a native commit receipt with the wrong verified model count", async () => {
    const directory = await root();
    const native = new ScriptedNativeOpenAIOnboarding();
    native.finalizeResult = nativeOpenAIOnboardingSucceeded({
      connectionId: CONNECTION_ID,
      selectedModelId: "gpt-5.6-sol",
      verifiedModelCount: 2,
    });

    const result = await setupOpenAIConnection(
      directory,
      { modelId: "gpt-5.6-sol", acknowledgement: acknowledgement() },
      { nativeAuthority: native, now: () => new Date(AT) },
    );

    expect(result).toMatchObject({
      state: "failed",
      phase: "native_commit",
      code: "reconciliation_required",
    });
    expect((await new FileConnectionActivationStore(directory).read()).activation)
      .not.toBeNull();
  });

  it("keeps later OpenAI connections secondary", async () => {
    const directory = await root();
    await setupOpenAIConnection(
      directory,
      { modelId: "gpt-5.6-sol", acknowledgement: acknowledgement() },
      {
        nativeAuthority: new ScriptedNativeOpenAIOnboarding(),
        now: () => new Date(AT),
      },
    );
    const secondId = "71000000-0000-4000-8000-000000000002";
    const second = new ScriptedNativeOpenAIOnboarding();
    second.beginResult = nativeOpenAIOnboardingSucceeded({
      connectionId: secondId,
      credentialIdentityFingerprint: `sha256:${"c".repeat(64)}`,
    });
    second.finalizeResult = nativeOpenAIOnboardingSucceeded({
      connectionId: secondId,
      selectedModelId: "gpt-5.6-sol",
      verifiedModelCount: 3,
    });

    const result = await setupOpenAIConnection(
      directory,
      { modelId: "gpt-5.6-sol", acknowledgement: acknowledgement() },
      { nativeAuthority: second, now: () => new Date(AT) },
    );

    expect(result).toMatchObject({
      state: "ready",
      connection: { id: secondId, primary: false },
    });
    expect((await new FileConnectionRegistry(directory).read()).primaryConnectionId)
      .toBe(CONNECTION_ID);
  });

  it("blocks a second setup while the first native commit is pending", async () => {
    const directory = await root();
    let entered: (() => void) | undefined;
    const finalizeEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: (() => void) | undefined;
    const finalizeReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstNative = new ScriptedNativeOpenAIOnboarding();
    firstNative.beforeFinalize = async () => {
      entered?.();
      await finalizeReleased;
    };
    const first = setupOpenAIConnection(
      directory,
      { modelId: "gpt-5.6-sol", acknowledgement: acknowledgement() },
      { nativeAuthority: firstNative, now: () => new Date(AT) },
    );
    await finalizeEntered;

    const secondNative = new ScriptedNativeOpenAIOnboarding();
    const second = await setupOpenAIConnection(
      directory,
      { modelId: "gpt-5.6-sol", acknowledgement: acknowledgement() },
      { nativeAuthority: secondNative, now: () => new Date(AT) },
    );
    expect(second).toMatchObject({
      state: "failed",
      code: "activation_conflict",
      recovery: "pending_reconciliation",
    });
    expect(secondNative.calls).toEqual([]);

    release?.();
    await expect(first).resolves.toMatchObject({
      state: "ready",
      connection: { primary: true },
    });
  });

  it("recovers native-ready activation and removes the sidecar", async () => {
    const directory = await root();
    await new FileConnectionActivationStore(directory).prepare(
      pendingActivation(),
    );
    const native = new ScriptedNativeOpenAIOnboarding();

    const result = await recoverPendingOpenAIConnection(directory, {
      nativeAuthority: native,
    });

    expect(result).toMatchObject({
      state: "ready",
      disposition: "recovered",
      cleanupPending: false,
      connection: { id: CONNECTION_ID, primary: true },
    });
    expect(native.calls).toEqual([
      `reconcile:${CONNECTION_ID}:${FINGERPRINT}`,
    ]);
    expect((await new FileConnectionActivationStore(directory).read()).activation)
      .toBeNull();
  });

  it("discards a native-absent activation only when the registry is also absent", async () => {
    const directory = await root();
    await new FileConnectionActivationStore(directory).prepare(
      pendingActivation(),
    );
    const native = new ScriptedNativeOpenAIOnboarding();
    native.reconcileResult = nativeOpenAIOnboardingSucceeded({
      status: "absent",
    });

    const result = await recoverPendingOpenAIConnection(directory, {
      nativeAuthority: native,
    });

    expect(result).toEqual({ state: "discarded", connectionId: CONNECTION_ID });
    expect((await new FileConnectionActivationStore(directory).read()).activation)
      .toBeNull();
  });

  it("retains evidence for unresolved or inconsistent recovery", async () => {
    const unresolvedDirectory = await root();
    await new FileConnectionActivationStore(unresolvedDirectory).prepare(
      pendingActivation(),
    );
    const unresolvedNative = new ScriptedNativeOpenAIOnboarding();
    unresolvedNative.reconcileResult = nativeOpenAIOnboardingSucceeded({
      status: "unresolved",
    });
    const unresolved = await recoverPendingOpenAIConnection(
      unresolvedDirectory,
      { nativeAuthority: unresolvedNative },
    );
    expect(unresolved).toMatchObject({
      state: "failed",
      phase: "recovery",
      code: "reconciliation_required",
      recovery: "pending_reconciliation",
    });
    expect((await new FileConnectionActivationStore(unresolvedDirectory).read())
      .activation).not.toBeNull();

    const inconsistentDirectory = await root();
    const inconsistentStore = new FileConnectionActivationStore(
      inconsistentDirectory,
    );
    await inconsistentStore.prepare(pendingActivation());
    await inconsistentStore.commitToRegistry(pendingActivation());
    const absentNative = new ScriptedNativeOpenAIOnboarding();
    absentNative.reconcileResult = nativeOpenAIOnboardingSucceeded({
      status: "absent",
    });
    const inconsistent = await recoverPendingOpenAIConnection(
      inconsistentDirectory,
      { nativeAuthority: absentNative },
    );
    expect(inconsistent).toMatchObject({
      state: "failed",
      code: "inconsistent_recovery",
    });
    expect((await inconsistentStore.read()).activation).not.toBeNull();
  });

  it("normalizes recovery failures and retains the pending activation", async () => {
    const directory = await root();
    await new FileConnectionActivationStore(directory).prepare(
      pendingActivation(),
    );
    const hostile = `sk-proj-${"Z".repeat(48)}`;
    const native = new ScriptedNativeOpenAIOnboarding();
    native.reconcileResult = {
      state: "failed",
      code: "cleanup_failed",
      safeMessage: hostile,
    } as typeof native.reconcileResult;

    const result = await recoverPendingOpenAIConnection(directory, {
      nativeAuthority: native,
    });

    expect(result).toEqual({
      state: "failed",
      phase: "recovery",
      code: "cleanup_failed",
      safeMessage: "Native OpenAI onboarding cleanup failed.",
      recovery: "pending_reconciliation",
      connectionId: CONNECTION_ID,
    });
    expect(JSON.stringify(result)).not.toContain(hostile);
    expect((await new FileConnectionActivationStore(directory).read()).activation)
      .not.toBeNull();
  });
});
