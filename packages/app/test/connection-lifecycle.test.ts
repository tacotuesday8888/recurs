import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConnectionLifecycleService,
  FileConnectionRegistry,
  type BrokeredModelProviderConnectionRecord,
  type ConnectionRegistryDocument,
  type ConnectionRegistryMutation,
  type ConnectionRegistryPort,
  type DelegatedConnectionRecord,
  type LocalConnectionRecord,
} from "../src/index.js";

const directories: string[] = [];
const at = "2026-07-12T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-lifecycle-"));
  directories.push(directory);
  return directory;
}

function local(): LocalConnectionRecord {
  return {
    kind: "local_openai_compatible",
    id: "local-primary",
    providerId: "local-openai-compatible",
    adapterId: "openai-chat-completions",
    label: "Local model",
    baseUrl: "http://127.0.0.1:11434/v1",
    modelId: "qwen",
    createdAt: at,
    updatedAt: at,
  };
}

function codex(): DelegatedConnectionRecord {
  return {
    kind: "delegated_agent",
    id: "codex-secondary",
    providerId: "openai-codex-chatgpt",
    adapterId: "codex-acp",
    label: "Codex with ChatGPT",
    accountLabel: "private-owner@example.com",
    organizationLabel: null,
    modelId: "gpt-test",
    accountSubjectFingerprint: `sha256:${"a".repeat(64)}`,
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
      acknowledgedAt: at,
    },
    verifiedAt: at,
    createdAt: at,
    updatedAt: at,
  };
}

function codexAppServer(): DelegatedConnectionRecord {
  return {
    ...codex(),
    id: "codex-app-server",
    adapterId: "codex-app-server",
    label: "GPT-5.6 Terra · ChatGPT",
    modelId: "gpt-5.6-terra",
    reasoningEffort: "medium",
    runtimeCapabilityProfileRevision:
      "codex-app-server-0.144.0-host-tools-v1",
  };
}

function brokered(): BrokeredModelProviderConnectionRecord {
  return {
    kind: "brokered_model_provider",
    id: "71000000-0000-4000-8000-000000000001",
    providerId: "openai-api",
    adapterId: "openai-responses",
    activationProfileId: "openai_api_v1",
    label: "OpenAI API",
    modelId: "gpt-5",
    credentialIdentityFingerprint: `sha256:${"b".repeat(64)}`,
    policyRevision: "openai-api-2026-07-11",
    billingPolicy: {
      revision: "billing:openai-api:2026-07-11",
      disclosureRevision: "billing-disclosure:openai-api:2026-07-11",
      primarySource: "metered_api",
      possibleAdditionalSources: [],
      providerFallback: "none",
      availableSelections: ["strict_primary_only"],
    },
    billingSelection: {
      mode: "strict_primary_only",
      policyRevision: "billing:openai-api:2026-07-11",
      disclosureRevision: "billing-disclosure:openai-api:2026-07-11",
      allowedSources: ["metered_api"],
      acknowledgedAt: at,
    },
    verifiedAt: at,
    createdAt: at,
    updatedAt: at,
  };
}

async function seededRegistry(): Promise<{
  root: string;
  registry: FileConnectionRegistry;
}> {
  const root = await temporaryRoot();
  const registry = new FileConnectionRegistry(root);
  await registry.commit(0, (draft) => {
    draft.connections.push(local(), codex());
    draft.primaryConnectionId = local().id;
  });
  return { root, registry };
}

class RacingRegistry implements ConnectionRegistryPort {
  commitCalls = 0;

  constructor(
    private readonly inner: FileConnectionRegistry,
    private conflictsRemaining: number,
  ) {}

  read(): Promise<ConnectionRegistryDocument> {
    return this.inner.read();
  }

  migrateLegacyLocal(
    options: { signal?: AbortSignal } = {},
  ): Promise<ConnectionRegistryDocument> {
    return this.inner.migrateLegacyLocal(options);
  }

  async commit(
    expectedRevision: number,
    mutation: ConnectionRegistryMutation,
    options: { signal?: AbortSignal } = {},
  ): Promise<ConnectionRegistryDocument> {
    this.commitCalls += 1;
    if (this.conflictsRemaining > 0) {
      this.conflictsRemaining -= 1;
      await this.inner.commit(expectedRevision, () => undefined, options);
    }
    return await this.inner.commit(expectedRevision, mutation, options);
  }
}

