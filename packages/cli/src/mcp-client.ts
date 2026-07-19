import { constants } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import {
  startProcessSession,
  ToolError,
  type ProcessSession,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@recurs/tools";

const CONFIG_VERSION = 1;
const CONFIG_FILE = "mcp-servers.json";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_SERVERS = 32;
const MAX_ARGS = 32;
const MAX_ARGUMENT_BYTES = 4 * 1024;
const MAX_DESCRIPTION_LENGTH = 256;
const MAX_PROTOCOL_OUTPUT_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_TOOLS = 128;
const MAX_LIST_PAGES = 8;
const OPERATION_TIMEOUT_MS = 30_000;
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
]);
const SERVER_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const TOOL_NAME = /^[A-Za-z0-9._-]{1,128}$/u;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

export interface McpServerConfiguration {
  readonly id: string;
  readonly description: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly network: "allow" | "deny";
}

export interface McpCatalogSnapshot {
  readonly configPath: string;
  readonly servers: readonly McpServerConfiguration[];
}

interface McpToolInput {
  readonly server: string;
  readonly action: "list_tools" | "call_tool";
  readonly tool?: string;
  readonly arguments?: Record<string, unknown>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function errorCode(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value &&
    value.code === code;
}

function configurationMessage(error: unknown): string {
  if (error instanceof Error &&
      (error.message.startsWith("MCP ") || error.message.startsWith("each MCP "))) {
    return error.message;
  }
  return "MCP configuration could not be read safely";
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function safeText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maximum && !UNSAFE_TEXT.test(value);
}

function safeArgument(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ARGUMENT_BYTES &&
    !UNSAFE_TEXT.test(value) && Buffer.byteLength(value, "utf8") <= MAX_ARGUMENT_BYTES;
}

function jsonBytes(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ToolError("invalid_input", "MCP input must be JSON-serializable");
  }
  if (serialized === undefined) {
    throw new ToolError("invalid_input", "MCP input must be JSON-serializable");
  }
  return Buffer.byteLength(serialized, "utf8");
}

function parseServer(value: unknown): McpServerConfiguration {
  if (!plainObject(value) ||
      !exactKeys(value, ["id", "description", "command"], ["args", "network"])) {
    throw new Error("each MCP server must use the documented fields");
  }
  if (typeof value.id !== "string" || !SERVER_ID.test(value.id)) {
    throw new Error("MCP server ids must be lowercase stable identifiers");
  }
  if (!safeText(value.description, MAX_DESCRIPTION_LENGTH)) {
    throw new Error("MCP server descriptions must be bounded safe text");
  }
  if (!safeText(value.command, 4_096) || !path.isAbsolute(value.command)) {
    throw new Error("MCP server commands must be bounded absolute paths");
  }
  const args = value.args ?? [];
  if (!Array.isArray(args) || args.length > MAX_ARGS ||
      args.some((argument) => !safeArgument(argument))) {
    throw new Error(`MCP server args must contain at most ${MAX_ARGS} bounded strings`);
  }
  const network = value.network ?? "deny";
  if (network !== "allow" && network !== "deny") {
    throw new Error("MCP server network must be allow or deny");
  }
  return Object.freeze({
    id: value.id,
    description: value.description,
    command: value.command,
    args: Object.freeze([...args] as string[]),
    network,
  });
}

function parseConfiguration(value: unknown): readonly McpServerConfiguration[] {
  if (!plainObject(value) || !exactKeys(value, ["version", "servers"]) ||
      value.version !== CONFIG_VERSION || !Array.isArray(value.servers) ||
      value.servers.length > MAX_SERVERS) {
    throw new Error(`MCP configuration must be version ${CONFIG_VERSION} with at most ${MAX_SERVERS} servers`);
  }
  const servers = value.servers.map(parseServer);
  if (new Set(servers.map((server) => server.id)).size !== servers.length) {
    throw new Error("MCP server ids must be unique");
  }
  return Object.freeze(servers);
}

