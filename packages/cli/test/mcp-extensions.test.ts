import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostInvocation } from "@recurs/contracts";
import { mcpDestination } from "../src/mcp-http.js";
import { McpServerCatalog } from "../src/mcp-client.js";
import { createMcpCommand } from "../src/commands/mcp.js";
import type { CommandContext } from "../src/commands/types.js";

const roots: string[] = [];
const servers: Server[] = [];
const catalogs: McpServerCatalog[] = [];
afterEach(async () => {
  await Promise.all(catalogs.splice(0).map((catalog) => catalog.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporary() {
  const root = await mkdtemp(path.join(tmpdir(), "recurs-mcp-extensions-"));
  roots.push(root);
  return root;
}
async function catalog(root: string) {
  const value = await McpServerCatalog.load(root);
  catalogs.push(value);
  return value;
}
function toolContext(cwd: string, signal = new AbortController().signal) {
  return { cwd, sessionId: "extension-test", signal, executionMode: "act" as const, readRevisions: new Map<string, string>() };
}
function commandContext(cwd: string): CommandContext {
  return {
    invocation: createHostInvocation({ invocation: "repl", userPresent: true, remote: false, scripted: false, embedding: "cli" }),
    session: { cwd, id: "extension-test", executionMode: "act", permissionMode: "ask_always" },
    async confirm() { return true; },
  } as unknown as CommandContext;
}

async function httpFixture(options: { modern?: boolean; authenticated?: boolean; resourcesOnly?: boolean; delayToken?: boolean } = {}) {
  const requests: { method: string; authorization?: string; version?: string }[] = [];
  const grants: URLSearchParams[] = [];
  let origin = "";
  let challenge = "";
  let currentToken = "fixture-access";
  let calls = 0;
  let closedStreams = 0;
  let releaseToken: (() => void) | undefined;
  let delayRefresh = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    const send = (value: unknown, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      send({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["tools"] }); return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      send({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] }); return;
    }
    if (url.pathname === "/authorize") {
      challenge = url.searchParams.get("code_challenge")!;
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "fixture-code");
      callback.searchParams.set("state", url.searchParams.get("state")!);
      callback.searchParams.set("iss", origin);
      response.writeHead(302, { Location: callback.href }).end(); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    if (url.pathname === "/register") { send({ ...JSON.parse(body), client_id: "fixture-client" }, 201); return; }
    if (url.pathname === "/token") {
      const grant = new URLSearchParams(body);
      grants.push(grant);
      if (grant.get("grant_type") === "authorization_code") {
        const actual = createHash("sha256").update(grant.get("code_verifier")!).digest("base64url");
        if (actual !== challenge) { send({ error: "invalid_grant" }, 400); return; }
      }
      if (options.delayToken || (delayRefresh && grant.get("grant_type") === "refresh_token")) await new Promise<void>((resolve) => { releaseToken = resolve; });
      send({ access_token: currentToken, refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600, scope: "tools" }); return;
    }
    if (url.pathname !== "/mcp") { response.writeHead(404).end(); return; }
    if (options.authenticated && request.headers.authorization !== `Bearer ${currentToken}`) {
      response.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end(); return;
    }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const message = JSON.parse(body);
    requests.push({ method: message.method, ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}), ...(request.headers["mcp-protocol-version"] ? { version: String(request.headers["mcp-protocol-version"]) } : {}) });
    const capabilities = options.resourcesOnly ? { resources: {} } : { tools: {}, resources: {}, prompts: {} };
    const result = (value: unknown) => send({ jsonrpc: "2.0", id: message.id, result: options.modern ? { ...(value as object), resultType: "complete", ttlMs: 0, cacheScope: "private" } : value });
    if (message.method === "server/discover") {
      if (options.modern) result({ supportedVersions: ["2026-07-28"], capabilities, _meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture-http", version: "1.0" } } });
      else send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }, 400);
    } else if (message.method === "initialize") result({ protocolVersion: "2025-11-25", capabilities, serverInfo: { name: "fixture-http", version: "1.0" } });
    else if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") response.writeHead(202).end();
    else if (message.method === "ping") result({});
    else if (message.method === "tools/list") result({ tools: [{ name: "echo", description: "First line\nSecond line", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
    else if (message.method === "resources/list") result({ resources: [{ uri: "test://readme", name: "Readme", mimeType: "text/plain" }] });
    else if (message.method === "resources/templates/list") result({ resourceTemplates: [{ uriTemplate: "test://file/{name}", name: "Files" }] });
    else if (message.method === "resources/read") result({ contents: [{ uri: message.params.uri, text: "resource content" }] });
    else if (message.method === "prompts/list") result({ prompts: [{ name: "review", description: "Review source", arguments: [{ name: "file", required: true }] }] });
    else if (message.method === "prompts/get") result({ messages: [{ role: "user", content: { type: "text", text: `Review ${message.params.arguments.file}` } }] });
    else if (message.method === "tools/call") {
      calls++;
      if (message.params.arguments.text === "hang") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(": waiting\n\n");
        response.on("close", () => { closedStreams++; });
      } else if (message.params.arguments.text === "disconnect") request.socket.destroy();
      else result({ content: [{ type: "text", text: message.params.arguments.text }] });
    } else send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, requests, grants, get calls() { return calls; }, get closedStreams() { return closedStreams; }, expire() { currentToken = "fixture-refreshed"; }, releaseToken() { releaseToken?.(); }, delayRefresh() { delayRefresh = true; } };
}

describe("MCP extension lifecycle", () => {
  it("prevents remote metadata from reaching private or loopback services", async () => {
    const endpoint = new URL("https://example.com/mcp");
    for (const target of ["http://127.0.0.1/token", "https://127.0.0.1/token", "https://169.254.169.254/latest/meta-data", "https://[::1]/token"]) {
      await expect(mcpDestination(endpoint, new URL(target))).rejects.toBeDefined();
    }
    await expect(mcpDestination(new URL("http://127.0.0.1:1234/mcp"), new URL("http://127.0.0.1:9999/token"))).rejects.toBeDefined();
    expect(await mcpDestination(new URL("http://127.0.0.1:1234/mcp"), new URL("http://127.0.0.1:1234/token"))).toEqual([{ address: "127.0.0.1", family: 4 }]);
  });

  it("adds, configures, disables, enables, inspects, and removes without starting processes", async () => {
    const root = await temporary();
    const manager = await catalog(root);
    const command = createMcpCommand(manager);
    const context = commandContext(root);
    const definition = { id: "local", description: "Two  spaces", command: "/bin/echo", args: ["two  spaces"] };
    await expect(command.execute(`add user ${JSON.stringify(definition)}`, context)).resolves.toMatchObject({ level: "info" });
    expect(manager.snapshot().servers[0]).toMatchObject({ description: "Two  spaces", args: ["two  spaces"], enabled: true });
    expect(manager.createTool().available?.(toolContext(root))).toBe(true);
    await manager.setEnabled("user", "local", false);
    expect(manager.createTool().available?.(toolContext(root))).toBe(false);
    expect((await catalog(root)).snapshot().servers[0]?.enabled).toBe(false);
    await manager.setEnabled("user", "local", true);
    await manager.configure("user", { ...definition, description: "Changed" }, true);
    expect(manager.snapshot().servers[0]?.description).toBe("Changed");
    await manager.remove("user", "local");
    expect(manager.snapshot().servers).toEqual([]);
  });

  it("requires project trust again after a managed configuration edit", async () => {
    const root = await temporary();
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const manager = await McpServerCatalog.load({ dataDirectory: root, workspace, projectDataDirectory: path.join(root, "project-data") });
    catalogs.push(manager);
    await manager.configure("project", { id: "local", description: "Test", command: "/bin/echo" });
    expect(manager.snapshot().projectTrust).toBe("untrusted");
    await manager.trustProject();
    await manager.setEnabled("project", "local", false);
    expect(manager.snapshot().projectTrust).toBe("stale");
    expect(manager.snapshot().servers[0]?.enabled).toBe(false);
  });

  it.each([false, true])("discovers and uses tools, resources, templates, and prompts over HTTP (modern=%s)", async (modern) => {
    const fixture = await httpFixture({ modern });
    const root = await temporary();
    const manager = await catalog(root);
    await manager.configure("user", { id: "http", description: "Fixture", transport: "http", url: `${fixture.origin}/mcp` });
    const tool = manager.createTool();
    const execute = (input: Record<string, unknown>) => tool.execute(tool.parse({ server: "http", ...input }), toolContext(root));
    expect((await execute({ action: "list_tools" })).output).toContain("Second line");
    expect((await execute({ action: "call_tool", tool: "echo", arguments: { text: "hello" } })).output).toContain("hello");
    expect((await execute({ action: "list_resources" })).output).toContain("test://readme");
    expect((await execute({ action: "list_resource_templates" })).output).toContain("uriTemplate");
    expect((await execute({ action: "read_resource", uri: "test://readme" })).output).toContain("resource content");
    expect((await execute({ action: "list_prompts" })).output).toContain("review");
    expect((await execute({ action: "get_prompt", prompt: "review", arguments: { file: "main.ts" } })).output).toContain("Review main.ts");
    expect(manager.snapshot().servers[0]?.protocolVersion).toBe(modern ? "2026-07-28" : "2025-11-25");
    if (modern) expect(fixture.requests.every((request) => request.version === "2026-07-28")).toBe(true);
  });

  it("accepts resource-only servers, enforces role/network access, and rejects insecure URLs", async () => {
    const fixture = await httpFixture({ resourcesOnly: true });
    const root = await temporary();
    const manager = await catalog(root);
    await manager.configure("user", { id: "http", description: "Resources", transport: "http", url: `${fixture.origin}/mcp` });
    const tool = manager.createTool();
    const input = tool.parse({ server: "http", action: "list_resources" });
    await expect(tool.execute(input, { ...toolContext(root), processSandbox: { mode: "workspace", network: "deny" } })).rejects.toMatchObject({ code: "permission_denied" });
    expect(() => tool.execute(input, { ...toolContext(root), companyCapabilities: { mcpServerIds: [], agentSkillNames: [] } })).toThrow("not approved");
    expect((await tool.execute(input, toolContext(root))).output).toContain("Readme");
    await expect(tool.execute(tool.parse({ server: "http", action: "list_tools" }), toolContext(root))).rejects.toMatchObject({ code: "tool_unavailable" });
    await expect(manager.configure("user", { id: "bad", description: "Bad", transport: "http", url: "http://example.com/mcp" })).rejects.toThrow("HTTPS");
  });

  it("cancels an HTTP response stream and never replays an ambiguous tool call", async () => {
    const fixture = await httpFixture({ modern: true });
    const root = await temporary();
    const manager = await catalog(root);
    await manager.configure("user", { id: "http", description: "Fixture", transport: "http", url: `${fixture.origin}/mcp` });
    const tool = manager.createTool();
    const abort = new AbortController();
    const hanging = tool.execute(tool.parse({ server: "http", action: "call_tool", tool: "echo", arguments: { text: "hang" } }), toolContext(root, abort.signal));
    const rejected = expect(hanging).rejects.toMatchObject({ code: "cancelled" });
    await expect.poll(() => fixture.calls).toBe(1);
    abort.abort();
    await rejected;
    await expect.poll(() => fixture.closedStreams).toBe(1);
    await expect(tool.execute(tool.parse({ server: "http", action: "call_tool", tool: "echo", arguments: { text: "disconnect" } }), toolContext(root))).rejects.toMatchObject({ code: "process_failed" });
    expect(fixture.calls).toBe(2);
  });

  it("revoking project trust cancels the pending OAuth callback", async () => {
    const fixture = await httpFixture({ authenticated: true });
    const root = await temporary();
    const workspace = path.join(root, "workspace");
    await mkdir(workspace);
    const manager = await McpServerCatalog.load({ dataDirectory: root, workspace, projectDataDirectory: path.join(root, "project-data") });
    catalogs.push(manager);
    await manager.configure("project", { id: "project-http", description: "Protected", transport: "http", url: `${fixture.origin}/mcp` });
    await manager.trustProject();
    await manager.authenticate("project-http");
    await manager.untrustProject();
    expect(await manager.waitAuthentication("project-http")).toBe("cancelled");
    expect(manager.snapshot().projectTrust).toBe("untrusted");
  });

  it("cancels an in-flight token exchange without persisting late credentials", async () => {
    const fixture = await httpFixture({ authenticated: true, delayToken: true });
    const root = await temporary();
    const manager = await catalog(root);
    await manager.configure("user", { id: "http", description: "Protected", transport: "http", url: `${fixture.origin}/mcp` });
    const authorization = await manager.authenticate("http");
    const redirect = await fetch(authorization.url, { redirect: "manual" });
    const callback = fetch(redirect.headers.get("location")!).catch(() => undefined);
    await expect.poll(() => fixture.grants.length).toBe(1);
    const abort = new AbortController();
    const waiting = manager.waitAuthentication("http", abort.signal);
    abort.abort();
    expect(await waiting).toBe("cancelled");
    fixture.releaseToken();
    await callback;
    const files = await readdir(path.join(root, "auth", "mcp"));
    const credentials = await readFile(path.join(root, "auth", "mcp", files[0]!, "credentials"), "utf8");
    expect(credentials).not.toContain("fixture-access");
    expect(manager.snapshot().servers[0]?.authentication).toBe("cancelled");
  });

  it("logout aborts background refresh before clearing credentials", async () => {
    const fixture = await httpFixture({ authenticated: true });
    const root = await temporary();
    const manager = await catalog(root);
    await manager.configure("user", { id: "http", description: "Protected", transport: "http", url: `${fixture.origin}/mcp` });
    const authorization = await manager.authenticate("http");
    const redirect = await fetch(authorization.url, { redirect: "manual" });
    await fetch(redirect.headers.get("location")!);
    expect(await manager.waitAuthentication("http")).toBe("authenticated");
    const tool = manager.createTool();
    const input = tool.parse({ server: "http", action: "list_tools" });
    await tool.execute(input, toolContext(root));
    fixture.expire();
    fixture.delayRefresh();
    const refreshing = tool.execute(input, toolContext(root));
    const rejected = expect(refreshing).rejects.toMatchObject({ code: "cancelled" });
    await expect.poll(() => fixture.grants.length).toBe(2);
    await manager.logout("http");
    fixture.releaseToken();
    await rejected;
    const files = await readdir(path.join(root, "auth", "mcp"));
    const credentials = await readFile(path.join(root, "auth", "mcp", files[0]!, "credentials"), "utf8");
    expect(credentials).not.toContain("fixture-refresh");
    expect(credentials).not.toContain("fixture-access");
  });

  it("authenticates using PKCE, persists privately, refreshes after expiry, and logs out", async () => {
    const fixture = await httpFixture({ authenticated: true });
    const root = await temporary();
    let manager = await catalog(root);
    await manager.configure("user", { id: "http", description: "Protected", transport: "http", url: `${fixture.origin}/mcp` });
    const authorization = await manager.authenticate("http");
    expect(authorization.url).toContain("code_challenge_method=S256");
    const redirect = await fetch(authorization.url, { redirect: "manual" });
    const callback = redirect.headers.get("location")!;
    const invalid = new URL(callback);
    invalid.searchParams.set("state", "wrong");
    expect((await fetch(invalid)).status).toBe(400);
    expect((await fetch(callback)).status).toBe(200);
    expect(await manager.waitAuthentication("http")).toBe("authenticated");
    expect(fixture.grants[0]?.get("resource")).toBe(`${fixture.origin}/mcp`);
    expect(fixture.grants[0]?.get("code_verifier")).toBeTruthy();
    const files = await readdir(path.join(root, "auth", "mcp"));
    const credentials = path.join(root, "auth", "mcp", files[0]!, "credentials");
    expect(await readFile(credentials, "utf8")).toContain("fixture-access");
    expect(JSON.stringify(manager.snapshot())).not.toContain("fixture-access");
    await manager.close();
    manager = await catalog(root);
    const tool = manager.createTool();
    const input = tool.parse({ server: "http", action: "list_tools" });
    expect((await tool.execute(input, toolContext(root))).output).toContain("echo");
    fixture.expire();
    expect((await tool.execute(input, toolContext(root))).output).toContain("echo");
    expect(fixture.grants.some((grant) => grant.get("grant_type") === "refresh_token")).toBe(true);
    await manager.logout("http");
    expect(await readFile(credentials, "utf8")).not.toContain("fixture-refresh");
    await chmod(credentials, 0o644);
    await expect(manager.authenticate("http")).rejects.toThrow("safely");
  });
});
