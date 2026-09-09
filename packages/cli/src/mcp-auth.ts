import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import {
  auth,
  StreamableHTTPClientTransport,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthClientInformationContext,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { ToolError } from "@recurs/tools";
import { checkedMcpUrl } from "./mcp-protocol.js";
import { createMcpFetch, mcpDestination } from "./mcp-http.js";

interface AuthDocument {
  version: 1;
  endpoint: string;
  redirectUrl?: string;
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  discovery?: OAuthDiscoveryState;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function prepareMcpAuthDirectory(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = path.join(root, "auth");
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if (!isObject(error) || error.code !== "EEXIST") throw error;
  });
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0 ||
      (process.getuid && details.uid !== process.getuid())) throw new ToolError("permission_denied", "MCP OAuth directory is unsafe");
  return directory;
}

/** Credential files never enter catalogs, transcripts, project config, or tool results. */
export class McpOAuthProvider implements OAuthClientProvider {
  readonly #file: string;
  readonly #directory: string;
  readonly #root: string;
  readonly #endpoint: string;
  readonly #clientId: string | undefined;
  #document: AuthDocument;
  #verifier: string | undefined;
  #state = "";
  #flowSignal: AbortSignal | undefined;
  #redirect: ((url: URL) => void) | undefined;
  #writing: Promise<void> = Promise.resolve();

  private constructor(root: string, endpoint: string, key: string, clientId?: string) {
    this.#root = root;
    this.#directory = path.join(root, "auth", "mcp", createHash("sha256").update(key).digest("hex"));
    this.#endpoint = endpoint;
    this.#file = path.join(this.#directory, "credentials");
    this.#clientId = clientId;
    this.#document = { version: 1, endpoint };
  }

