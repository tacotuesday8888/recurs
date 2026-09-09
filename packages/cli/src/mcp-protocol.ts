import {
  Client,
  StreamableHTTPClientTransport,
  deserializeMessage,
  serializeMessage,
  type JSONRPCMessage,
  type OAuthClientProvider,
  type Transport,
} from "@modelcontextprotocol/client";
import { createMcpFetch } from "./mcp-http.js";
import { RECURS_VERSION } from "@recurs/contracts";
import { ToolError, type ProcessSession } from "@recurs/tools";

const MAX_MESSAGE_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_PAGES = 8;
const MAX_ITEMS = 128;

/** The SDK owns protocol compatibility; Recurs continues to own process isolation. */
class OwnedStdioTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  #buffer = Buffer.alloc(0);
  #closed = false;
  failure: Error | undefined;

  constructor(readonly process: ProcessSession) {}

  // The SDK uses these public stdio properties to choose its negotiation fallback.
  get stderr() { return this.process.stderr; }
  get pid(): null { return null; }

  async start(): Promise<void> {
    this.process.stdout.on("data", (chunk: Buffer) => {
      if (this.#closed) return;
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      try {
        while (true) {
          const newline = this.#buffer.indexOf(0x0a);
          if (newline < 0) {
            if (this.#buffer.length > MAX_MESSAGE_BYTES) throw new ToolError("output_limit", "MCP protocol line is too large");
            break;
          }
          if (newline > MAX_MESSAGE_BYTES) throw new ToolError("output_limit", "MCP protocol line is too large");
          const line = this.#buffer.subarray(0, newline).toString("utf8");
          this.#buffer = this.#buffer.subarray(newline + 1);
          this.onmessage?.(deserializeMessage(line));
        }
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error("Invalid MCP message");
        this.onerror?.(this.failure);
        void this.close().catch(() => {});
      }
    });
    void this.process.completion.then(
      () => this.#finished(),
      (error: unknown) => {
        this.onerror?.(error instanceof Error ? error : new Error("MCP process failed"));
        this.#finished();
      },
    );
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.#closed || this.process.stdin.destroyed) throw new ToolError("process_failed", "MCP server input is closed");
    const data = serializeMessage(message);
    await new Promise<void>((resolve, reject) => {
      this.process.stdin.write(data, (error) => error ? reject(error) : resolve());
    });
  }

  #finished(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer = Buffer.alloc(0);
    this.onclose?.();
  }

  async close(): Promise<void> {
    this.#finished();
    await this.process.close();
  }
}

export type McpAction = "list_tools" | "call_tool" | "list_resources" |
  "list_resource_templates" | "read_resource" | "list_prompts" | "get_prompt";

export interface McpOperation {
  readonly server: string;
  readonly action: McpAction;
  readonly tool?: string;
  readonly uri?: string;
  readonly prompt?: string;
  readonly arguments?: Record<string, unknown>;
}

export function checkedMcpUrl(value: string): URL {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
      url.username || url.password || url.hash || url.search) {
    throw new Error("MCP HTTP URLs require HTTPS (or loopback HTTP), without credentials, query, or fragment");
  }
  return url;
}

export class McpProtocolClient {
  readonly #client: Client;
  readonly #lifetime = new AbortController();
  readonly #transport: Transport;
  #failure: Error | undefined;

  constructor(input: { process: ProcessSession } | { url: string; authProvider: OAuthClientProvider & { setConnectionSignal?(signal: AbortSignal): void } }) {
    if (!("process" in input)) input.authProvider.setConnectionSignal?.(this.#lifetime.signal);
    this.#transport = "process" in input ? new OwnedStdioTransport(input.process)
      : new StreamableHTTPClientTransport(checkedMcpUrl(input.url), {
        authProvider: input.authProvider,
        fetch: createMcpFetch(input.url, this.#lifetime.signal),
        onInsufficientScope: "throw",
        reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 },
      });
    this.#client = new Client({ name: "recurs", version: RECURS_VERSION }, {
      capabilities: {},
      listMaxPages: MAX_PAGES,
      versionNegotiation: { mode: "auto", probe: { timeoutMs: "process" in input ? 250 : 10_000, maxRetries: 0 } },
    });
    this.#client.onerror = (error) => { this.#failure = error; };
  }

  async initialize(): Promise<void> {
    try { await this.#client.connect(this.#transport, { timeout: 30_000 }); }
    catch (error) { throw this.#transport instanceof OwnedStdioTransport && this.#transport.failure ? this.#transport.failure : error; }
  }

  get identity() {
    const version = this.#client.getServerVersion();
    return {
      ...(this.#client.getNegotiatedProtocolVersion() ? { protocolVersion: this.#client.getNegotiatedProtocolVersion()! } : {}),
      ...(version ? { serverName: version.name, serverVersion: version.version } : {}),
      capabilities: Object.keys(this.#client.getServerCapabilities() ?? {}).sort(),
    };
  }

  async ping(signal: AbortSignal): Promise<void> {
    if (this.#failure) throw this.#failure;
    await this.#client.ping({ signal, timeout: 30_000 });
  }

  async execute(input: McpOperation, signal: AbortSignal): Promise<Record<string, unknown>> {
    const options = { signal, timeout: 30_000, cacheMode: "refresh" as const };
    const capability = input.action.includes("resource") ? "resources"
      : input.action.includes("prompt") ? "prompts" : "tools";
    if (!this.#client.getServerCapabilities()?.[capability]) {
      throw new ToolError("tool_unavailable", `MCP server does not advertise ${capability}`);
    }
    let result: Record<string, unknown>;
    if (input.action.startsWith("list_")) {
      const field = { list_tools: "tools", list_resources: "resources", list_resource_templates: "resourceTemplates", list_prompts: "prompts" }[input.action as "list_tools"];
      const items: unknown[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = cursor === undefined ? {} : { cursor };
        const response = input.action === "list_tools" ? await this.#client.listTools(params, options)
          : input.action === "list_resources" ? await this.#client.listResources(params, options)
          : input.action === "list_resource_templates" ? await this.#client.listResourceTemplates(params, options)
          : await this.#client.listPrompts(params, options);
        items.push(...(response as unknown as Record<string, unknown[]>)[field]!);
        if (items.length > MAX_ITEMS || Buffer.byteLength(JSON.stringify(items)) > MAX_RESULT_BYTES) throw new ToolError("output_limit", "MCP discovery exceeds the result limit");
        cursor = response.nextCursor;
        if (cursor === undefined) return { [field]: items };
        if (cursors.has(cursor)) throw new ToolError("process_failed", "MCP pagination cursor repeated");
        cursors.add(cursor);
      }
      throw new ToolError("output_limit", "MCP discovery exceeds the page limit");
    } else if (input.action === "call_tool") {
      result = { result: await this.#client.callTool({ name: input.tool!, arguments: input.arguments ?? {} }, options) };
    } else if (input.action === "read_resource") {
      result = { result: await this.#client.readResource({ uri: input.uri! }, options) };
    } else {
      result = { result: await this.#client.getPrompt({ name: input.prompt!, arguments: input.arguments as Record<string, string> ?? {} }, options) };
    }
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) throw new ToolError("output_limit", "MCP result is too large");
    return result;
  }

  close(): Promise<void> { this.#lifetime.abort(); return this.#client.close(); }
}
