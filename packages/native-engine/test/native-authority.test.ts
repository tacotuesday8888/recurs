import { Duplex } from "node:stream";

import {
  NATIVE_COMPONENT_VERSION,
  type NativeAuthorityStatusPort,
} from "@recurs/contracts";
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
  type NativeFrame,
} from "@recurs/auth";
import { afterEach, describe, expect, it, vi } from "vitest";

const cli = vi.hoisted(() => ({
  runCliProcess: vi.fn(),
}));

vi.mock("@recurs/cli", () => ({
  runCliProcess: cli.runCliProcess,
}));

import {
  createPrivateNativeAuthorityStatusPort,
  runPrivateEngineProcess,
} from "../src/native-authority.js";

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
          { tag: 1, value: encodeVersionText(NATIVE_COMPONENT_VERSION) },
          { tag: 2, value: encodeVersionText(NATIVE_COMPONENT_VERSION) },
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

afterEach(() => {
  cli.runCliProcess.mockReset();
});

describe("private native authority host", () => {
  it("downgrades a self-asserted ready result and closes the socket", async () => {
    const socket = new SelfAttestingNativePeer();
    const port = createPrivateNativeAuthorityStatusPort(socket, {
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
    });

    await expect(port.status()).resolves.toEqual({
      state: "unavailable",
      reason: "peer_identity_unverified",
    });
    expect(socket.destroyed).toBe(true);
  });

  it("preserves a fixed native failure and closes the socket", async () => {
    const socket = new SelfAttestingNativePeer({
      healthFailure: NativeSafeFailureCode.keychainUnavailable,
    });
    const port = createPrivateNativeAuthorityStatusPort(socket, {
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
    });

    await expect(port.status()).resolves.toEqual({
      state: "unavailable",
      reason: "keychain_unavailable",
    });
    expect(socket.destroyed).toBe(true);
  });

  it("preserves cancellation and closes the socket", async () => {
    const socket = new SelfAttestingNativePeer({ respondToHealth: false });
    const port = createPrivateNativeAuthorityStatusPort(socket, {
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
    });
    const controller = new AbortController();

    const pending = port.status(controller.signal);
    controller.abort("SECRET_PRIVATE_HOST_ABORT_CANARY");
    const error = await pending.catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "AbortError",
      message: "The operation was aborted.",
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_");
    expect(socket.destroyed).toBe(true);
  });

  it("ignores fabricated trust arguments from untyped JavaScript", async () => {
    const callFromUntypedJavascript =
      createPrivateNativeAuthorityStatusPort as (
        duplex: Duplex,
        options: Record<string, unknown>,
        fabricatedTrust?: unknown,
      ) => NativeAuthorityStatusPort;

    for (const fabricatedTrust of [
      true,
      { trusted: true },
      { nativeAuthority: { state: "ready" } },
    ]) {
      const socket = new SelfAttestingNativePeer();
      const port = callFromUntypedJavascript(socket, {
        handshakeTimeoutMilliseconds: 100,
        requestTimeoutMilliseconds: 100,
        trusted: true,
      }, fabricatedTrust);

      await expect(port.status()).resolves.toEqual({
        state: "unavailable",
        reason: "peer_identity_unverified",
      });
      expect(socket.destroyed).toBe(true);
    }
  });

  it("closes an owned socket when process assembly fails", async () => {
    const socket = new SelfAttestingNativePeer();
    cli.runCliProcess.mockRejectedValueOnce(
      new Error("SECRET_PROCESS_ASSEMBLY_CANARY"),
    );

    await expect(runPrivateEngineProcess({ duplex: socket })).rejects.toThrow(
      "SECRET_PROCESS_ASSEMBLY_CANARY",
    );
    expect(socket.destroyed).toBe(true);
  });

  it("passes fixed unavailable status into process assembly without a socket", async () => {
    let received: NativeAuthorityStatusPort | undefined;
    cli.runCliProcess.mockImplementationOnce(async (port) => {
      received = port as NativeAuthorityStatusPort;
    });

    await runPrivateEngineProcess({ unavailableReason: "launcher_unavailable" });

    await expect(received?.status()).resolves.toEqual({
      state: "unavailable",
      reason: "launcher_unavailable",
    });
  });
});
