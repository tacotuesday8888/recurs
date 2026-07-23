import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FileConnectionRegistry,
  connectionRegistryPath,
  setupEnvironmentConnection,
  type BrokeredModelProviderConnectionRecord,
  type DelegatedConnectionRecord,
  type LocalConnectionRecord,
} from "@recurs/app";
import type { NativeOpenAIResponsesPort } from "@recurs/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  copyConfiguredEvaluationConnection,
  runCompanyEvaluationCommand,
} from "../src/company-evaluation-command.js";

const AT = "2026-07-22T00:00:00.000Z";
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function temporaryRoot(name: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), name));
  directories.push(directory);
  return directory;
}

function local(id: string, label: string): LocalConnectionRecord {
  return {
    kind: "local_openai_compatible",
    id,
    providerId: "local-openai-compatible",
    adapterId: "openai-chat-completions",
    label,
    baseUrl: "http://127.0.0.1:11434/v1",
    modelId: "qwen-coder",
    createdAt: AT,
    updatedAt: AT,
  };
}

const billingPolicy = {
  revision: "billing:openai-api:2026-07-11",
  disclosureRevision: "billing-disclosure:openai-api:2026-07-11",
  primarySource: "metered_api" as const,
  possibleAdditionalSources: [],
  providerFallback: "none" as const,
  availableSelections: ["strict_primary_only" as const],
};

const billingSelection = {
  mode: "strict_primary_only" as const,
  policyRevision: billingPolicy.revision,
  disclosureRevision: billingPolicy.disclosureRevision,
  allowedSources: ["metered_api" as const],
  acknowledgedAt: AT,
};

function brokered(): BrokeredModelProviderConnectionRecord {
  return {
    kind: "brokered_model_provider",
    id: "71000000-0000-4000-8000-000000000001",
    providerId: "openai-api",
    adapterId: "openai-responses",
    activationProfileId: "openai_api_v1",
    label: "Private broker label",
    modelId: "gpt-5.6-sol",
    credentialIdentityFingerprint: `sha256:${"b".repeat(64)}`,
    policyRevision: "openai-api-2026-07-11",
    billingPolicy,
    billingSelection,
    verifiedAt: AT,
    createdAt: AT,
    updatedAt: AT,
  };
}

function delegated(): DelegatedConnectionRecord {
  return {
    kind: "delegated_agent",
    id: "codex-plan-only",
    providerId: "openai-codex-chatgpt",
    adapterId: "codex-acp",
    label: "Private Codex label",
    accountLabel: "private@example.com",
    organizationLabel: null,
    modelId: "gpt-5.6-sol",
    accountSubjectFingerprint: `sha256:${"a".repeat(64)}`,
    policyRevision: "openai-codex-chatgpt-2026-07-11",
    billingPolicy: {
      ...billingPolicy,
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
      acknowledgedAt: AT,
    },
    verifiedAt: AT,
    createdAt: AT,
    updatedAt: AT,
  };
}

describe("configured company evaluation connection selection", () => {
  it("copies one exact non-primary environment connection without mutating the source", async () => {
    const source = await temporaryRoot("recurs-eval-source-");
    const target = await temporaryRoot("recurs-eval-target-");
    const configured = await setupEnvironmentConnection(source, {
      providerId: "xai-api",
      modelId: "grok-code-fast",
      credentialEnvironmentVariable: "XAI_API_KEY",
      billingSelection: "strict_primary_only",
      environment: { XAI_API_KEY: "fixture-private-value" },
      now: AT,
    }, {
      fetch: async () => new Response(JSON.stringify({
        models: [{ id: "grok-code-fast", object: "model", owned_by: "xai" }],
      }), { status: 200 }),
    });
    const sourceRegistry = new FileConnectionRegistry(source);
    const beforePrimary = local("local-primary", "Private local label");
    const document = await sourceRegistry.read();
    await sourceRegistry.commit(document.revision, (draft) => {
      draft.connections.push(beforePrimary);
      draft.primaryConnectionId = beforePrimary.id;
    });
    const before = await readFile(connectionRegistryPath(source), "utf8");

    const selected = await copyConfiguredEvaluationConnection(
      source,
      target,
      configured.id,
    );

    expect(selected).toMatchObject({
      id: configured.id,
      kind: "environment_model_provider",
    });
    await expect(new FileConnectionRegistry(target).read()).resolves.toEqual(
      expect.objectContaining({
        primaryConnectionId: configured.id,
        connections: [expect.objectContaining({ id: configured.id })],
      }),
    );
    expect(await readFile(connectionRegistryPath(source), "utf8")).toBe(before);
  });

  it("uses the primary by default and accepts local and brokered model routes", async () => {
    for (const connection of [local("local-exact", "Local"), brokered()]) {
      const source = await temporaryRoot("recurs-eval-source-");
      const target = await temporaryRoot("recurs-eval-target-");
      const registry = new FileConnectionRegistry(source);
      await registry.commit(0, (draft) => {
        draft.connections.push(connection);
        draft.primaryConnectionId = connection.id;
      });

      await expect(copyConfiguredEvaluationConnection(source, target, null))
        .resolves.toMatchObject({ id: connection.id, kind: connection.kind });
    }
  });

  it("rejects missing and delegated routes without exposing stored metadata", async () => {
    const source = await temporaryRoot("recurs-eval-source-");
    const target = await temporaryRoot("recurs-eval-target-");
    const registry = new FileConnectionRegistry(source);
    await registry.commit(0, (draft) => {
      draft.connections.push(delegated());
      draft.primaryConnectionId = "codex-plan-only";
    });

    await expect(copyConfiguredEvaluationConnection(
      source,
      target,
      "missing-exact",
    )).rejects.toThrow("The selected provider connection is unavailable.");

    let failure = "";
    try {
      await copyConfiguredEvaluationConnection(source, target, null);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toBe(
      "Codex and other delegated subscriptions are Plan-only here; choose a direct API or local model connection for company formation evaluation.",
    );
    expect(failure).not.toContain("private@example.com");
    expect(failure).not.toContain("Private Codex label");
    expect(failure).not.toContain("sha256:");
    expect(failure).not.toContain(source);
  });

  it("composes a selected brokered route only through the injected native port", async () => {
    const source = await temporaryRoot("recurs-eval-source-");
    const projectRoot = await temporaryRoot("recurs-eval-project-");
    await writeFile(path.join(projectRoot, "package.json"), "{}\n", "utf8");
    const selected = brokered();
    const registry = new FileConnectionRegistry(source);
    await registry.commit(0, (draft) => {
      draft.connections.push(local("local-primary", "Local"), selected);
      draft.primaryConnectionId = "local-primary";
    });
    const seenConnectionIds: string[] = [];
    const nativeOpenAIResponses: NativeOpenAIResponsesPort = {
      async *streamOpenAIResponses(request) {
        seenConnectionIds.push(
          request.directContext?.authorization.connectionId ?? "missing",
        );
        yield { type: "done", stopReason: "complete" };
      },
    };

    const report = await runCompanyEvaluationCommand({
      action: "run",
      scenario: "company_formation_v1",
      mode: "configured",
      allowNetwork: true,
      connectionId: selected.id,
      json: true,
    }, {
      projectRoot,
      dataDirectory: source,
      nativeOpenAIResponses,
      environment: {},
    });

    expect(report).toMatchObject({
      scenarioId: "company_formation_v1",
      mode: "configured",
      backend: {
        providerId: selected.providerId,
        modelId: selected.modelId,
      },
    });
    expect(seenConnectionIds, JSON.stringify(report)).toEqual([selected.id]);
  });
});
