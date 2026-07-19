import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConnectionLifecycleService,
  FileConnectionRegistry,
  OnboardingCatalog,
  connectionRegistryPath,
  setupEnvironmentConnection,
  verifyEnvironmentConnection,
} from "../src/index.js";

const roots: string[] = [];
const AT = "2026-07-19T00:00:00.000Z";

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-byok-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("saved environment BYOK connections", () => {
  it("advertises reviewed Chat and Anthropic Messages paths as BYOK without widening blocked providers", () => {
    const entries = new OnboardingCatalog(undefined, {
      now: () => new Date(AT),
    }).list({ includeBlocked: true });

    expect(entries.find((entry) => entry.id === "openrouter-api"))
      .toMatchObject({
        status: "runnable_byok",
        connectionOwner: "process_environment",
      });
    expect(entries.find((entry) => entry.id === "kimi-code"))
      .toMatchObject({ status: "runnable_byok" });
    expect(entries.find((entry) => entry.id === "zai-glm-coding-plan"))
      .toMatchObject({ status: "blocked" });
    expect(entries.find((entry) => entry.id === "anthropic-api"))
      .toMatchObject({
        status: "runnable_byok",
        protocol: "anthropic_messages",
        connectionOwner: "process_environment",
      });
    expect(entries.find((entry) => entry.id === "openai-api"))
      .toMatchObject({ status: "requires_native_broker" });
  });

  it("stores only an environment reference and fingerprint, then runs through account lifecycle", async () => {
    const directory = await root();
    const key = "byok-private-value";
    const configured = await setupEnvironmentConnection(directory, {
      providerId: "openrouter-api",
      modelId: "anthropic/claude-sonnet",
      credentialEnvironmentVariable: "OPENROUTER_API_KEY",
      billingSelection: "strict_primary_only",
      environment: { OPENROUTER_API_KEY: key },
      now: AT,
    });

    expect(configured).toMatchObject({
      providerId: "openrouter-api",
      modelId: "anthropic/claude-sonnet",
      credentialEnvironmentVariable: "OPENROUTER_API_KEY",
      primary: true,
    });
    const storedText = await readFile(connectionRegistryPath(directory), "utf8");
    expect(storedText).not.toContain(key);
    expect(storedText).toContain("OPENROUTER_API_KEY");
    const registry = new FileConnectionRegistry(directory);
    const stored = (await registry.read()).connections[0];
    expect(stored).toMatchObject({
      kind: "environment_model_provider",
      credentialIdentityFingerprint: expect.stringMatching(
        /^sha256:[a-f0-9]{64}$/u,
      ),
    });
    if (stored?.kind !== "environment_model_provider") {
      throw new Error("expected environment connection");
    }
    await expect(verifyEnvironmentConnection(stored, {
      OPENROUTER_API_KEY: key,
    })).resolves.toEqual({ status: "verified" });
    await expect(verifyEnvironmentConnection(stored, {})).resolves.toEqual({
      status: "failed",
      reason: "authentication_required",
    });
    await expect(verifyEnvironmentConnection(stored, {
      OPENROUTER_API_KEY: "different-private-value",
    })).resolves.toEqual({
      status: "failed",
      reason: "account_mismatch",
    });

    const service = new ConnectionLifecycleService(registry);
    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({
        id: configured.id,
        kind: "environment_model_provider",
        account: "environment credential (value not stored)",
        primary: true,
      }),
    ]);
    await expect(service.disconnect(configured.id)).resolves.toMatchObject({
      connectionId: configured.id,
      primaryCleared: true,
    });
  });

  it("persists an Anthropic Messages adapter without persisting its credential", async () => {
    const directory = await root();
    const key = "anthropic-private-value";
    const configured = await setupEnvironmentConnection(directory, {
      providerId: "anthropic-api",
      modelId: "claude-test",
      credentialEnvironmentVariable: "ANTHROPIC_API_KEY",
      billingSelection: "strict_primary_only",
      environment: { ANTHROPIC_API_KEY: key },
      now: AT,
    });

    const storedText = await readFile(connectionRegistryPath(directory), "utf8");
    expect(storedText).not.toContain(key);
    expect(storedText).toContain("ANTHROPIC_API_KEY");
    expect((await new FileConnectionRegistry(directory).read()).connections)
      .toEqual([
        expect.objectContaining({
          id: configured.id,
          kind: "environment_model_provider",
          providerId: "anthropic-api",
          adapterId: "anthropic-messages",
          modelId: "claude-test",
        }),
      ]);
  });

  it("updates an explicit provider/env binding without redirecting its stable identity", async () => {
    const directory = await root();
    const first = await setupEnvironmentConnection(directory, {
      providerId: "deepseek-api",
      modelId: "deepseek-chat",
      credentialEnvironmentVariable: "DEEPSEEK_API_KEY",
      billingSelection: "strict_primary_only",
      environment: { DEEPSEEK_API_KEY: "first-private-value" },
      now: AT,
    });
    const second = await setupEnvironmentConnection(directory, {
      providerId: "deepseek-api",
      modelId: "deepseek-reasoner",
      credentialEnvironmentVariable: "DEEPSEEK_API_KEY",
      billingSelection: "strict_primary_only",
      environment: { DEEPSEEK_API_KEY: "second-private-value" },
      now: "2026-07-19T00:01:00.000Z",
    });

    expect(second.id).toBe(first.id);
    expect(second.primary).toBe(true);
    expect((await new FileConnectionRegistry(directory).read()).connections)
      .toHaveLength(1);
  });

  it("fails closed for absent secrets, unsafe references, blocked providers, and billing mismatches", async () => {
    const directory = await root();
    const base = {
      modelId: "model",
      credentialEnvironmentVariable: "PROVIDER_API_KEY",
      billingSelection: "strict_primary_only" as const,
      environment: { PROVIDER_API_KEY: "private-value" },
      now: AT,
    };
    await expect(setupEnvironmentConnection(directory, {
      ...base,
      providerId: "openrouter-api",
      environment: {},
    })).rejects.toMatchObject({ code: "credential_unavailable" });
    await expect(setupEnvironmentConnection(directory, {
      ...base,
      providerId: "openrouter-api",
      credentialEnvironmentVariable: "PROVIDER_CREDENTIAL",
    })).rejects.toMatchObject({ code: "configuration_invalid" });
    await expect(setupEnvironmentConnection(directory, {
      ...base,
      providerId: "zai-glm-coding-plan",
    })).rejects.toMatchObject({ code: "provider_unsupported" });
    await expect(setupEnvironmentConnection(directory, {
      ...base,
      providerId: "openrouter-api",
      billingSelection: "allow_declared_additional",
    })).rejects.toMatchObject({ code: "billing_policy_blocked" });
  });
});
