import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ScriptedProvider } from "@recurs/providers";
import { afterEach, describe, expect, it } from "vitest";

import {
  RuntimeError,
  createStandaloneRuntime,
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
