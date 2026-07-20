import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_URL_BYTES = 2_048;
const MAX_HEADER_BYTES = 16 * 1024;

const ipv4Denylist = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  ipv4Denylist.addSubnet(address, prefix, "ipv4");
}

const ipv6Allowlist = new BlockList();
ipv6Allowlist.addSubnet("2000::", 3, "ipv6");
const ipv6Denylist = new BlockList();
for (const [address, prefix] of [
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  ipv6Denylist.addSubnet(address, prefix, "ipv6");
}

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".test",
  ".invalid",
  ".example",
  ".home.arpa",
  ".onion",
] as const;

export type PublicWebErrorCode =
  | "invalid_url"
  | "invalid_options"
  | "destination_not_public"
  | "dns_failed"
  | "redirect_denied"
  | "too_many_redirects"
  | "request_failed"
  | "response_too_large"
  | "timeout"
  | "cancelled";

export class PublicWebError extends Error {
  constructor(
    public readonly code: PublicWebErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PublicWebError";
  }
}

export interface PublicAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface PublicWebResponse {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly redirects: number;
}

interface RawWebResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export type PublicWebResolver = (
  hostname: string,
) => Promise<readonly PublicAddress[]>;

export type PublicWebRequester = (
  url: URL,
  addresses: readonly PublicAddress[],
  options: {
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    readonly maxResponseBytes: number;
  },
) => Promise<RawWebResponse>;

export interface PublicWebFetchOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxResponseBytes?: number;
  readonly maxRedirects?: number;
  readonly resolve?: PublicWebResolver;
  readonly request?: PublicWebRequester;
}

function canonicalHostname(hostname: string): string {
  const withoutBrackets = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/u, "");
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !ipv4Denylist.check(address, "ipv4");
  if (family === 6) {
    if (address.toLowerCase().startsWith("::ffff:")) return false;
    return ipv6Allowlist.check(address, "ipv6") &&
      !ipv6Denylist.check(address, "ipv6");
  }
  return false;
}

function assertHostnameAllowed(hostname: string): string {
  const canonical = canonicalHostname(hostname);
  if (
    canonical.length === 0 || canonical === "localhost" ||
    canonical === "metadata.google.internal" ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => canonical.endsWith(suffix))
  ) {
    throw new PublicWebError(
      "destination_not_public",
      "web_fetch permits only public internet destinations",
    );
  }
  return canonical;
}

export async function resolvePublicAddresses(
  hostname: string,
  lookup: typeof dnsLookup = dnsLookup,
): Promise<readonly PublicAddress[]> {
  const canonical = assertHostnameAllowed(hostname);
  let resolved: readonly LookupAddress[];
  try {
    resolved = await lookup(canonical, { all: true, verbatim: true });
  } catch (error) {
    throw new PublicWebError(
      "dns_failed",
      "web_fetch could not verify the destination",
      { cause: error },
    );
  }
  const unique = [...new Map(resolved.map(({ address, family }) => [
    `${family}:${address}`,
    { address, family },
  ] as const)).values()].filter(
    (item): item is PublicAddress => item.family === 4 || item.family === 6,
  );
  if (unique.length === 0 || unique.some(({ address }) => !isPublicAddress(address))) {
    throw new PublicWebError(
      "destination_not_public",
      "web_fetch permits only public internet destinations",
    );
  }
  return unique;
}

export function parsePublicWebUrl(input: string): URL {
  if (Buffer.byteLength(input, "utf8") > MAX_URL_BYTES) {
    throw new PublicWebError("invalid_url", "web_fetch URL is too long");
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new PublicWebError("invalid_url", "web_fetch requires a valid URL", {
      cause: error,
    });
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username.length > 0 || url.password.length > 0 || url.hostname.length === 0
  ) {
    throw new PublicWebError(
      "invalid_url",
      "web_fetch requires an HTTP(S) URL without embedded credentials",
    );
  }
  assertHostnameAllowed(url.hostname);
  url.hash = "";
  return url;
}

function pinnedLookup(
  addresses: readonly PublicAddress[],
): NonNullable<RequestOptions["lookup"]> {
  return ((
    _hostname: string,
    options: number | { readonly family?: number; readonly all?: boolean },
    callback: (...args: unknown[]) => void,
  ) => {
    const family = typeof options === "number" ? options : (options.family ?? 0);
    const eligible = family === 0
      ? addresses
      : addresses.filter((address) => address.family === family);
    if (eligible.length === 0) {
      const error = Object.assign(new Error("No verified address for requested family"), {
        code: "ENOTFOUND",
      });
      callback(error);
      return;
    }
    if (typeof options === "object" && options.all === true) {
      callback(null, eligible.map(({ address, family: itemFamily }) => ({
        address,
        family: itemFamily,
      })));
      return;
    }
    const selected = eligible[0]!;
    callback(null, selected.address, selected.family);
  }) as NonNullable<RequestOptions["lookup"]>;
}

