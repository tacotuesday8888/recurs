import { access, chmod, link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PermissionEngine, ToolRegistry, runProcess, type ToolContext } from "@recurs/tools";
import { createHostInvocation } from "@recurs/contracts";
import { ScriptedProvider } from "@recurs/providers";
import type { RecursEvent } from "@recurs/core";
import { afterEach, describe, expect, it } from "vitest";

import { McpServerCatalog } from "../src/mcp-client.js";
import { createMcpCommand } from "../src/commands/mcp.js";
import { createStandaloneRuntime } from "../src/assembly.js";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-mcp-server.mjs", import.meta.url),
);
const roots: string[] = [];

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-mcp-"));
  roots.push(directory);
  return directory;
}

async function writeConfiguration(
  directory: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const config = path.join(directory, "config");
  await mkdir(config, { recursive: true, mode: 0o700 });
  const file = path.join(config, "mcp-servers.json");
  await writeFile(file, JSON.stringify({
    version: 1,
    servers: [{
      id: "test-server",
      description: "Deterministic test tools",
      command: process.execPath,
      args: [fixture],
      network: "deny",
      ...overrides,
    }],
  }), { mode: 0o600 });
  await chmod(file, 0o600);
}

function context(
  cwd: string,
  signal = new AbortController().signal,
  executionMode: "act" | "plan" = "act",
): ToolContext {
  return {
    sessionId: "mcp-session",
    cwd,
    signal,
    executionMode,
    readRevisions: new Map(),
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null &&
      "code" in error && error.code === "ESRCH");
  }
}

