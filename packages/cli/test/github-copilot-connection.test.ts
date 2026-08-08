import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  setupGitHubCopilotConnection,
  type DelegatedConnectionRecord,
} from "@recurs/app";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubCopilotRuntimeError } from "@recurs/runtimes";
import { githubCopilotSdkAddonPrefix } from "@recurs/runtimes";

import {
  createReviewedDelegatedRuntime,
  discoverGitHubCopilotSubscriptionModels,
  setupGitHubCopilotSubscription,
  verifyGitHubCopilotSubscriptionConnection,
} from "@recurs/cli";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function savedConnection(): Promise<DelegatedConnectionRecord> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-copilot-cli-"));
  directories.push(directory);
  return await setupGitHubCopilotConnection(directory, {
    accountSubjectFingerprint: `sha256:${"a".repeat(64)}`,
    accountDisplayLabel: "GitHub Copilot account",
    model: {
      id: "gpt-test",
      displayName: "GPT Test",
      supportsReasoningEffort: false,
      supportedReasoningEfforts: [],
    },
    billingSelection: "allow_declared_additional",
    now: "2026-08-07T00:00:00.000Z",
  });
}

async function installFixtureSdk(dataDirectory: string): Promise<void> {
  const prefix = githubCopilotSdkAddonPrefix(dataDirectory);
  const sdk = path.join(prefix, "node_modules", "@github", "copilot-sdk");
  await mkdir(sdk, { recursive: true });
  await writeFile(path.join(sdk, "package.json"), JSON.stringify({
    name: "@github/copilot-sdk",
    version: "1.0.8",
    type: "module",
    exports: "./index.js",
  }));
  await writeFile(path.join(sdk, "index.js"), "export class CopilotClient {}\n");
  const executable = path.join(prefix, "node_modules", ".bin", "copilot");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(executable, 0o700);
}

describe("GitHub Copilot connection dispatch", () => {
  it("uses the inspected SDK default only when it belongs to a reasoning model", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-copilot-cli-"));
    directories.push(directory);
    await installFixtureSdk(directory);
    const connection = await setupGitHubCopilotSubscription(directory, {
      modelId: "gpt-test",
      billingSelection: "allow_declared_additional",
      now: "2026-08-07T00:00:00.000Z",
    }, {
      inspect: async () => ({
        accountLogin: "octocat",
        accountSubjectFingerprint: `sha256:${"b".repeat(64)}`,
        authentication: "stored_oauth",
        models: [{
          id: "gpt-test",
          displayName: "GPT Test",
          maxContextTokens: 128_000,
          supportsReasoningEffort: true,
          reasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "high",
        }],
      }),
    });
    expect(connection.reasoningEffort).toBe("high");
  });

  it("turns signed-out explicit discovery into the official login action", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-copilot-cli-"));
    directories.push(directory);
    await installFixtureSdk(directory);
    const discovery = discoverGitHubCopilotSubscriptionModels(
      directory,
      new AbortController().signal,
      {
        inspect: async () => {
          throw new GitHubCopilotRuntimeError(
            "authentication_required",
            "bounded signed-out state",
          );
        },
      },
    );
    await expect(discovery).rejects.toMatchObject({
      code: "authentication_required",
      action: {
        environment: {
          COPILOT_DISABLE_KEYTAR: "1",
          COPILOT_HOME: path.join(
            await realpath(directory),
            "runtimes",
            "github-copilot-home",
          ),
        },
        thenEnter: "/login",
      },
    });
  });

  it("lets an already-aborted discovery win over optional SDK absence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-copilot-cli-"));
    directories.push(directory);
    const controller = new AbortController();
    controller.abort();
    await expect(discoverGitHubCopilotSubscriptionModels(
      directory,
      controller.signal,
    )).rejects.toMatchObject({ code: "cancelled", action: undefined });
  });

  it("verifies fresh auth, optional model effort, and the exact current policy", async () => {
    const connection = await savedConnection();
    const result = await verifyGitHubCopilotSubscriptionConnection(
      connection,
      new AbortController().signal,
      {
        dataDirectory: directories[0]!,
        inspect: async () => ({
          accountLogin: "octocat",
          accountSubjectFingerprint: connection.accountSubjectFingerprint,
          authentication: "stored_oauth",
          models: [{
            id: connection.modelId,
            displayName: "GPT Test",
            maxContextTokens: 128_000,
            supportsReasoningEffort: false,
            reasoningEfforts: [],
          }],
        }),
      },
    );
    expect(result).toEqual({ status: "verified" });
  });

  it("rejects a stale billing disclosure before inspecting the SDK", async () => {
    const connection = await savedConnection();
    let inspected = false;
    const stale: DelegatedConnectionRecord = {
      ...connection,
      billingSelection: {
        ...connection.billingSelection,
        disclosureRevision: "stale-disclosure",
      },
    };
    await expect(verifyGitHubCopilotSubscriptionConnection(
      stale,
      new AbortController().signal,
      {
        dataDirectory: directories[0]!,
        inspect: async () => {
          inspected = true;
          throw new Error("must not inspect");
        },
      },
    )).resolves.toEqual({ status: "failed", reason: "policy_stale" });
    expect(inspected).toBe(false);
  });

  it("rejects an arbitrary provider that borrows a reviewed adapter string", async () => {
    const connection = await savedConnection();
    expect(() => createReviewedDelegatedRuntime(
      { ...connection, providerId: "arbitrary-provider" },
      {} as never,
      { dataDirectory: directories[0]! },
    )).toThrow("Connection is not a reviewed delegated runtime record");
  });
});
