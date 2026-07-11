import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  BackendResolver,
  SessionBackendPin,
  TrustedRunContext,
} from "@recurs/contracts";
import { verifyRunAuthorization } from "@recurs/core";
import { ScriptedProvider } from "@recurs/providers";
import { afterEach, describe, expect, it } from "vitest";

import {
  RuntimeError,
  createStandaloneRuntime,
  writeLocalConnection,
} from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("standalone assembly without a provider", () => {
  it("loads a configured local connection into an exact pinned session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-local-assembly-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const dataDirectory = path.join(root, "data");
    const connection = await writeLocalConnection(dataDirectory, {
      baseUrl: "http://127.0.0.1:11434/v1",
      modelId: "qwen-coder",
      now: "2026-07-11T00:00:00.000Z",
    });

    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: workspace, dataDirectory },
    );

    expect(runtime.state).toMatchObject({
      type: "session",
      session: {
        model: "qwen-coder",
        backend: {
          type: "pinned",
          pin: {
            providerId: "local-openai-compatible",
            adapterId: "openai-chat-completions",
            connectionId: connection.id,
            primaryBillingSourceAtCreation: "local_compute",
          },
        },
      },
    });
  });

  it("starts in a workspace shell without creating a fake session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-workspace-shell-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const dataDirectory = path.join(root, "data");
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      { cwd: workspace, dataDirectory },
    );

    expect(runtime.state).toMatchObject({
      type: "workspace",
      cwd: await realpath(workspace),
      permissionMode: "ask_always",
    });
    expect(await runtime.submit("/status")).toMatchObject({
      text: expect.stringContaining("No active session"),
    });
    const help = await runtime.submit("/help");
    expect(help).toMatchObject({ text: expect.stringContaining("/connect") });
    expect(help).not.toMatchObject({ text: expect.stringContaining("/goal") });
    expect(await runtime.submit("/goal ship it")).toMatchObject({
      level: "error",
      text: expect.stringContaining("requires an active model session"),
    });
    await expect(runtime.submit("inspect the project")).rejects.toEqual(
      new RuntimeError(
        "provider_not_configured",
        "No model connection is ready. Run recurs setup in an interactive terminal, then try again.",
      ),
    );

    const files = await readdir(dataDirectory, { recursive: true }).catch(() => []);
    expect(files.filter((file) => file.endsWith(".jsonl"))).toEqual([]);
  });

  it("uses pinned version 2 sessions for an explicitly injected provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-pinned-assembly-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        provider: new ScriptedProvider([
          [
            { type: "text_delta", text: "done" },
            { type: "done", stopReason: "complete" },
          ],
        ]),
      },
    );

    expect(runtime.state).toMatchObject({
      type: "session",
      session: { version: 2, backend: { type: "pinned" } },
    });
    await runtime.submit("/goal inspect safely");
    await expect(runtime.submit("inspect")).resolves.toMatchObject({
      finalText: "done",
    });
    expect(runtime.session.version).toBe(2);
    expect(runtime.session.goal).toMatchObject({
      objective: "inspect safely",
      progress: "done",
    });
  });

  it("issues canonical authorizations accepted for reordered pinned data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-auth-assembly-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        provider: new ScriptedProvider([], "canonical-provider"),
      },
    );
    if (runtime.session.backend.type !== "pinned") {
      throw new Error("Expected a pinned test session");
    }
    const pin = runtime.session.backend.pin;
    const reorderedPin = Object.fromEntries(
      Object.entries(pin).reverse(),
    ) as unknown as SessionBackendPin;
    reorderedPin.billingSelectionAtCreation = Object.fromEntries(
      Object.entries(pin.billingSelectionAtCreation).reverse(),
    ) as unknown as SessionBackendPin["billingSelectionAtCreation"];
    const context: TrustedRunContext = {
      embedding: "cli",
      automation: "manual",
      location: "local",
      presence: "present",
      invocation: "repl",
    };
    const dependencies = Reflect.get(runtime, "dependencies") as {
      coordinator: { dependencies: { resolver: BackendResolver } };
    };
    const startedAt = new Date();
    const resolved = await dependencies.coordinator.dependencies.resolver.resolve({
      operation: "run",
      operationId: "operation-canonical",
      sessionId: runtime.session.id,
      turnId: "turn-canonical",
      pin,
      context,
      signal: new AbortController().signal,
    });

    expect(() => verifyRunAuthorization(resolved.authorization, {
      id: resolved.authorization.id,
      operation: "run",
      sessionId: runtime.session.id,
      operationId: "operation-canonical",
      turnId: "turn-canonical",
      pin: reorderedPin,
      connectionRevision: 1,
      policyRevision: pin.policyRevisionAtCreation,
      context,
      maxRequests: 40,
      expiresAt: resolved.authorization.expiresAt,
    }, startedAt)).not.toThrow();
  });

  it("composes a provider runtime with no model tools when tools are disabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-tools-disabled-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "done without tools" },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: path.join(root, "data"),
        provider,
        toolSecurityProfile: "tools_disabled",
      },
    );

    await expect(runtime.submit("inspect without tools")).resolves.toMatchObject({
      finalText: "done without tools",
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.tools).toEqual([]);
  });

  it("starts a new pinned session instead of rebinding history to another provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "recurs-provider-pin-"));
    directories.push(root);
    const workspace = path.join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const options = { cwd: workspace, dataDirectory: path.join(root, "data") };
    const first = await createStandaloneRuntime(
      { async emit() {} },
      { ...options, provider: new ScriptedProvider([], "provider-a") },
    );
    const second = await createStandaloneRuntime(
      { async emit() {} },
      { ...options, provider: new ScriptedProvider([], "provider-b") },
    );

    expect(second.session.id).not.toBe(first.session.id);
    expect(second.session.backend).toMatchObject({
      type: "pinned",
      pin: {
        providerId: "provider-b",
        connectionId: "injected:provider-b",
      },
    });
  });
});