describe("connection lifecycle service", () => {
  it("lists brokered model providers without exposing their subject fingerprint", async () => {
    const registry = new FileConnectionRegistry(await temporaryRoot());
    await registry.commit(0, (draft) => {
      draft.connections.push(brokered());
      draft.primaryConnectionId = brokered().id;
    });

    const summaries = await new ConnectionLifecycleService(registry).list();

    expect(summaries).toEqual([{
      id: brokered().id,
      label: "OpenAI API",
      providerId: "openai-api",
      adapterId: "openai-responses",
      kind: "brokered_model_provider",
      modelId: "gpt-5",
      primary: true,
      account: "verified (identifier redacted)",
      execution: "Act + Plan",
      billingSources: ["metered_api"],
      agentRoles: [],
    }]);
    expect(JSON.stringify(summaries)).not.toContain(
      brokered().credentialIdentityFingerprint,
    );
  });

  it("does not remove brokered metadata before native disconnect is wired", async () => {
    const registry = new FileConnectionRegistry(await temporaryRoot());
    await registry.commit(0, (draft) => {
      draft.connections.push(brokered());
      draft.primaryConnectionId = brokered().id;
    });
    const service = new ConnectionLifecycleService(registry);

    await expect(service.disconnect(brokered().id)).rejects.toMatchObject({
      code: "operation_unavailable",
      message: "Brokered connection disconnection is not activated yet",
    });
    expect(await registry.read()).toMatchObject({
      primaryConnectionId: brokered().id,
      connections: [brokered()],
    });
  });

  it("fails brokered verification closed without calling direct adapters", async () => {
    const registry = new FileConnectionRegistry(await temporaryRoot());
    await registry.commit(0, (draft) => {
      draft.connections.push(brokered());
      draft.primaryConnectionId = brokered().id;
    });
    const before = await registry.read();
    const verifyLocal = vi.fn(async () => ({ status: "verified" as const }));
    const verifyDelegated = vi.fn(async () => ({ status: "verified" as const }));

    await expect(new ConnectionLifecycleService(registry).verify(
      brokered().id,
      { verifyLocal, verifyDelegated },
    )).rejects.toMatchObject({
      code: "verification_failed",
      reason: "adapter_unavailable",
      message: "Connection adapter is unavailable",
    });

    expect(verifyLocal).not.toHaveBeenCalled();
    expect(verifyDelegated).not.toHaveBeenCalled();
    expect(await registry.read()).toEqual(before);
  });

  it("lists deeply frozen summaries without private account or endpoint data", async () => {
    const { registry } = await seededRegistry();
    const summaries = await new ConnectionLifecycleService(registry).list();

    expect(summaries).toEqual([
      {
        id: "local-primary",
        label: "Local model",
        providerId: "local-openai-compatible",
        adapterId: "openai-chat-completions",
        kind: "local_openai_compatible",
        modelId: "qwen",
        primary: true,
        account: "local endpoint (no credential)",
        execution: "Act + Plan",
        billingSources: ["local_compute"],
        agentRoles: [],
      },
      {
        id: "codex-secondary",
        label: "Codex with ChatGPT",
        providerId: "openai-codex-chatgpt",
        adapterId: "codex-acp",
        kind: "delegated_agent",
        modelId: "gpt-test",
        primary: false,
        account: "verified (identifier redacted)",
        execution: "Plan-only",
        billingSources: ["included_subscription", "prepaid_credits"],
        agentRoles: [],
      },
    ]);
    const serialized = JSON.stringify(summaries);
    expect(serialized).not.toContain(local().baseUrl);
    expect(serialized).not.toContain(codex().accountLabel);
    expect(serialized).not.toContain(codex().accountSubjectFingerprint);
    expect(Object.isFrozen(summaries)).toBe(true);
    expect(Object.isFrozen(summaries[0])).toBe(true);
    expect(Object.isFrozen(summaries[0]?.billingSources)).toBe(true);
  });

  it("sets only one exact connection primary and leaves a no-op revision unchanged", async () => {
    const { registry } = await seededRegistry();
    const service = new ConnectionLifecycleService(registry);
    const before = await registry.read();

    await expect(service.setPrimary("local-primary")).resolves.toMatchObject({
      id: "local-primary",
      primary: true,
    });
    expect((await registry.read()).revision).toBe(before.revision);

    await expect(service.setPrimary("codex-secondary")).resolves.toMatchObject({
      id: "codex-secondary",
      primary: true,
    });
    expect((await registry.read()).primaryConnectionId).toBe("codex-secondary");
    await expect(service.setPrimary("codex-sec")).rejects.toMatchObject({
      code: "connection_not_found",
      message: "Connection not found",
    });
    await expect(service.setPrimary("Codex with ChatGPT")).rejects.toMatchObject({
      code: "connection_not_found",
    });
  });

  it("assigns explicit direct-provider team roles and rejects Plan-only routes", async () => {
    const { registry } = await seededRegistry();
    const service = new ConnectionLifecycleService(registry);

    await expect(service.setAgentRoute("implement", "local-primary"))
      .resolves.toEqual({ role: "implement", connectionId: "local-primary" });
    const assigned = await registry.read();
    expect(assigned.agentRoutes).toEqual({
      implement: "local-primary",
      review: null,
      repair: null,
    });
    expect((await service.list()).find((entry) => entry.id === "local-primary")?.agentRoles)
      .toEqual(["implement"]);
    await service.setAgentRoute("implement", "local-primary");
    expect((await registry.read()).revision).toBe(assigned.revision);

    await expect(service.setAgentRoute("review", "codex-secondary"))
      .rejects.toMatchObject({
        code: "operation_unavailable",
        message: "Plan-only delegated connections cannot run team roles",
      });
    await expect(service.setAgentRoute("implement", null)).resolves.toEqual({
      role: "implement",
      connectionId: null,
    });
    expect((await registry.read()).agentRoutes.implement).toBeNull();
  });

  it("assigns a host-tool Codex app-server connection to a team role", async () => {
    const registry = new FileConnectionRegistry(await temporaryRoot());
    const connection = codexAppServer();
    await registry.commit(0, (draft) => {
      draft.connections.push(connection);
      draft.primaryConnectionId = connection.id;
    });

    const service = new ConnectionLifecycleService(registry);
    await expect(service.setAgentRoute("implement", connection.id))
      .resolves.toEqual({ role: "implement", connectionId: connection.id });
    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        id: connection.id,
        execution: "Act + Plan",
        agentRoles: ["implement"],
      }),
    ]);
  });

  it("disconnects exact metadata without implicitly promoting another connection", async () => {
    const { registry } = await seededRegistry();
    const service = new ConnectionLifecycleService(registry);
    await service.setAgentRoute("implement", "local-primary");

    await expect(service.disconnect("codex-secondary")).resolves.toEqual({
      connectionId: "codex-secondary",
      primaryCleared: false,
      remainingConnections: 1,
    });
    expect((await registry.read()).primaryConnectionId).toBe("local-primary");

    await expect(service.disconnect("local-primary")).resolves.toEqual({
      connectionId: "local-primary",
      primaryCleared: true,
      remainingConnections: 0,
    });
    expect(await registry.read()).toMatchObject({
      primaryConnectionId: null,
      agentRoutes: { implement: null, review: null, repair: null },
      connections: [],
    });
    await expect(service.disconnect("local-primary")).rejects.toMatchObject({
      code: "connection_not_found",
    });
  });

  it("retries bounded revision conflicts and reports exhaustion safely", async () => {
    const { registry } = await seededRegistry();
    const once = new RacingRegistry(registry, 1);

    await expect(
      new ConnectionLifecycleService(once).setPrimary("codex-secondary"),
    ).resolves.toMatchObject({ id: "codex-secondary", primary: true });
    expect(once.commitCalls).toBe(2);

    await new ConnectionLifecycleService(registry).setPrimary("local-primary");
    const always = new RacingRegistry(registry, 3);
    let exhausted: unknown;
    try {
      await new ConnectionLifecycleService(always).setPrimary("codex-secondary");
    } catch (error) {
      exhausted = error;
    }
    expect(exhausted).toMatchObject({
      code: "registry_changed",
      message: "Connection registry changed; try again",
    });
    expect((exhausted as Error).cause).toBeUndefined();
    expect(always.commitCalls).toBe(3);
    expect((await registry.read()).primaryConnectionId).toBe("local-primary");
  });

  it("verifies an immutable exact record without mutating registry state", async () => {
    const { registry } = await seededRegistry();
    const service = new ConnectionLifecycleService(registry);
    const before = await registry.read();
    const verifyLocal = vi.fn(async (record: Readonly<LocalConnectionRecord>) => {
      expect(Object.isFrozen(record)).toBe(true);
      expect(record).toMatchObject({ id: "local-primary", modelId: "qwen" });
      return { status: "verified" as const };
    });
    const verifyDelegated = vi.fn(async () => ({ status: "verified" as const }));

    const verified = await service.verify("local-primary", {
      verifyLocal,
      verifyDelegated,
    });

    expect(verified).toEqual({
      verified: true,
      connection: expect.objectContaining({
        id: "local-primary",
        primary: true,
      }),
    });
    expect(verifyLocal).toHaveBeenCalledOnce();
    expect(verifyDelegated).not.toHaveBeenCalled();
    expect((await registry.read()).revision).toBe(before.revision);
    expect(JSON.stringify(verified)).not.toContain(local().baseUrl);
  });

  it("maps verification decisions, unknown failures, and cancellation to safe errors", async () => {
    const { registry } = await seededRegistry();
    const service = new ConnectionLifecycleService(registry);
    const unusedLocal = async () => ({ status: "verified" as const });

    await expect(service.verify("codex-secondary", {
      verifyLocal: unusedLocal,
      async verifyDelegated() {
        return { status: "failed", reason: "account_mismatch" } as const;
      },
    })).rejects.toMatchObject({
      code: "verification_failed",
      reason: "account_mismatch",
      message: "The active account does not match this connection",
    });

    const canary = "VENDOR_VERIFICATION_SECRET_CANARY";
    let caught: unknown;
    try {
      await service.verify("codex-secondary", {
        verifyLocal: unusedLocal,
        async verifyDelegated() {
          throw new Error(canary);
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "verification_failed",
      message: "Connection verification failed",
    });
    expect((caught as Error).message).not.toContain(canary);
    expect((caught as Error).cause).toBeUndefined();

    const controller = new AbortController();
    controller.abort();
    await expect(service.setPrimary("codex-secondary", {
      signal: controller.signal,
    })).rejects.toMatchObject({
      code: "cancelled",
      message: "Connection operation was cancelled",
    });
    expect((await registry.read()).primaryConnectionId).toBe("local-primary");
  });
});
