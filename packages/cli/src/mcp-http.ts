import type { LookupFunction } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolvePublicAddresses, ToolError, type PublicAddress } from "@recurs/tools";

const MAX_RESPONSE_BYTES = 512 * 1024;
function loopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** Authorization metadata never acquires authority to reach another local service. */
export async function mcpDestination(endpoint: URL, target: URL): Promise<readonly PublicAddress[]> {
  if (target.username || target.password || target.hash ||
      (target.protocol !== "https:" && target.protocol !== "http:")) {
    throw new ToolError("permission_denied", "MCP destination must be an HTTPS URL without credentials");
  }
  if (loopback(endpoint) && target.origin === endpoint.origin) {
    return [{ address: endpoint.hostname === "[::1]" ? "::1" : "127.0.0.1", family: endpoint.hostname === "[::1]" ? 6 : 4 }];
  }
  if (target.protocol !== "https:") throw new ToolError("permission_denied", "MCP metadata cannot authorize an insecure or local destination");
  return await resolvePublicAddresses(target.hostname);
}

function pinnedLookup(addresses: readonly PublicAddress[]): LookupFunction {
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options.all) callback(null, addresses.map((address) => ({ ...address })));
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  }) as LookupFunction;
}

/** Fetch-compatible streaming transport with verified DNS, no redirects and bounded bodies. */
export function createMcpFetch(endpoint: string, flowSignal?: AbortSignal): typeof fetch {
  const authority = new URL(endpoint);
  return async (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000), ...(flowSignal ? [flowSignal] : [])]);
    signal.throwIfAborted();
    const addresses = await mcpDestination(authority, target);
    signal.throwIfAborted();
    const bytes = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
    if (bytes && bytes.length > MAX_RESPONSE_BYTES) throw new ToolError("output_limit", "MCP request is too large");
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key] = value; });
    headers["accept-encoding"] = "identity";
    return await new Promise<Response>((resolve, reject) => {
      const outgoing = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
        method: request.method,
        headers,
        lookup: pinnedLookup(addresses),
        signal,
        maxHeaderSize: 16 * 1024,
      }, (incoming) => {
        const status = incoming.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          incoming.destroy();
          reject(new ToolError("permission_denied", "MCP HTTP redirects are not followed; configure the final endpoint"));
          return;
        }
        if (incoming.headers["content-encoding"] && incoming.headers["content-encoding"] !== "identity") {
          incoming.destroy();
          reject(new ToolError("invalid_input", "MCP encoded responses are not supported"));
          return;
        }
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
          else if (value !== undefined) responseHeaders.set(key, value);
        }
        if ([204, 205, 304].includes(status)) {
          incoming.resume();
          resolve(new Response(null, { status, headers: responseHeaders }));
          return;
        }
        let received = 0;
        const iterator = incoming[Symbol.asyncIterator]();
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await iterator.next();
              if (next.done) { controller.close(); return; }
              const chunk = Buffer.from(next.value);
              received += chunk.length;
              if (received > MAX_RESPONSE_BYTES) {
                incoming.destroy();
                throw new ToolError("output_limit", "MCP HTTP response is too large");
              }
              controller.enqueue(chunk);
            } catch (error) { controller.error(error); }
          },
          cancel() { incoming.destroy(); outgoing.destroy(); },
        });
        resolve(new Response(body, { status, headers: responseHeaders }));
      });
      outgoing.on("error", reject);
      outgoing.end(bytes);
    });
  };
}
