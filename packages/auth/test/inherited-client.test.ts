import { Duplex } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const socketBoundary = vi.hoisted(() => ({
  discard: vi.fn(),
  take: vi.fn(),
}));

vi.mock("../src/socket.js", () => ({
  discardInheritedNativeAuthorityDescriptorEnvironment: socketBoundary.discard,
  takeInheritedNativeAuthoritySocket: socketBoundary.take,
}));

import {
  createNativeAuthorityClientFromInheritedFd,
} from "../src/client.js";
import {
  NativeFrameDecoder,
  NativeKeychainStatusCode,
  NativeMessageType,
  NativeSafeFailureCode,
  decodeFieldTable,
  encodeBoolean,
  encodeFieldTable,
  encodeNativeFrame,
  encodeU16,
  encodeVersionText,
} from "../src/index.js";
import type { NativeFrame } from "../src/index.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

class SelfAttestingNativePeer extends Duplex {
  readonly #decoder = new NativeFrameDecoder();
  readonly #healthFailure: NativeSafeFailureCode | undefined;
  readonly #respondToHealth: boolean;

  constructor(options: {
    readonly healthFailure?: NativeSafeFailureCode;
    readonly respondToHealth?: boolean;
  } = {}) {
    super();
    this.#healthFailure = options.healthFailure;
    this.#respondToHealth = options.respondToHealth ?? true;
  }

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      for (const frame of this.#decoder.push(chunk)) {
        this.#respond(frame);
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  #respond(frame: NativeFrame): void {
    if (frame.type === NativeMessageType.hello) {
      const fields = decodeFieldTable(frame.payload);
      const nonce = fields[1]?.value;
      if (nonce === undefined) throw new Error("missing nonce");
      this.push(encodeNativeFrame({
        type: NativeMessageType.helloResult,
        requestId: frame.requestId,
        payload: encodeFieldTable([
          { tag: 1, value: encodeVersionText("0.1.0") },
          { tag: 2, value: encodeVersionText("0.1.0") },
          { tag: 3, value: nonce },
          { tag: 4, value: encodeBoolean(true) },
          { tag: 5, value: encodeBoolean(true) },
          { tag: 6, value: encodeVersionText("14.4") },
        ]),
      }));
      return;
    }
    if (frame.type === NativeMessageType.health && this.#respondToHealth) {
      if (this.#healthFailure !== undefined) {
        this.push(encodeNativeFrame({
          type: NativeMessageType.safeFailure,
          requestId: frame.requestId,
          payload: encodeFieldTable([
            { tag: 1, value: encodeU16(this.#healthFailure) },
          ]),
        }));
        return;
      }
      this.push(encodeNativeFrame({
        type: NativeMessageType.healthResult,
        requestId: frame.requestId,
        payload: encodeFieldTable([
          { tag: 1, value: encodeU16(NativeKeychainStatusCode.available) },
          { tag: 2, value: encodeBoolean(true) },
        ]),
      }));
    }
  }
}

describe("inherited native authority client", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: true,
      value: "darwin",
    });
  });

  afterEach(() => {
    socketBoundary.discard.mockReset();
    socketBoundary.take.mockReset();
    if (originalPlatform !== undefined) {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("does not expose ready from a self-attested inherited socket", async () => {
    const socket = new SelfAttestingNativePeer();
    socketBoundary.take.mockReturnValueOnce(socket);

    const client = await createNativeAuthorityClientFromInheritedFd({
      engineVersion: "0.1.0",
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
    });

    await expect(client.status()).resolves.toEqual({
      state: "unavailable",
      reason: "peer_identity_unverified",
    });
  });

  it("closes a self-attested inherited socket after the status check", async () => {
    const socket = new SelfAttestingNativePeer();
    socketBoundary.take.mockReturnValueOnce(socket);
    const client = await createNativeAuthorityClientFromInheritedFd({
      engineVersion: "0.1.0",
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
    });

    await client.status();

    expect(socket.destroyed).toBe(true);
    expect(() => client.close()).not.toThrow();
  });

  it("preserves cancellation and closes the inherited socket", async () => {
    const socket = new SelfAttestingNativePeer({ respondToHealth: false });
    socketBoundary.take.mockReturnValueOnce(socket);
    const client = await createNativeAuthorityClientFromInheritedFd({
      engineVersion: "0.1.0",
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
    });
    const controller = new AbortController();

    const pending = client.status(controller.signal);
    controller.abort("SECRET_INHERITED_ABORT_CANARY");
    const error = await pending.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({
      name: "AbortError",
      message: "The operation was aborted.",
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_INHERITED_ABORT_CANARY");
    expect(socket.destroyed).toBe(true);
  });

  it("preserves a fixed native failure", async () => {
    const socket = new SelfAttestingNativePeer({
      healthFailure: NativeSafeFailureCode.keychainUnavailable,
    });
    socketBoundary.take.mockReturnValueOnce(socket);
    const client = await createNativeAuthorityClientFromInheritedFd({
      engineVersion: "0.1.0",
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
    });

    await expect(client.status()).resolves.toEqual({
      state: "unavailable",
      reason: "keychain_unavailable",
    });
    expect(socket.destroyed).toBe(true);
  });

  it("ignores every fabricated JavaScript trust field and argument", async () => {
    const canary = "SECRET_INHERITED_TRUST_GETTER_CANARY";
    const baseOptions = {
      engineVersion: "0.1.0",
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
    };
    const hostileOptions: Record<string, unknown> = { ...baseOptions };
    Object.defineProperty(hostileOptions, "trusted", {
      enumerable: true,
      get() {
        throw new Error(canary);
      },
    });
    const callFromUntypedJavascript = createNativeAuthorityClientFromInheritedFd as (
      options: Record<string, unknown>,
      fabricatedTrust?: unknown,
    ) => ReturnType<typeof createNativeAuthorityClientFromInheritedFd>;

    for (const options of [
      { ...baseOptions, trusted: true },
      { ...baseOptions, nativeAuthority: { state: "ready" } },
      hostileOptions,
    ]) {
      const socket = new SelfAttestingNativePeer();
      socketBoundary.take.mockReturnValueOnce(socket);

      const client = await callFromUntypedJavascript(options);

      await expect(client.status()).resolves.toEqual({
        state: "unavailable",
        reason: "peer_identity_unverified",
      });
      expect(socket.destroyed).toBe(true);
    }

    for (const fabricatedTrust of [
      true,
      { trusted: true },
      { nativeAuthority: { state: "ready" } },
    ]) {
      const socket = new SelfAttestingNativePeer();
      socketBoundary.take.mockReturnValueOnce(socket);

      const client = await callFromUntypedJavascript(
        baseOptions,
        fabricatedTrust,
      );

      await expect(client.status()).resolves.toEqual({
        state: "unavailable",
        reason: "peer_identity_unverified",
      });
      expect(socket.destroyed).toBe(true);
    }
    expect(socketBoundary.take).toHaveBeenCalledTimes(6);
  });
});