function sameFile(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readPrivateConfiguration(
  dataDirectory: string,
): Promise<unknown | null> {
  const configPath = path.join(dataDirectory, "config", CONFIG_FILE);
  let before;
  try {
    before = await lstat(configPath, { bigint: true });
  } catch (error) {
    if (errorCode(error, "ENOENT")) return null;
    throw new Error("MCP configuration could not be inspected", { cause: error });
  }
  const uid = process.getuid?.();
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.size <= 0n || before.size > BigInt(MAX_CONFIG_BYTES) ||
      (uid !== undefined && before.uid !== BigInt(uid)) ||
      (before.mode & 0o077n) !== 0n) {
    throw new Error("MCP configuration must be a private, owned, single-link regular file");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(configPath, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFile(before, opened)) {
      throw new Error("MCP configuration changed while it was opened");
    }
    const bytes = await handle.readFile();
    if (bytes.length === 0 || bytes.length > MAX_CONFIG_BYTES || bytes.includes(0)) {
      throw new Error("MCP configuration is empty, oversized, or not UTF-8 JSON");
    }
    const after = await lstat(configPath, { bigint: true });
    if (!sameFile(opened, after) || after.nlink !== 1n || after.size !== opened.size) {
      throw new Error("MCP configuration changed while it was read");
    }
    const canonicalRoot = await realpath(dataDirectory);
    const canonicalFile = await realpath(configPath);
    const relative = path.relative(canonicalRoot, canonicalFile);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new Error("MCP configuration escapes the Recurs data directory");
    }
    try {
      return JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new Error("MCP configuration is not valid JSON", { cause: error });
    }
  } finally {
    await handle.close();
  }
}

function parseToolInput(value: unknown): McpToolInput {
  if (!plainObject(value) ||
      !exactKeys(value, ["server", "action"], ["tool", "arguments"]) ||
      typeof value.server !== "string" ||
      (value.action !== "list_tools" && value.action !== "call_tool")) {
    throw new ToolError("invalid_input", "mcp requires a server and action");
  }
  if (value.action === "list_tools") {
    if (value.tool !== undefined || value.arguments !== undefined) {
      throw new ToolError("invalid_input", "list_tools does not accept tool arguments");
    }
    return { server: value.server, action: value.action };
  }
  if (typeof value.tool !== "string" || !TOOL_NAME.test(value.tool)) {
    throw new ToolError("invalid_input", "call_tool requires a valid tool name");
  }
  if (value.arguments !== undefined && !plainObject(value.arguments)) {
    throw new ToolError("invalid_input", "MCP tool arguments must be a JSON object");
  }
  if (jsonBytes(value.arguments ?? {}) > MAX_RESULT_BYTES) {
    throw new ToolError("invalid_input", "MCP tool arguments are too large");
  }
  return {
    server: value.server,
    action: value.action,
    tool: value.tool,
    arguments: value.arguments ?? {},
  };
}

class McpStdioClient {
  readonly #pending = new Map<number, PendingRequest>();
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #protocolVersion: string | undefined;
  #failure: ToolError | undefined;