  static async load(root: string, endpoint: string, key: string, clientId?: string): Promise<McpOAuthProvider> {
    const provider = new McpOAuthProvider(root, checkedMcpUrl(endpoint).href, key, clientId);
    try {
      const before = await lstat(provider.#file);
      const uid = process.getuid?.();
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
          before.size > 64 * 1024 || (before.mode & 0o077) !== 0 ||
          (uid !== undefined && before.uid !== uid)) throw new Error("unsafe auth file");
      const handle = await open(provider.#file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (before.dev !== opened.dev || before.ino !== opened.ino) throw new Error("auth file changed");
        const bytes = await handle.readFile();
        if (bytes.length > 64 * 1024) throw new Error("auth file too large");
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        const canonical = await realpath(provider.#file);
        const rootReal = await realpath(root);
        if (!canonical.startsWith(`${rootReal}${path.sep}`)) throw new Error("auth file escapes root");
        if (!isObject(value) || value.version !== 1 || value.endpoint !== provider.#endpoint ||
            (value.tokens !== undefined && (!isObject(value.tokens) || typeof value.tokens.access_token !== "string")) ||
            (value.client !== undefined && (!isObject(value.client) || typeof value.client.client_id !== "string"))) throw new Error("invalid auth state");
        provider.#document = value as unknown as AuthDocument;
      } finally { await handle.close(); }
    } catch (error) {
      if (!(isObject(error) && error.code === "ENOENT")) {
        throw new ToolError("permission_denied", "MCP OAuth state could not be read safely; remove unsafe credentials before authenticating");
      }
    }
    return provider;
  }

  setConnectionSignal(signal: AbortSignal): void { this.#flowSignal = signal; }

  get redirectUrl(): string { return this.#document.redirectUrl ?? "http://127.0.0.1/callback"; }
  get clientMetadata() {
    return { client_name: "Recurs", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" as const };
  }
  state(): string { return this.#state; }
  clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    if (!this.#redirect && !this.#document.tokens) throw new ToolError("permission_denied", "MCP authentication required; run /mcp auth <server> from the local CLI");
    const client = this.#document.client;
    if (client && (!ctx || !client.issuer || client.issuer === ctx.issuer)) return client;
    return this.#clientId ? { client_id: this.#clientId, ...(ctx ? { issuer: ctx.issuer } : {}) } : undefined;
  }
  async saveClientInformation(client: StoredOAuthClientInformation): Promise<void> {
    this.#document.client = client;
    await this.#save();
  }
  tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    const tokens = this.#document.tokens;
    return tokens && (!ctx || !tokens.issuer || tokens.issuer === ctx.issuer) ? tokens : undefined;
  }
  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    this.#document.tokens = tokens;
    await this.#save();
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.#redirect) throw new ToolError("permission_denied", "MCP authentication required; run /mcp auth <server> from the local CLI");
    await mcpDestination(new URL(this.#endpoint), url);
    this.#redirect(url);
  }
  saveCodeVerifier(verifier: string): void { this.#verifier = verifier; }
  codeVerifier(): string {
    if (!this.#verifier) throw new Error("MCP authorization expired; start authentication again");
    return this.#verifier;
  }
  discoveryState(): OAuthDiscoveryState | undefined { return this.#document.discovery; }
  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    this.#document.discovery = discovery;
    await this.#save();
  }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all" || scope === "tokens") delete this.#document.tokens;
    if (scope === "all" || scope === "client") delete this.#document.client;
    if (scope === "all" || scope === "discovery") delete this.#document.discovery;
    if (scope === "all" || scope === "verifier") this.#verifier = undefined;
    await this.#save();
  }
  async #save(): Promise<void> {
    const save = async (): Promise<void> => {
      this.#flowSignal?.throwIfAborted();
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      for (const directory of [path.join(this.#root, "auth"), path.join(this.#root, "auth", "mcp"), this.#directory]) {
        await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
          if (!isObject(error) || error.code !== "EEXIST") throw error;
        });
        const stats = await lstat(directory);
        if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0 ||
            (process.getuid && stats.uid !== process.getuid())) throw new Error("MCP OAuth directory is unsafe");
      }
      const staging = path.join(this.#directory, `.write-${randomUUID()}`);
      await mkdir(staging, { mode: 0o700 });
      const temporary = path.join(staging, "credentials");
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(this.#document));
          await handle.sync();
        } finally { await handle.close(); }
        this.#flowSignal?.throwIfAborted();
        await rename(temporary, this.#file);
      } finally {
        await unlink(temporary).catch(() => {});
        await rmdir(staging).catch(() => {});
      }
    };
    this.#writing = this.#writing.catch(() => {}).then(save);
    await this.#writing;
  }

  async begin(): Promise<McpAuthentication> {
    const flow = new AbortController();
    this.#flowSignal = flow.signal;
    const state = randomBytes(32).toString("hex");
    this.#state = state;
    let finish: (() => void) | undefined;
    let failed: (() => void) | undefined;
    let status: McpAuthentication["status"] = "waiting";
    let completing = false;
    const completion = new Promise<void>((resolve, reject) => {
      finish = resolve;
      failed = () => reject(new Error("MCP authentication failed or expired; run auth again"));
    });
    void completion.catch(() => {});
    const transport = new StreamableHTTPClientTransport(new URL(this.#endpoint), { authProvider: this, fetch: createMcpFetch(this.#endpoint, flow.signal) });
    const close = (): void => {
      flow.abort();
      clearTimeout(timer);
      this.#redirect = undefined;
      this.#verifier = undefined;
      server.close();
      server.closeAllConnections();
      void transport.close().catch(() => {});
    };
    const server = createServer((request, response) => {
      const callback = new URL(request.url ?? "/", this.redirectUrl);
      const supplied = callback.searchParams.get("state") ?? "";
      if (request.method !== "GET" || callback.pathname !== "/callback" ||
          request.headers.host !== new URL(this.redirectUrl).host || completing ||
          Buffer.byteLength(supplied) !== Buffer.byteLength(state) ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(state))) {
        response.writeHead(400).end("Invalid authorization callback");
        return;
      }
      completing = true;
      void transport.finishAuth(callback.searchParams).then(() => {
        if (status !== "waiting" || flow.signal.aborted) return;
        status = "authenticated";
        response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("Recurs connected. You can close this window.");
        finish?.();
        close();
      }, () => {
        if (status === "waiting") status = "failed";
        response.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("Authentication failed. Return to Recurs and try again.");
        failed?.();
        close();
      });
    });
    const timer = setTimeout(() => { status = "failed"; failed?.(); close(); }, 5 * 60_000);
    timer.unref();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    server.unref();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("MCP OAuth callback could not start");
    this.#document.redirectUrl = `http://127.0.0.1:${address.port}/callback`;
    // Registrations include the callback URI, so a fresh interactive flow registers anew.
    delete this.#document.client;
    delete this.#document.discovery;
    delete this.#document.tokens;
    let authorizationUrl: URL | undefined;
    this.#redirect = (url) => { authorizationUrl = url; };
    try {
      await auth(this, { serverUrl: this.#endpoint, fetchFn: createMcpFetch(this.#endpoint, flow.signal), forceReauthorization: true });
      if (!authorizationUrl) throw new Error("MCP authorization did not return a browser URL");
      return {
        url: authorizationUrl.href,
        get status() { return status; },
        completion,
        cancel() { if (status === "waiting") { status = "cancelled"; failed?.(); } close(); },
      };
    } catch (error) { status = "failed"; failed?.(); close(); throw error; }
  }
}

export interface McpAuthentication {
  readonly url: string;
  readonly status: "waiting" | "authenticated" | "failed" | "cancelled";
  readonly completion: Promise<void>;
  cancel(): void;
}
