import { createHash } from "node:crypto";
import { access, chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
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

async function writeProjectConfiguration(
  workspace: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const config = path.join(workspace, ".recurs");
  await mkdir(config, { recursive: true });
  const file = path.join(config, "mcp-servers.json");
  await writeFile(file, JSON.stringify({
    version: 1,
    servers: [{
      id: "project-server",
      description: "Project-owned deterministic tools",
      command: process.execPath,
      args: [fixture],
      network: "deny",
      ...overrides,
    }],
  }), { mode: 0o644 });
  await chmod(file, 0o644);
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

async function lines(file: string): Promise<readonly string[]> {
  return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean);
}

afterEach(async () => {
  delete process.env.MCP_TEST_SECRET;
  await Promise.all(roots.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("McpServerCatalog", () => {
  it("keeps project servers disabled until exact digest-bound trust persists", async () => {
    const data = await root();
    const workspace = await root();
    const projectData = path.join(data, "project-data");
    await writeProjectConfiguration(workspace);

    const catalog = await McpServerCatalog.load({
      dataDirectory: data,
      workspace,
      projectDataDirectory: projectData,
    });
    expect(catalog.snapshot()).toMatchObject({
      projectTrust: "untrusted",
      servers: [{
        id: "project-server",
        source: "project",
        enabled: false,
      }],
    });
    expect(catalog.contextInstructions().join("\n")).not.toContain("project-server");
    const tool = catalog.createTool();
    expect(() => tool.execute(
      tool.parse({ server: "project-server", action: "list_tools" }),
      context(workspace),
    )).toThrow("untrusted");

    await catalog.trustProject();
    expect(catalog.snapshot()).toMatchObject({
      projectTrust: "trusted",
      servers: [{ enabled: true }],
    });
    expect(catalog.contextInstructions().join("\n")).toContain("project-server");
    expect(catalog.contextInstructions([])).toEqual([]);
    expect(catalog.contextInstructions(["project-server"]).join("\n"))
      .toContain("project-server");
    expect(tool.available?.({
      ...context(workspace),
      companyCapabilities: { agentSkillNames: [], mcpServerIds: [] },
    })).toBe(false);
    expect(() => tool.permissions(
      tool.parse({ server: "project-server", action: "list_tools" }),
      {
        ...context(workspace),
        companyCapabilities: { agentSkillNames: [], mcpServerIds: [] },
      },
    )).toThrow("not approved");
    await catalog.close();

    const restarted = await McpServerCatalog.load({
      dataDirectory: data,
      workspace,
      projectDataDirectory: projectData,
    });
    expect(restarted.snapshot().projectTrust).toBe("trusted");
    expect(restarted.snapshot().servers[0]?.enabled).toBe(true);
    await restarted.close();
  });

  it("invalidates persistent project trust when exact configuration bytes change", async () => {
    const data = await root();
    const workspace = await root();
    const projectData = path.join(data, "project-data");
    await writeProjectConfiguration(workspace);
    const loaded = await McpServerCatalog.load({
      dataDirectory: data,
      workspace,
      projectDataDirectory: projectData,
    });
    await writeProjectConfiguration(workspace, {
      description: "Changed before trust",
    });
    await expect(loaded.trustProject()).rejects.toThrow("changed");
    expect(loaded.snapshot().projectTrust).toBe("stale");
    await loaded.close();

    const catalog = await McpServerCatalog.load({
      dataDirectory: data,
      workspace,
      projectDataDirectory: projectData,
    });
    await catalog.trustProject();
    await writeProjectConfiguration(workspace, {
      description: "Changed after trust",
    });
    const tool = catalog.createTool();
    await expect(tool.preflight!(
      tool.parse({ server: "project-server", action: "list_tools" }),
      context(workspace),
    )).rejects.toThrow("changed");
    expect(catalog.snapshot().projectTrust).toBe("stale");
    await catalog.close();

    const changed = await McpServerCatalog.load({
      dataDirectory: data,
      workspace,
      projectDataDirectory: projectData,
    });
    expect(changed.snapshot()).toMatchObject({
      projectTrust: "stale",
      servers: [{ enabled: false }],
    });
    await changed.untrustProject();
    expect(changed.snapshot().projectTrust).toBe("untrusted");
    await changed.close();
  });

  it("revokes active and queued project operations before removing durable trust", async () => {
    const data = await root();
    const workspace = await root();
    const projectData = path.join(data, "project-data");
    const journal = path.join(data, "project-revocation.log");
    await writeProjectConfiguration(workspace, {
      args: [fixture, "hang-tool", journal],
    });
    const catalog = await McpServerCatalog.load({
      dataDirectory: data,
      workspace,
      projectDataDirectory: projectData,
    });
    await catalog.trustProject();
    const tool = catalog.createTool();
    const hanging = tool.execute(
      tool.parse({
        server: "project-server",
        action: "call_tool",
        tool: "hang",
      }),
      context(workspace),
    );
    await expect.poll(async () => (await lines(journal)).some((line) =>
      line.startsWith("started:")
    )).toBe(true);
    const pid = Number.parseInt(
      (await lines(journal)).find((line) => line.startsWith("init:"))!.slice(5),
      10,
    );
    const queued = tool.execute(
      tool.parse({ server: "project-server", action: "list_tools" }),
      context(workspace),
    );
    const hangingResult = expect(hanging).rejects.toMatchObject({ code: "cancelled" });
    const queuedResult = expect(queued).rejects.toThrow("untrusted");

    await catalog.untrustProject();
    await hangingResult;
    await queuedResult;
    expect(processExists(pid)).toBe(false);
    expect(catalog.snapshot()).toMatchObject({
      projectTrust: "untrusted",
      servers: [{ enabled: false, state: "idle" }],
    });
    await catalog.close();

    const restarted = await McpServerCatalog.load({
      dataDirectory: data,
      workspace,
      projectDataDirectory: projectData,
    });
    expect(restarted.snapshot().projectTrust).toBe("untrusted");
    await restarted.close();
  });

  it("fails project configuration closed without blocking safe user servers", async () => {
    const data = await root();
    const workspace = await root();
    const projectData = path.join(data, "project-data");
    await writeConfiguration(data);
    await writeProjectConfiguration(workspace, { id: "test-server" });
    const collision = await McpServerCatalog.load({
      dataDirectory: data,
      workspace,
      projectDataDirectory: projectData,
    });
    expect(collision.snapshot().projectTrust).toBe("invalid");
    expect(collision.snapshot().warnings.join("\n")).toContain("conflicts");
    expect(collision.snapshot().servers.find((server) => server.source === "user"))
      .toMatchObject({ enabled: true });
    expect(collision.snapshot().servers.find((server) => server.source === "project"))
      .toMatchObject({ enabled: false });
    await expect(collision.trustProject()).rejects.toThrow("not trustable");
    await collision.close();

    const unsafe = await root();
    await writeProjectConfiguration(unsafe);
    await chmod(path.join(unsafe, ".recurs", "mcp-servers.json"), 0o666);
    const malformed = await McpServerCatalog.load({
      dataDirectory: data,
      workspace: unsafe,
      projectDataDirectory: path.join(data, "unsafe-project"),
    });
    expect(malformed.snapshot().projectTrust).toBe("invalid");
    expect(malformed.snapshot().warnings).not.toHaveLength(0);
    await malformed.close();
  });

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
    const catalog = await McpServerCatalog.load(data);
    const tool = catalog.createTool();

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
    await catalog.close();
  });

  it("isolates host secrets and removes same-group descendants before returning", async () => {
    const data = await root();
    const workspace = await root();
    await writeConfiguration(data);
    process.env.MCP_TEST_SECRET = "must-not-cross-boundary";
    const catalog = await McpServerCatalog.load(data);
    const tool = catalog.createTool();

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
    expect(processExists(pid)).toBe(true);
    await catalog.close();
    expect(processExists(pid)).toBe(false);
  });

  it("reuses one healthy server and exposes negotiated connection state", async () => {
    const data = await root();
    const workspace = await root();
    const journal = path.join(data, "mcp-lifecycle.log");
    await writeConfiguration(data, { args: [fixture, "lifecycle", journal] });
    const catalog = await McpServerCatalog.load(data);
    const tool = catalog.createTool();

    await tool.execute(
      tool.parse({ server: "test-server", action: "list_tools" }),
      context(workspace),
    );
    const called = await tool.execute(
      tool.parse({
        server: "test-server",
        action: "call_tool",
        tool: "process_id",
      }),
      context(workspace),
    );
    const pid = Number.parseInt(JSON.parse(called.output).result.content[0].text, 10);

    expect(await lines(journal)).toEqual([`init:${pid}`]);
    expect(catalog.snapshot().servers[0]).toMatchObject({
      state: "connected",
      protocolVersion: "2025-11-25",
      serverName: "recurs-test-mcp",
      serverVersion: "1.0.0",
    });
    await expect(createMcpCommand(catalog).execute("", {} as never)).resolves
      .toMatchObject({
        text: expect.stringMatching(/test-server[\s\S]*connected[\s\S]*recurs-test-mcp@1\.0\.0/u),
      });
    expect(processExists(pid)).toBe(true);
    await catalog.close();
    expect(processExists(pid)).toBe(false);
    expect(await lines(journal)).toEqual([`init:${pid}`, `closed:${pid}`]);
    expect(catalog.snapshot().servers[0]).toMatchObject({ state: "idle" });
  });

  it("restarts after a failed reuse ping before issuing the next operation", async () => {
    const data = await root();
    const workspace = await root();
    const journal = path.join(data, "mcp-restart.log");
    const failed = path.join(data, "ping-failed");
    await writeConfiguration(data, {
      args: [fixture, "restart-on-ping", journal, failed],
    });
    const catalog = await McpServerCatalog.load(data);
    const tool = catalog.createTool();

    const first = await tool.execute(
      tool.parse({
        server: "test-server",
        action: "call_tool",
        tool: "process_id",
      }),
      context(workspace),
    );
    const second = await tool.execute(
      tool.parse({
        server: "test-server",
        action: "call_tool",
        tool: "process_id",
      }),
      context(workspace),
    );
    const firstPid = Number.parseInt(JSON.parse(first.output).result.content[0].text, 10);
    const secondPid = Number.parseInt(JSON.parse(second.output).result.content[0].text, 10);

    expect(secondPid).not.toBe(firstPid);
    expect(await lines(journal)).toEqual([`init:${firstPid}`, `init:${secondPid}`]);
    expect(processExists(firstPid)).toBe(false);
    await catalog.close();
    expect(processExists(secondPid)).toBe(false);
  });

  it("cancellation during a reuse health check invalidates the live server", async () => {
    const data = await root();
    const workspace = await root();
    const journal = path.join(data, "mcp-ping-cancel.log");
    await writeConfiguration(data, { args: [fixture, "hang-ping", journal] });
    const catalog = await McpServerCatalog.load(data);
    const tool = catalog.createTool();
    const first = await tool.execute(
      tool.parse({
        server: "test-server",
        action: "call_tool",
        tool: "process_id",
      }),
      context(workspace),
    );
    const pid = Number.parseInt(JSON.parse(first.output).result.content[0].text, 10);
    const controller = new AbortController();
    const reusing = tool.execute(
      tool.parse({ server: "test-server", action: "list_tools" }),
      context(workspace, controller.signal),
    );
    await expect.poll(async () => (await lines(journal)).some((line) =>
      line === `ping-started:${pid}`
    )).toBe(true);

    controller.abort();
    await expect(reusing).rejects.toMatchObject({ code: "cancelled" });
    expect(processExists(pid)).toBe(false);
    expect((await lines(journal)).some((line) => line.startsWith("cancelled:")))
      .toBe(true);
    expect(catalog.snapshot().servers[0]).toMatchObject({ state: "failed" });
    await catalog.close();
  });

  it("never retries an ambiguous tool call after the server exits", async () => {
    const data = await root();
    const workspace = await root();
    const journal = path.join(data, "mcp-ambiguous.log");
    await writeConfiguration(data, { args: [fixture, "exit-on-tool", journal] });
    const catalog = await McpServerCatalog.load(data);
    const tool = catalog.createTool();

    await expect(tool.execute(
      tool.parse({
        server: "test-server",
        action: "call_tool",
        tool: "echo",
        arguments: { value: "once" },
      }),
      context(workspace),
    )).rejects.toMatchObject({ code: "process_failed" });

    expect((await lines(journal)).filter((line) => line === "call:echo")).toHaveLength(1);
    expect(catalog.snapshot().servers[0]).toMatchObject({ state: "failed" });
    await catalog.close();
  });

  it("cleans the whole process group when a server exits after a result", async () => {
    const data = await root();
    const workspace = await root();
    const journal = path.join(data, "mcp-exit-after-result.log");
    await writeConfiguration(data, { args: [fixture, "exit-after-result", journal] });
    const catalog = await McpServerCatalog.load(data);
    const tool = catalog.createTool();
    const called = await tool.execute(
      tool.parse({
        server: "test-server",
        action: "call_tool",
        tool: "spawn_and_exit",
      }),
      context(workspace),
    );
    const descendant = Number.parseInt(
      JSON.parse(called.output).result.content[0].text,
      10,
    );

    await expect.poll(() => catalog.snapshot().servers[0]?.state).toBe("failed");
    await expect.poll(() => processExists(descendant)).toBe(false);
    await catalog.close();
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

  it("cancels startup and closes its process when the catalog closes", async () => {
    const data = await root();
    const workspace = await root();
    const marker = path.join(workspace, "initialized");
    await writeConfiguration(data, { args: [fixture, "hang", marker] });
    const catalog = await McpServerCatalog.load(data);
    const tool = catalog.createTool();
    const running = tool.execute(
      tool.parse({ server: "test-server", action: "list_tools" }),
      context(workspace),
    );
    await expect.poll(async () => access(marker).then(() => true, () => false))
      .toBe(true);
    const pid = Number((await readFile(marker, "utf8")).trim().split(":")[1]);

    await expect(catalog.close()).resolves.toBeUndefined();
    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    expect(processExists(pid)).toBe(false);
    expect(catalog.snapshot().servers[0]).toMatchObject({ state: "idle" });
    await expect(tool.execute(
      tool.parse({ server: "test-server", action: "list_tools" }),
      context(workspace),
    )).rejects.toMatchObject({ code: "tool_unavailable" });
  });

  it("cancels an in-flight request, closes its server, and restarts cleanly", async () => {
    const data = await root();
    const workspace = await root();
    const journal = path.join(data, "mcp-cancel.log");
    await writeConfiguration(data, { args: [fixture, "hang-tool", journal] });
    const catalog = await McpServerCatalog.load(data);
    const tool = catalog.createTool();
    const controller = new AbortController();
    const running = tool.execute(
      tool.parse({ server: "test-server", action: "call_tool", tool: "hang" }),
      context(workspace, controller.signal),
    );
    await expect.poll(async () =>
      access(journal).then(async () => (await lines(journal)).some((line) =>
        line.startsWith("started:")
      ), () => false)
    ).toBe(true);
    const firstPid = Number((await lines(journal)).find((line) =>
      line.startsWith("started:")
    )?.split(":")[1]);

    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "cancelled" });
    expect(processExists(firstPid)).toBe(false);
    expect((await lines(journal)).some((line) => line.startsWith("cancelled:")))
      .toBe(true);
    expect(catalog.snapshot().servers[0]).toMatchObject({ state: "failed" });

    const restarted = await tool.execute(
      tool.parse({ server: "test-server", action: "list_tools" }),
      context(workspace),
    );
    expect(JSON.parse(restarted.output).tools.map((item: { name: string }) => item.name))
      .toContain("hang");
    expect((await lines(journal)).filter((line) => line.startsWith("init:")))
      .toHaveLength(2);
    await catalog.close();
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
    await runtime.close();
  });

  it("gates project trust and exposes a trusted project server to the real loop", async () => {
    const data = await root();
    const workspace = await root();
    await writeProjectConfiguration(workspace);
    await writeFile(path.join(workspace, "README.md"), "# Project MCP fixture\n");
    await runProcess("git", ["init"], { cwd: workspace });
    await runProcess("git", ["add", "README.md", ".recurs/mcp-servers.json"], {
      cwd: workspace,
    });
    await runProcess("git", [
      "-c", "user.name=Recurs Test",
      "-c", "user.email=recurs@example.invalid",
      "commit", "-m", "initial",
    ], { cwd: workspace });
    const provider = new ScriptedProvider([
      [{
        type: "tool_call",
        call: {
          id: "project-mcp-list",
          name: "mcp",
          arguments: { server: "project-server", action: "list_tools" },
        },
      }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", text: "Project MCP tools inspected." },
        { type: "done", stopReason: "complete" }],
    ]);
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: data,
        provider,
        toolSecurityProfile: "local_guarded",
        skillHomeDirectory: path.join(data, "empty-home"),
      },
    );
    runtime.setConfirmHandler(async () => true);
    await expect(runtime.submit("/mcp trust-project")).resolves.toMatchObject({
      type: "message",
      level: "error",
    });
    const localUser = createHostInvocation({
      invocation: "repl",
      userPresent: true,
      remote: false,
      scripted: false,
      embedding: "cli",
    });
    await expect(runtime.submit("/mcp trust-project", localUser)).resolves
      .toMatchObject({
        type: "message",
        text: expect.stringContaining("trusted"),
      });
    await expect(runtime.submit("Inspect the project MCP tools", localUser)).resolves
      .toMatchObject({ finalText: "Project MCP tools inspected." });
    expect(provider.requests[0]?.messages[0]?.content).toContain("project-server");
    expect(JSON.stringify(provider.requests[1]?.messages)).toContain("inspect_environment");
    await runtime.close();

    const restarted = await McpServerCatalog.load({
      dataDirectory: data,
      workspace,
      projectDataDirectory: path.join(
        data,
        "projects",
        createHash("sha256").update(await realpath(workspace)).digest("hex").slice(0, 24),
      ),
    });
    expect(restarted.snapshot().projectTrust).toBe("trusted");
    await restarted.close();
  });
});
