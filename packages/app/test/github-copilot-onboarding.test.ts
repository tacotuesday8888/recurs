import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FileConnectionRegistry,
  setupGitHubCopilotConnection,
} from "@recurs/app";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const now = "2026-08-07T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-copilot-onboarding-"));
  directories.push(directory);
  return directory;
}

describe("GitHub Copilot subscription onboarding", () => {
  it("persists one account/model/effort binding with explicit Additional usage acknowledgement", async () => {
    const directory = await root();
    const connection = await setupGitHubCopilotConnection(directory, {
      accountSubjectFingerprint: `sha256:${"a".repeat(64)}`,
      accountDisplayLabel: "GitHub Copilot account",
      model: {
        id: "gpt-test",
        displayName: "GPT Test",
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "low",
      },
      reasoningEffort: "high",
      billingSelection: "allow_declared_additional",
      now,
    }, { createId: () => "connection-1" });

    expect(connection).toMatchObject({
      id: "copilot-connection-1",
      providerId: "github-copilot-subscription",
      adapterId: "github-copilot-sdk",
      modelId: "gpt-test",
      reasoningEffort: "high",
      runtimeCapabilityProfileRevision:
        "github-copilot-sdk-1.0.8-host-tools-v1",
      billingPolicy: {
        primarySource: "included_subscription",
        possibleAdditionalSources: ["metered_api"],
        providerFallback: "user_configured",
        availableSelections: ["allow_declared_additional"],
      },
      billingSelection: {
        mode: "allow_declared_additional",
        allowedSources: ["included_subscription", "metered_api"],
        acknowledgedAt: now,
      },
    });
    const document = await new FileConnectionRegistry(directory).read();
    expect(document.primaryConnectionId).toBe(connection.id);
    expect(JSON.stringify(document)).not.toContain("octocat");
  });

  it("is idempotent and rejects unsupported effort or missing billing acknowledgement", async () => {
    const directory = await root();
    const input = {
      accountSubjectFingerprint: `sha256:${"b".repeat(64)}`,
      accountDisplayLabel: "GitHub Copilot account",
      model: {
        id: "gpt-test",
        displayName: "GPT Test",
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low", "high"] as const,
        defaultReasoningEffort: "low" as const,
      },
      reasoningEffort: "high" as const,
      billingSelection: "allow_declared_additional" as const,
      now,
    };
    const first = await setupGitHubCopilotConnection(
      directory,
      input,
      { createId: () => "same" },
    );
    const second = await setupGitHubCopilotConnection(
      directory,
      { ...input, now: "2026-08-07T00:01:00.000Z" },
      { createId: () => "unexpected" },
    );
    expect(second.id).toBe(first.id);

    await expect(setupGitHubCopilotConnection(directory, {
      ...input,
      reasoningEffort: "medium",
    })).rejects.toThrow("GitHub Copilot setup input is invalid");
    await expect(setupGitHubCopilotConnection(directory, {
      ...input,
      billingSelection: "strict_primary_only" as never,
    })).rejects.toThrow("GitHub Copilot setup input is invalid");
  });

  it("does not reuse an id owned by another provider that claims the Copilot adapter", async () => {
    const directory = await root();
    const input = {
      accountSubjectFingerprint: `sha256:${"f".repeat(64)}`,
      accountDisplayLabel: "GitHub Copilot account",
      model: {
        id: "gpt-test",
        displayName: "GPT Test",
        supportsReasoningEffort: false,
        supportedReasoningEfforts: [] as const,
      },
      billingSelection: "allow_declared_additional" as const,
      now,
    };
    const first = await setupGitHubCopilotConnection(
      directory,
      input,
      { createId: () => "foreign" },
    );
    const registry = new FileConnectionRegistry(directory);
    const current = await registry.read();
    await registry.commit(current.revision, (draft) => {
      const record = draft.connections.find((connection) => connection.id === first.id);
      if (record?.kind === "delegated_agent") record.providerId = "arbitrary-provider";
    });

    const second = await setupGitHubCopilotConnection(
      directory,
      input,
      { createId: () => "reviewed" },
    );
    const saved = await registry.read();
    expect(second.id).toBe("copilot-reviewed");
    expect(saved.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, providerId: "arbitrary-provider" }),
      expect.objectContaining({ id: second.id, providerId: "github-copilot-subscription" }),
    ]));
  });

  it("persists a model that explicitly does not support reasoning without an effort", async () => {
    const connection = await setupGitHubCopilotConnection(await root(), {
      accountSubjectFingerprint: `sha256:${"c".repeat(64)}`,
      accountDisplayLabel: "GitHub Copilot account",
      model: {
        id: "non-reasoning-model",
        displayName: "Non-reasoning model",
        supportsReasoningEffort: false,
        supportedReasoningEfforts: [],
      },
      billingSelection: "allow_declared_additional",
      now,
    });

    expect(connection.reasoningEffort).toBeUndefined();
    expect(Object.hasOwn(connection, "reasoningEffort")).toBe(false);
  });

  it("does not persist a connection after the reviewed provider policy expires", async () => {
    const directory = await root();
    await expect(setupGitHubCopilotConnection(directory, {
      accountSubjectFingerprint: `sha256:${"e".repeat(64)}`,
      accountDisplayLabel: "GitHub Copilot account",
      model: {
        id: "gpt-test",
        displayName: "GPT Test",
        supportsReasoningEffort: false,
        supportedReasoningEfforts: [],
      },
      billingSelection: "allow_declared_additional",
      now: "2026-10-12T00:00:00.000Z",
    })).rejects.toThrow("Reviewed GitHub Copilot subscription policy is unavailable");
    expect((await new FileConnectionRegistry(directory).read()).connections).toEqual([]);
  });

  it.each([
    { accountDisplayLabel: " account" },
    { accountDisplayLabel: "account\nlabel" },
    { model: { id: "gpt-test", displayName: " Model", supportsReasoningEffort: true, supportedReasoningEfforts: ["low"] } },
    { model: { id: "gpt-test", displayName: "Model\u0000", supportsReasoningEffort: true, supportedReasoningEfforts: ["low"] } },
    { model: { id: "gpt-test", displayName: "M".repeat(250), supportsReasoningEffort: true, supportedReasoningEfforts: ["low"] } },
    { model: { id: "gpt-test", displayName: "Model", supportsReasoningEffort: true, supportedReasoningEfforts: ["low", "low"] } },
    { model: { id: "gpt-test", displayName: "Model", supportsReasoningEffort: true, supportedReasoningEfforts: ["low"], defaultReasoningEffort: "high" } },
    { model: { id: "gpt-test", displayName: "Model", supportsReasoningEffort: false, supportedReasoningEfforts: ["low"] } },
  ])("rejects malformed SDK-derived display or effort metadata", async (override) => {
    const baseline = {
      accountSubjectFingerprint: `sha256:${"d".repeat(64)}`,
      accountDisplayLabel: "GitHub Copilot account",
      model: {
        id: "gpt-test",
        displayName: "Model",
        supportsReasoningEffort: true,
        supportedReasoningEfforts: ["low"] as const,
      },
      reasoningEffort: "low" as const,
      billingSelection: "allow_declared_additional" as const,
      now,
    };
    await expect(setupGitHubCopilotConnection(await root(), {
      ...baseline,
      ...override,
    } as never)).rejects.toThrow("GitHub Copilot setup input is invalid");
  });
});