  constructor(private readonly process: ProcessSession) {
    process.stdout.on("data", (chunk: Buffer) => this.#accept(chunk));
    void process.completion.then(
      (code) => this.#failPending(new ToolError(
        "process_failed",
        `MCP server exited with ${code}`,
      )),
      (error: unknown) => this.#failPending(
        error instanceof ToolError
          ? error
          : new ToolError("process_failed", "MCP server process failed"),
      ),
    );
  }

  async initialize(): Promise<void> {
    const result = await this.request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "recurs", version: "0.0.0" },
    });
    if (!plainObject(result) || typeof result.protocolVersion !== "string" ||
        !SUPPORTED_PROTOCOL_VERSIONS.has(result.protocolVersion) ||
        !plainObject(result.capabilities) || !plainObject(result.capabilities.tools) ||
        !plainObject(result.serverInfo) ||
        !safeText(result.serverInfo.name, 256) ||
        !safeText(result.serverInfo.version, 256)) {
      throw new ToolError("process_failed", "MCP server returned an invalid initialize result");
    }
    this.#protocolVersion = result.protocolVersion;
    await this.notify("notifications/initialized");
  }

  async listTools(): Promise<readonly Record<string, unknown>[]> {
    this.#assertInitialized();
    const tools: Record<string, unknown>[] = [];
    const names = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await this.request(
        "tools/list",
        cursor === undefined ? {} : { cursor },
      );
      if (!plainObject(result) || !Array.isArray(result.tools)) {
        throw new ToolError("process_failed", "MCP server returned an invalid tools list");
      }
      for (const candidate of result.tools) {
        if (!plainObject(candidate) || !TOOL_NAME.test(String(candidate.name ?? "")) ||
            !plainObject(candidate.inputSchema) ||
            (candidate.description !== undefined &&
              (typeof candidate.description !== "string" ||
                candidate.description.length > 8_192 ||
                UNSAFE_TEXT.test(candidate.description)))) {
          throw new ToolError("process_failed", "MCP server returned invalid tool metadata");
        }
        const name = candidate.name as string;
        if (names.has(name)) {
          throw new ToolError("process_failed", "MCP server returned duplicate tool names");
        }
        names.add(name);
        tools.push(candidate);
        if (tools.length > MAX_TOOLS) {
          throw new ToolError("output_limit", `MCP server exceeded the ${MAX_TOOLS}-tool limit`);
        }
      }
      if (result.nextCursor === undefined) return Object.freeze(tools);
      if (!safeText(result.nextCursor, 4_096) || result.nextCursor === cursor) {
        throw new ToolError("process_failed", "MCP server returned an invalid pagination cursor");
      }
      cursor = result.nextCursor;
    }
    throw new ToolError("output_limit", `MCP server exceeded the ${MAX_LIST_PAGES}-page limit`);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.#assertInitialized();
    const result = await this.request("tools/call", { name, arguments: args });
    if (!plainObject(result) || !Array.isArray(result.content) ||
        result.content.length > 64 ||
        result.content.some((item) =>
          !plainObject(item) || !safeText(item.type, 64)
        ) ||
        (result.isError !== undefined && typeof result.isError !== "boolean")) {
      throw new ToolError("process_failed", "MCP server returned an invalid tool result");
    }
    return result;
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.#failure !== undefined) throw this.#failure;
    const id = this.#nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    try {
      await this.#write({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
    const result = await response;
    if (this.#failure !== undefined) throw this.#failure;
    return result;
  }

  notify(method: string): Promise<void> {
    return this.#write({ jsonrpc: "2.0", method });
  }

  #assertInitialized(): void {
    if (this.#protocolVersion === undefined) {
      throw new ToolError("process_failed", "MCP client is not initialized");
    }
  }

  async #write(message: Record<string, unknown>): Promise<void> {
    const serialized = `${JSON.stringify(message)}\n`;
    if (this.process.stdin.destroyed || !this.process.stdin.writable) {
      throw new ToolError("process_failed", "MCP server input is closed");
    }
    if (!this.process.stdin.write(serialized)) {
      await new Promise<void>((resolve, reject) => {
        this.process.stdin.once("drain", resolve);
        this.process.stdin.once("error", reject);
      }).catch((error: unknown) => {
        throw new ToolError("process_failed", "MCP request could not be written", {
          cause: error,
        });
      });
    }
  }

  #accept(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > MAX_PROTOCOL_OUTPUT_BYTES) {
      this.#failPending(new ToolError("output_limit", "MCP protocol line is too large"));
      return;
    }
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.#buffer.subarray(0, newline).toString("utf8").replace(/\r$/u, "");
      this.#buffer = this.#buffer.subarray(newline + 1);
      try {
        this.#message(JSON.parse(line));
      } catch (error) {
        this.#failPending(
          error instanceof ToolError
            ? error
            : new ToolError("process_failed", "MCP server emitted invalid JSON-RPC"),
        );
      }
    }
  }

  #message(message: unknown): void {
    if (!plainObject(message) || message.jsonrpc !== "2.0") {
      throw new ToolError("process_failed", "MCP server emitted invalid JSON-RPC");
    }
    if (typeof message.id === "number" &&
        (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (Object.hasOwn(message, "result") && Object.hasOwn(message, "error")) {
        pending.reject(new ToolError(
          "process_failed",
          "MCP server returned both a result and an error",
        ));
      } else if (Object.hasOwn(message, "error")) {
        const detail = plainObject(message.error) &&
            typeof message.error.message === "string"
          ? message.error.message.slice(0, 1_024)
          : "Unknown MCP error";
        pending.reject(new ToolError("execution_failed", `MCP server error: ${detail}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if ((typeof message.id === "number" || typeof message.id === "string") &&
        typeof message.method === "string") {
      void this.#write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Recurs does not support server requests" },
      }).catch(() => {});
      return;
    }
    if (typeof message.method === "string") return;
    throw new ToolError("process_failed", "MCP server emitted invalid JSON-RPC");
  }

  #failPending(error: ToolError): void {
    this.#failure ??= error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

async function executeOperation(
  server: McpServerConfiguration,
  input: McpToolInput,
  context: ToolContext,
): Promise<ToolResult> {
  let session: ProcessSession | undefined;
  let operationFailed = false;
  try {
    session = await startProcessSession(server.command, server.args, {
      cwd: context.cwd,
      signal: context.signal,
      maxOutputBytes: MAX_PROTOCOL_OUTPUT_BYTES,
      timeoutMs: OPERATION_TIMEOUT_MS,
      ...(context.processSandbox === undefined
        ? {}
        : { sandbox: context.processSandbox }),
    });
    const client = new McpStdioClient(session);
    await client.initialize();
    const result = input.action === "list_tools"
      ? { tools: await client.listTools() }
      : { result: await client.callTool(input.tool!, input.arguments ?? {}) };
    if (jsonBytes(result) > MAX_RESULT_BYTES) {
      throw new ToolError("output_limit", "MCP result is too large");
    }
    return {
      output: JSON.stringify({ server: server.id, ...result }),
      metadata: {
        mcpServer: server.id,
        mcpAction: input.action,
        ...(input.tool === undefined ? {} : { mcpTool: input.tool }),
      },
    };
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    if (operationFailed) {
      await session?.close().catch(() => {});
    } else {
      await session?.close();
    }
  }
}

export class McpServerCatalog {
  readonly #servers: ReadonlyMap<string, McpServerConfiguration>;
  readonly #configPath: string;

  private constructor(
    configPath: string,
    servers: readonly McpServerConfiguration[],
  ) {
    this.#configPath = configPath;
    this.#servers = new Map(servers.map((server) => [server.id, server]));
  }

  static async load(dataDirectory: string): Promise<McpServerCatalog> {
    const configPath = path.join(dataDirectory, "config", CONFIG_FILE);
    try {
      const loaded = await readPrivateConfiguration(dataDirectory);
      return new McpServerCatalog(
        configPath,
        loaded === null ? [] : parseConfiguration(loaded),
      );
    } catch (error) {
      throw new ToolError("invalid_input", configurationMessage(error));
    }
  }

  get hasServers(): boolean {
    return this.#servers.size > 0;
  }

  snapshot(): McpCatalogSnapshot {
    return Object.freeze({
      configPath: this.#configPath,
      servers: Object.freeze([...this.#servers.values()]),
    });
  }

  createTool(): Tool<McpToolInput> {
    const ids = [...this.#servers.keys()];
    return {
      definition: {
        name: "mcp",
        description: `List or call tools on a user-configured stdio MCP server. Available servers: ${ids.join(", ")}`,
        inputSchema: {
          type: "object",
          properties: {
            server: { type: "string", enum: ids },
            action: { type: "string", enum: ["list_tools", "call_tool"] },
            tool: { type: "string", description: "Required for call_tool" },
            arguments: { type: "object", description: "Optional call_tool arguments" },
          },
          required: ["server", "action"],
          additionalProperties: false,
        },
      },
      executionClass: "arbitrary_process",
      mutating: true,
      parse: parseToolInput,
      permissions: (input) => {
        const server = this.#server(input.server);
        return [
          { category: "shell" as const, resource: `mcp:${server.id}`, risk: "elevated" as const },
          ...(server.network === "allow"
            ? [{ category: "network" as const, resource: `mcp:${server.id}`, risk: "elevated" as const }]
            : []),
        ];
      },
      preflight: async (input) => {
        const server = this.#server(input.server);
        try {
          const canonical = await realpath(server.command);
          const details = await lstat(canonical);
          if (!details.isFile()) throw new Error("not a file");
          await access(canonical, constants.X_OK);
        } catch (error) {
          throw new ToolError("process_failed", `MCP server is not executable: ${server.id}`, {
            cause: error,
          });
        }
      },
      execute: (input, context) =>
        executeOperation(this.#server(input.server), input, context),
    };
  }

  #server(id: string): McpServerConfiguration {
    const server = this.#servers.get(id);
    if (server === undefined) {
      throw new ToolError("invalid_input", `Unknown MCP server: ${id}`);
    }
    return server;
  }
}
