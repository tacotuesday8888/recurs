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
import { Readable } from "node:stream";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  FileConnectionRegistry,
  legacyLocalConnectionPath,
  type DelegatedConnectionRecord,
} from "@recurs/app";
import {
  createStandaloneRuntime,
  disconnectAccount,
  listAccountSummaries,
  listProviderSummaries,
  runCli,
  setPrimaryAccount,
  verifyAccount,
  writeLocalConnection,
} from "@recurs/cli";
import { afterEach, describe, expect, it } from "vitest";

const AT = "2026-07-11T00:00:00.000Z";
const roots: string[] = [];
const servers: Server[] = [];

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
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    })
  ));
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function localModelServer(
  modelId: string,
  responseText: string,
): Promise<{ baseUrl: string; promptRequests(): number }> {
  let prompts = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        data: [{ id: modelId, object: "model", owned_by: "local" }],
      }));
      return;
    }
    if (
      request.method === "POST" &&
      request.url === "/v1/chat/completions"
    ) {
      prompts += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          choices: [{
            delta: { content: responseText },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    promptRequests: () => prompts,
  };
}

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

  it("selects a Plan-only Codex pin and rejects piped prompts before starting it", async () => {
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

    const stdout = new TextOutput();
    const stderr = new TextOutput();
    expect(await runCli([], {
      stdin: Readable.from(["inspect the workspace\n"]),
      stdout,
      stderr,
      interactive: false,
      async createRuntime() { return runtime; },
    })).toBe(2);
    expect(runtimeStarted).toBe(false);
    expect(runtime.session.messages).toEqual([]);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("user-present local terminal");
  });

  it("keeps historical sessions pinned across selection, verification, and disconnection", async () => {
    const root = await temporaryRoot("recurs-lifecycle-e2e-");
    const project = path.join(root, "project");
    const dataDirectory = path.join(root, "data");
    await mkdir(project);
    const serverA = await localModelServer("model-a", "from connection A");
    const serverB = await localModelServer("model-b", "from connection B");
    const connectionA = await writeLocalConnection(dataDirectory, {
      baseUrl: serverA.baseUrl,
      modelId: "model-a",
      now: "2026-07-12T00:00:00.000Z",
    });
    const connectionB = await writeLocalConnection(dataDirectory, {
      baseUrl: serverB.baseUrl,
      modelId: "model-b",
      now: "2026-07-12T00:01:00.000Z",
    });
    expect(connectionA.primary).toBe(true);
    expect(connectionB.primary).toBe(false);

    const runtimeA = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: project, dataDirectory },
    );
    await expect(runtimeA.submit("first run")).resolves.toMatchObject({
      finalText: "from connection A",
    });
    const historicalSessionId = runtimeA.session.id;
    expect(serverA.promptRequests()).toBe(1);
    expect(serverB.promptRequests()).toBe(0);

    const stdout = new TextOutput();
    const stderr = new TextOutput();
    const lifecycleDependencies = {
      stdout,
      stderr,
      cwd: project,
      interactive: true,
      automation: false,
      async confirm() { return true; },
      async createRuntime() {
        throw new Error("account commands must not start a runtime");
      },
      setPrimaryAccount: (id: string) => setPrimaryAccount(dataDirectory, id),
      verifyAccount: (id: string, cwd: string) =>
        verifyAccount(dataDirectory, id, cwd),
      disconnectAccount: (id: string) => disconnectAccount(dataDirectory, id),
      listAccounts: () => listAccountSummaries(dataDirectory),
    };

    expect(await runCli(
      ["account", "set-primary", connectionB.id],
      lifecycleDependencies,
    )).toBe(0);
    const beforeVerification = await new FileConnectionRegistry(
      dataDirectory,
    ).read();
    expect(await runCli(
      ["account", "verify", connectionB.id],
      lifecycleDependencies,
    )).toBe(0);
    expect((await new FileConnectionRegistry(dataDirectory).read()).revision)
      .toBe(beforeVerification.revision);

    const runtimeB = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: project, dataDirectory },
    );
    expect(runtimeB.session.backend.pin.connectionId).toBe(connectionB.id);
    await expect(runtimeB.submit("new primary run")).resolves.toMatchObject({
      finalText: "from connection B",
    });
    expect(serverB.promptRequests()).toBe(1);

    await expect(runtimeB.submit(`/resume ${historicalSessionId}`)).resolves
      .toMatchObject({ text: `Resumed session ${historicalSessionId}` });
    await expect(runtimeB.submit("continue old work")).resolves.toMatchObject({
      finalText: "from connection A",
    });
    expect(runtimeB.session.backend.pin.connectionId).toBe(connectionA.id);
    expect(serverA.promptRequests()).toBe(2);

    expect(await runCli(
      ["account", "disconnect", connectionA.id],
      lifecycleDependencies,
    )).toBe(0);
    await expect(runtimeB.submit("must fail closed")).rejects.toMatchObject({
      failure: {
        domain: "connection",
        phase: "preflight",
        code: "connection_invalid",
      },
    });
    expect(serverA.promptRequests()).toBe(2);

    expect(await runCli(
      ["account", "disconnect", connectionB.id],
      lifecycleDependencies,
    )).toBe(0);
    const restarted = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: project, dataDirectory },
    );
    expect(restarted.state).toMatchObject({ type: "workspace" });

    const accountJson = new TextOutput();
    expect(await runCli(
      ["account", "list", "--json"],
      { ...lifecycleDependencies, stdout: accountJson },
    )).toBe(0);
    expect(accountJson.value).not.toContain(serverA.baseUrl);
    expect(accountJson.value).not.toContain(serverB.baseUrl);
    expect(JSON.parse(accountJson.value)).toEqual({
      version: 1,
      accounts: [],
    });
    expect(stderr.value).toBe("");
  });
});
