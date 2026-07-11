import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  FileConnectionRegistry,
  legacyLocalConnectionPath,
  type DelegatedConnectionRecord,
} from "@recurs/app";
import {
  createStandaloneRuntime,
  listAccountSummaries,
  listProviderSummaries,
  runCli,
} from "@recurs/cli";
import { afterEach, describe, expect, it } from "vitest";

const AT = "2026-07-11T00:00:00.000Z";
const roots: string[] = [];

class TextOutput {
  value = "";

  write(chunk: string | Uint8Array): boolean {
    this.value += typeof chunk === "string"
      ? chunk
      : new TextDecoder().decode(chunk);
    return true;
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function codexConnection(): DelegatedConnectionRecord {
  return {
    kind: "delegated_agent",
    id: "codex-chatgpt",
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
      acknowledgedAt: AT,
    },
    verifiedAt: AT,
    createdAt: AT,
    updatedAt: AT,
  };
}

describe("provider onboarding end to end", () => {
  it("lists the catalog and migrates a redacted local account without creating a session", async () => {
    const dataDirectory = await temporaryRoot("recurs-provider-e2e-");
    const legacy = legacyLocalConnectionPath(dataDirectory);
    await mkdir(path.dirname(legacy), { recursive: true, mode: 0o700 });
    await writeFile(legacy, `${JSON.stringify({
      schemaVersion: 1,
      kind: "local_openai_compatible",
      id: "legacy-local",
      label: "Local model",
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen-coder",
      createdAt: AT,
      updatedAt: AT,
    })}\n`, { mode: 0o600 });
    await chmod(legacy, 0o600);

    const providerOutput = new TextOutput();
    const accountOutput = new TextOutput();
    const stderr = new TextOutput();
    const dependencies = {
      stderr,
      async createRuntime() {
        throw new Error("catalog commands must not start the runtime");
      },
      async listProviders(input: { includeBlocked: boolean }) {
        return listProviderSummaries(input.includeBlocked);
      },
      async listAccounts() {
        return await listAccountSummaries(dataDirectory);
      },
    };

    expect(await runCli(
      ["provider", "list", "--json"],
      { ...dependencies, stdout: providerOutput },
    )).toBe(0);
    expect(await runCli(
      ["account", "list", "--json"],
      { ...dependencies, stdout: accountOutput },
    )).toBe(0);

    const providerPayload = JSON.parse(providerOutput.value) as {
      providers: Array<Record<string, unknown>>;
    };
    expect(providerPayload.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "openai-codex-chatgpt",
        status: "runnable",
        connectionOwner: "vendor_runtime",
      }),
      expect.objectContaining({
        id: "openai-api",
        status: "requires_native_broker",
        connectionOwner: "recurs_broker",
      }),
    ]));
    expect(providerPayload.providers.some(
      (entry) => entry["status"] === "blocked",
    )).toBe(false);

    expect(JSON.parse(accountOutput.value)).toMatchObject({
      version: 1,
      accounts: [{
        id: "legacy-local",
        account: "local endpoint (no credential)",
        execution: "Act + Plan",
      }],
    });
    expect(accountOutput.value).not.toContain("127.0.0.1");
    await expect(readFile(legacy, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(path.join(dataDirectory, "projects"))).rejects
      .toMatchObject({ code: "ENOENT" });
    expect(stderr.value).toBe("");
  });

  it("selects a persisted Codex connection as a Plan-only delegated pin without starting it", async () => {
    const root = await temporaryRoot("recurs-codex-pin-e2e-");
    const project = path.join(root, "project");
    const dataDirectory = path.join(root, "data");
    await mkdir(project);
    const record = codexConnection();
    const registry = new FileConnectionRegistry(dataDirectory);
    await registry.commit(0, (draft) => {
      draft.connections.push(record);
      draft.primaryConnectionId = record.id;
    });
    let runtimeStarted = false;

    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: project,
        dataDirectory,
        delegatedRuntimeFactory() {
          runtimeStarted = true;
          throw new Error("runtime must not start during assembly");
        },
      },
    );

    expect(runtimeStarted).toBe(false);
    expect(runtime.session).toMatchObject({
      executionMode: "plan",
      backend: {
        pin: {
          kind: "agent_runtime",
          connectionId: record.id,
          providerId: record.providerId,
          adapterId: record.adapterId,
          billingSelectionAtCreation: {
            mode: "allow_declared_additional",
          },
        },
      },
    });
  });
});
