import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileConnectionRegistry,
  setupCodexAppServerConnections,
} from "@recurs/app";

const directories: string[] = [];
const now = "2026-07-23T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-codex-app-server-"));
  directories.push(directory);
  return directory;
}

const models = [
  {
    id: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    defaultReasoningEffort: "low" as const,
    supportedReasoningEfforts: ["low", "medium", "high", "ultra"] as const,
  },
  {
    id: "gpt-5.6-terra",
    displayName: "GPT-5.6 Terra",
    defaultReasoningEffort: "medium" as const,
    supportedReasoningEfforts: ["low", "medium", "high", "ultra"] as const,
  },
  {
    id: "gpt-5.6-luna",
    displayName: "GPT-5.6 Luna",
    defaultReasoningEffort: "medium" as const,
    supportedReasoningEfforts: ["low", "medium", "high", "max"] as const,
  },
];

describe("Codex app-server onboarding", () => {
  it("creates a Sol parent with Terra implementation and Luna review routes", async () => {
    const directory = await root();
    let nextId = 0;
    const result = await setupCodexAppServerConnections(directory, {
      accountSubjectFingerprint: `sha256:${"a".repeat(64)}`,
      accountDisplayLabel: "ChatGPT Pro subscription",
      models,
      billingSelection: "allow_declared_additional",
      now,
    }, { createId: () => `id-${++nextId}` });

    expect(result.connections).toHaveLength(3);
    const byModel = new Map(result.connections.map((record) => [record.modelId, record]));
    expect(result.primaryConnectionId).toBe(byModel.get("gpt-5.6-sol")!.id);
    expect(byModel.get("gpt-5.6-sol")).toMatchObject({
      adapterId: "codex-app-server",
      reasoningEffort: "high",
      runtimeCapabilityProfileRevision:
        "codex-app-server-0.144.0-host-tools-v1",
    });
    expect(result.agentRoutes).toEqual({
      implement: byModel.get("gpt-5.6-terra")!.id,
      review: byModel.get("gpt-5.6-luna")!.id,
      repair: byModel.get("gpt-5.6-terra")!.id,
    });
  });

  it("is idempotent for the same account and models", async () => {
    const directory = await root();
    let nextId = 0;
    const input = {
      accountSubjectFingerprint: `sha256:${"b".repeat(64)}`,
      accountDisplayLabel: "ChatGPT Plus subscription",
      models,
      billingSelection: "allow_declared_additional" as const,
      now,
    };
    const first = await setupCodexAppServerConnections(
      directory,
      input,
      { createId: () => `id-${++nextId}` },
    );
    const second = await setupCodexAppServerConnections(
      directory,
      { ...input, now: "2026-07-23T00:01:00.000Z" },
      { createId: () => `unexpected-${++nextId}` },
    );
    expect(second.connections.map((record) => record.id)).toEqual(
      first.connections.map((record) => record.id),
    );
    expect((await new FileConnectionRegistry(directory).read()).connections)
      .toHaveLength(3);
  });
});
