import { describe, expect, it, vi } from "vitest";

import {
  fetchPublicWeb,
  isPublicAddress,
  parsePublicWebUrl,
  PublicWebError,
  resolvePublicAddresses,
  type PublicWebRequester,
  type PublicWebResolver,
} from "../src/index.js";

describe("public web transport", () => {
  it("classifies public and non-public IPv4 and IPv6 destinations", () => {
    for (const address of [
      "0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1",
      "169.254.169.254", "172.16.0.1", "192.168.1.1", "198.18.0.1",
      "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1",
      "::1", "::ffff:127.0.0.1", "64:ff9b::1", "2001:db8::1",
      "fc00::1", "fe80::1", "ff00::1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
    expect(isPublicAddress("not-an-address")).toBe(false);
  });

  it("fails closed for blocked names, private answers, mixed answers, and DNS failure", async () => {
    const publicLookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
    ]);
    await expect(resolvePublicAddresses("localhost", publicLookup as never))
      .rejects.toMatchObject({ code: "destination_not_public" });
    await expect(resolvePublicAddresses("service.internal", publicLookup as never))
      .rejects.toMatchObject({ code: "destination_not_public" });
    await expect(resolvePublicAddresses("service.test", publicLookup as never))
      .rejects.toMatchObject({ code: "destination_not_public" });
    await expect(resolvePublicAddresses("example.com", vi.fn(async () => [
      { address: "93.184.216.34", family: 4 as const },
      { address: "10.0.0.1", family: 4 as const },
    ]) as never)).rejects.toMatchObject({ code: "destination_not_public" });
    await expect(resolvePublicAddresses("example.com", vi.fn(async () => {
      throw new Error("dns details must not escape");
    }) as never)).rejects.toMatchObject({
      code: "dns_failed",
      message: "web_fetch could not verify the destination",
    });
  });

  it("normalizes HTTP(S) URLs and rejects credentials or unsupported schemes", () => {
    expect(parsePublicWebUrl("HTTPS://Example.COM:443/docs#part").href)
      .toBe("https://example.com/docs");
    expect(() => parsePublicWebUrl("file:///etc/passwd"))
      .toThrow(PublicWebError);
    expect(() => parsePublicWebUrl("https://user:secret@example.com"))
      .toThrow(/without embedded credentials/u);
    expect(() => parsePublicWebUrl("http://localhost"))
      .toThrow(/public internet/u);
  });

  it("pins every same-host redirect hop and rejects cross-host or downgrade redirects", async () => {
    const resolve = vi.fn<PublicWebResolver>(async () => [
      { address: "93.184.216.34", family: 4 },
    ]);
    const request = vi.fn<PublicWebRequester>(async (url, addresses) => {
      expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
      if (url.pathname === "/start") {
        return { status: 302, headers: { location: "/final" }, body: new Uint8Array() };
      }
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: new TextEncoder().encode("done"),
      };
    });
    const response = await fetchPublicWeb("https://example.com/start", {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      resolve,
      request,
    });
    expect(response).toMatchObject({
      requestedUrl: "https://example.com/start",
      finalUrl: "https://example.com/final",
      redirects: 1,
      status: 200,
    });
    expect(resolve).toHaveBeenCalledTimes(2);

    await expect(fetchPublicWeb("https://example.com/start", {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      resolve,
      request: async () => ({
        status: 302,
        headers: { location: "https://other.com/final" },
        body: new Uint8Array(),
      }),
    })).rejects.toMatchObject({ code: "redirect_denied" });
    await expect(fetchPublicWeb("https://example.com/start", {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      resolve,
      request: async () => ({
        status: 302,
        headers: { location: "https://example.com:8443/final" },
        body: new Uint8Array(),
      }),
    })).rejects.toMatchObject({ code: "redirect_denied" });
    await expect(fetchPublicWeb("https://example.com/start", {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      resolve,
      request: async () => ({
        status: 302,
        headers: { location: "http://example.com/final" },
        body: new Uint8Array(),
      }),
    })).rejects.toMatchObject({ code: "redirect_denied" });
  });

  it("enforces redirect, response, cancellation, and fixed transport failures", async () => {
    const resolve: PublicWebResolver = async () => [
      { address: "93.184.216.34", family: 4 },
    ];
    const redirect: PublicWebRequester = async () => ({
      status: 302,
      headers: { location: "/again" },
      body: new Uint8Array(),
    });
    await expect(fetchPublicWeb("https://example.com/start", {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      maxRedirects: 1,
      resolve,
      request: redirect,
    })).rejects.toMatchObject({ code: "too_many_redirects" });
    await expect(fetchPublicWeb("https://example.com", {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      maxResponseBytes: 2,
      resolve,
      request: async () => ({
        status: 200,
        headers: {},
        body: new Uint8Array(3),
      }),
    })).rejects.toMatchObject({ code: "response_too_large" });
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(fetchPublicWeb("https://example.com", {
      signal: cancelled.signal,
      timeoutMs: 1_000,
      resolve,
      request: redirect,
    })).rejects.toMatchObject({ code: "cancelled" });
    await expect(fetchPublicWeb("https://example.com", {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      resolve,
      request: async () => {
        throw new Error("socket internals");
      },
    })).rejects.toMatchObject({
      code: "request_failed",
      message: "web_fetch request failed",
    });
  });

  it("bounds DNS resolution with the same total timeout", async () => {
    vi.useFakeTimers();
    try {
      const pending = fetchPublicWeb("https://example.com", {
        signal: new AbortController().signal,
        timeoutMs: 10,
        resolve: async () => await new Promise<readonly never[]>(() => undefined),
        request: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
      });
      const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(10);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid transport limits before DNS or request work", async () => {
    const resolve = vi.fn<PublicWebResolver>();
    for (const limits of [
      { timeoutMs: 0 },
      { timeoutMs: 30_001 },
      { timeoutMs: 1_000, maxResponseBytes: 0 },
      { timeoutMs: 1_000, maxResponseBytes: 1024 * 1024 + 1 },
      { timeoutMs: 1_000, maxRedirects: -1 },
      { timeoutMs: 1_000, maxRedirects: 4 },
    ]) {
      await expect(fetchPublicWeb("https://example.com", {
        signal: new AbortController().signal,
        resolve,
        request: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
        ...limits,
      })).rejects.toMatchObject({ code: "invalid_options" });
    }
    expect(resolve).not.toHaveBeenCalled();
  });
});