async function readBoundedBody(
  response: IncomingMessage,
  maximum: number,
): Promise<Uint8Array> {
  const contentLength = response.headers["content-length"];
  if (
    typeof contentLength === "string" &&
    Number.isSafeInteger(Number(contentLength)) && Number(contentLength) > maximum
  ) {
    response.destroy();
    throw new PublicWebError(
      "response_too_large",
      "web_fetch response exceeded its byte limit",
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.byteLength;
    if (size > maximum) {
      response.destroy();
      throw new PublicWebError(
        "response_too_large",
        "web_fetch response exceeded its byte limit",
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

type RequestFactory = (
  url: URL,
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

function normalizeHeaders(response: IncomingMessage): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (typeof value === "string") headers[name.toLowerCase()] = value;
    else if (Array.isArray(value)) headers[name.toLowerCase()] = value.join(", ");
  }
  return headers;
}

const nodeRequest: PublicWebRequester = async (url, addresses, options) => {
  const factory = (url.protocol === "https:" ? httpsRequest : httpRequest) as RequestFactory;
  return await new Promise<RawWebResponse>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };
    const request = factory(url, {
      method: "GET",
      agent: false,
      lookup: pinnedLookup(addresses),
      maxHeaderSize: MAX_HEADER_BYTES,
      signal: options.signal,
      headers: {
        accept: "text/markdown, text/plain;q=0.9, application/json;q=0.8, text/html;q=0.7, application/xml;q=0.6",
        "accept-encoding": "identity",
        "user-agent": "Recurs/0.0.0 (+https://github.com/tacotuesday8888/recurs)",
      },
    }, (response) => {
      void readBoundedBody(response, options.maxResponseBytes).then(
        (body) => finish(() => resolve({
          status: response.statusCode ?? 0,
          headers: normalizeHeaders(response),
          body,
        })),
        (error: unknown) => finish(() => reject(error)),
      );
    });
    request.setTimeout(options.timeoutMs, () => {
      request.destroy(new PublicWebError("timeout", "web_fetch timed out"));
    });
    request.on("error", (error) => finish(() => reject(error)));
    request.end();
  });
};

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 ||
    status === 307 || status === 308;
}

async function settleBeforeAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw signal.reason;
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export async function fetchPublicWeb(
  input: string,
  options: PublicWebFetchOptions,
): Promise<PublicWebResponse> {
  if (options.signal.aborted) {
    throw new PublicWebError("cancelled", "web_fetch was cancelled");
  }
  const maximum = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (
    !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
    options.timeoutMs > 30_000 ||
    !Number.isSafeInteger(maximum) || maximum < 1 ||
    maximum > DEFAULT_MAX_RESPONSE_BYTES ||
    !Number.isSafeInteger(maxRedirects) || maxRedirects < 0 ||
    maxRedirects > DEFAULT_MAX_REDIRECTS
  ) {
    throw new PublicWebError(
      "invalid_options",
      "web_fetch transport limits are invalid",
    );
  }
  const resolve = options.resolve ?? resolvePublicAddresses;
  const request = options.request ?? nodeRequest;
  const requested = parsePublicWebUrl(input);
  let current = requested;
  const deadline = Date.now() + options.timeoutMs;
  const bounded = new AbortController();
  const cancelled = () => bounded.abort(
    new PublicWebError("cancelled", "web_fetch was cancelled"),
  );
  options.signal.addEventListener("abort", cancelled, { once: true });
  if (options.signal.aborted) cancelled();
  const timer = setTimeout(() => bounded.abort(
    new PublicWebError("timeout", "web_fetch timed out"),
  ), options.timeoutMs);

  try {
    for (let redirects = 0; ; redirects += 1) {
      let addresses: readonly PublicAddress[];
      try {
        addresses = await settleBeforeAbort(resolve(current.hostname), bounded.signal);
      } catch (error) {
        if (error instanceof PublicWebError) throw error;
        throw new PublicWebError(
          "dns_failed",
          "web_fetch could not verify the destination",
          { cause: error },
        );
      }
      let response: RawWebResponse;
      try {
        response = await settleBeforeAbort(request(current, addresses, {
          signal: bounded.signal,
          timeoutMs: Math.max(1, deadline - Date.now()),
          maxResponseBytes: maximum,
        }), bounded.signal);
      } catch (error) {
        if (error instanceof PublicWebError) throw error;
        throw new PublicWebError("request_failed", "web_fetch request failed", {
          cause: error,
        });
      }
      if (response.body.byteLength > maximum) {
        throw new PublicWebError(
          "response_too_large",
          "web_fetch response exceeded its byte limit",
        );
      }
      if (!isRedirect(response.status)) {
        return {
          requestedUrl: requested.href,
          finalUrl: current.href,
          status: response.status,
          headers: response.headers,
          body: response.body,
          redirects,
        };
      }
      if (redirects >= maxRedirects) {
        throw new PublicWebError("too_many_redirects", "web_fetch redirect limit reached");
      }
      const location = response.headers.location;
      if (location === undefined) {
        throw new PublicWebError("request_failed", "web_fetch received an invalid redirect");
      }
      let next: URL;
      try {
        next = parsePublicWebUrl(new URL(location, current).href);
      } catch (error) {
        if (error instanceof PublicWebError) throw error;
        throw new PublicWebError("request_failed", "web_fetch received an invalid redirect", {
          cause: error,
        });
      }
      if (
        canonicalHostname(next.hostname) !== canonicalHostname(current.hostname) ||
        next.port !== current.port ||
        (current.protocol === "https:" && next.protocol !== "https:")
      ) {
        throw new PublicWebError(
          "redirect_denied",
          "web_fetch requires a new approval for a cross-host, cross-port, or downgraded redirect",
        );
      }
      current = next;
    }
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", cancelled);
  }
}