afterEach(async () => {
  delete process.env.MCP_TEST_SECRET;
  await Promise.all(roots.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("McpServerCatalog", () => {
  it("loads private user configuration and renders it without starting a server", async () => {
    const data = await root();
    await writeConfiguration(data);
    const catalog = await McpServerCatalog.load(data);

    expect(catalog.snapshot()).toMatchObject({
      servers: [{
        id: "test-server",
        description: "Deterministic test tools",
        network: "deny",
      }],
    });
    const command = createMcpCommand(catalog);
    const rendered = await command.execute("", {} as never);
    expect(rendered).toMatchObject({
      type: "message",
      text: expect.stringContaining("test-server"),
    });
  });

  it("fails closed for unsafe permissions and malformed server definitions", async () => {
    const insecure = await root();
    await writeConfiguration(insecure);
    await chmod(path.join(insecure, "config", "mcp-servers.json"), 0o644);
    await expect(McpServerCatalog.load(insecure)).rejects.toThrow("private");

    const malformed = await root();
    await writeConfiguration(malformed, { command: "node" });
    await expect(McpServerCatalog.load(malformed)).rejects.toThrow("absolute");

    const hardLinked = await root();
    await writeConfiguration(hardLinked);
    await link(
      path.join(hardLinked, "config", "mcp-servers.json"),
      path.join(hardLinked, "config", "alias.json"),
    );
    await expect(McpServerCatalog.load(hardLinked)).rejects.toThrow("single-link");

    const symbolic = await root();
    await writeConfiguration(symbolic);
    const config = path.join(symbolic, "config", "mcp-servers.json");
    const target = path.join(symbolic, "config", "target.json");
    await rename(config, target);
    await symlink(target, config);
    await expect(McpServerCatalog.load(symbolic)).rejects.toThrow("regular file");
  });

  it("negotiates, paginates tool discovery, and calls a tool", async () => {
    const data = await root();
    const workspace = await root();
    await writeConfiguration(data);
    const tool = (await McpServerCatalog.load(data)).createTool();

    const listed = await tool.execute(
      tool.parse({ server: "test-server", action: "list_tools" }),
      context(workspace),
    );
    expect(JSON.parse(listed.output).tools.map((item: { name: string }) => item.name))
      .toEqual(["echo", "inspect_environment", "spawn_descendant"]);

    const called = await tool.execute(
      tool.parse({
        server: "test-server",
        action: "call_tool",
        tool: "echo",
        arguments: { value: "hello" },
      }),
      context(workspace),
    );
    expect(JSON.parse(called.output)).toMatchObject({
      server: "test-server",
      result: { content: [{ type: "text", text: "hello" }] },
    });
    await expect(tool.execute(
      tool.parse({
        server: "test-server",
        action: "call_tool",
        tool: "missing_tool",
      }),
      context(workspace),
    )).rejects.toMatchObject({
      code: "execution_failed",
      message: "MCP server error: Unknown test tool",
    });
  });

  it("isolates host secrets and removes same-group descendants before returning", async () => {
    const data = await root();
    const workspace = await root();
    await writeConfiguration(data);
    process.env.MCP_TEST_SECRET = "must-not-cross-boundary";
    const tool = (await McpServerCatalog.load(data)).createTool();

    const inspected = await tool.execute(
      tool.parse({
        server: "test-server",
        action: "call_tool",
        tool: "inspect_environment",
      }),
      context(workspace),
    );
    const inspection = JSON.parse(
      JSON.parse(inspected.output).result.content[0].text,
    );
    expect(inspection).toMatchObject({ secret: null, cwd: await realpath(workspace) });
    expect(inspection.home).not.toBe(process.env.HOME);

    const spawned = await tool.execute(
      tool.parse({
        server: "test-server",
        action: "call_tool",
        tool: "spawn_descendant",
      }),
      context(workspace),
    );
    const pid = Number.parseInt(JSON.parse(spawned.output).result.content[0].text, 10);
    expect(pid).toBeGreaterThan(0);
    expect(processExists(pid)).toBe(false);
  });

  it("uses the existing permission and Plan-mode boundaries", async () => {
    const data = await root();
    const workspace = await root();
    await writeConfiguration(data);
    const tool = (await McpServerCatalog.load(data)).createTool();
    const registry = new ToolRegistry([tool]);
    const call = {
      id: "mcp-call",
      name: "mcp",
      arguments: { server: "test-server", action: "list_tools" },
    };

    await expect(registry.invoke(
      call,
      context(workspace),
      new PermissionEngine("ask_always"),
      { async request() { return "deny"; } },
    )).rejects.toMatchObject({ code: "permission_denied" });
    await expect(registry.invoke(
      call,
      context(workspace, new AbortController().signal, "plan"),
      new PermissionEngine("full_access"),
      { async request() { return "deny"; } },
    )).rejects.toMatchObject({ code: "plan_mode_denied" });

    const networkData = await root();
    await writeConfiguration(networkData, { network: "allow" });
    const networkTool = (await McpServerCatalog.load(networkData)).createTool();
    expect(networkTool.permissions(
      networkTool.parse({ server: "test-server", action: "list_tools" }),
      context(workspace),
    ).map((intent) => intent.category)).toEqual(["shell", "network"]);
  });

  it("propagates cancellation and protocol output limits", async () => {
    const workspace = await root();
    const hangingData = await root();
    const marker = path.join(workspace, "initialized");
    await writeConfiguration(hangingData, { args: [fixture, "hang", marker] });
    const hanging = (await McpServerCatalog.load(hangingData)).createTool();
    const controller = new AbortController();
    const running = hanging.execute(
      hanging.parse({ server: "test-server", action: "list_tools" }),
      context(workspace, controller.signal),
    );
    await expect.poll(async () => access(marker).then(() => true, () => false)).toBe(true);
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "cancelled" });

    const oversizedData = await root();
    await writeConfiguration(oversizedData, { args: [fixture, "oversized"] });
    const oversized = (await McpServerCatalog.load(oversizedData)).createTool();
    await expect(oversized.execute(
      oversized.parse({ server: "test-server", action: "list_tools" }),
      context(workspace),
    )).rejects.toMatchObject({ code: "output_limit" });
  });

  it("runs through the real parent loop with normalized tool events", async () => {
    const data = await root();
    const workspace = await root();
    await writeConfiguration(data);
    await writeFile(path.join(workspace, "README.md"), "# MCP fixture\n");
    await runProcess("git", ["init"], { cwd: workspace });
    await runProcess("git", ["add", "README.md"], { cwd: workspace });
    await runProcess("git", [
      "-c", "user.name=Recurs Test",
      "-c", "user.email=recurs@example.invalid",
      "commit", "-m", "initial",
    ], { cwd: workspace });
    const provider = new ScriptedProvider([
      [{
        type: "tool_call",
        call: {
          id: "mcp-list",
          name: "mcp",
          arguments: { server: "test-server", action: "list_tools" },
        },
      }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", text: "MCP tools inspected." },
        { type: "done", stopReason: "complete" }],
    ]);
    const events: RecursEvent[] = [];
    const runtime = await createStandaloneRuntime(
      { async emit(event) { events.push(event); } },
      { cwd: workspace, dataDirectory: data, provider },
    );
    runtime.setConfirmHandler(async () => true);

    await expect(runtime.submit(
      "Inspect the configured MCP tools",
      createHostInvocation({
        invocation: "repl",
        userPresent: true,
        remote: false,
        scripted: false,
        embedding: "cli",
      }),
    )).resolves.toMatchObject({ finalText: "MCP tools inspected." });

    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toContain("mcp");
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain("inspect_environment");
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_started",
      call: expect.objectContaining({ id: "mcp-list", name: "mcp" }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_completed",
      callId: "mcp-list",
    }));
  });
});
