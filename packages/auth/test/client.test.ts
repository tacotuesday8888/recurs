import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as publicAuth from "../src/index.js";
import {
  NativeAuthorityClientUnavailableError,
  connectNativeAuthorityClient,
  type NativeAuthorityClientConnectOptions,
} from "../src/client.js";
import { FakeNativeAuthorityStatusPort } from "../src/fake.js";
import {
  NATIVE_FRAME_HEADER_BYTES,
  NATIVE_FRAME_MAGIC,
  NativeFrameDecoder,
  NativeKeychainStatusCode,
  NativeMessageType,
  NativeSafeFailureCode,
  decodeFieldTable,
  decodeU32,
  encodeBoolean,
  encodeFieldTable,
  encodeNativeFrame,
  encodeNonce,
  encodeU16,
  encodeVersionText,
} from "../src/index.js";
import type { NativeFrame } from "../src/index.js";
import type {
  NativeAuthorityStatus,
  NativeAuthorityUnavailableReason,
} from "@recurs/contracts";

const testNonce = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

function helloResult(
  frame: NativeFrame,
  nonce: Uint8Array,
  versions: {
    readonly launcher?: string;
    readonly broker?: string;
  } = {},
): Uint8Array {
  return encodeNativeFrame({
    type: NativeMessageType.helloResult,
    requestId: frame.requestId,
    payload: encodeFieldTable([
      { tag: 1, value: encodeVersionText(versions.launcher ?? "0.1.0") },
      { tag: 2, value: encodeVersionText(versions.broker ?? "0.1.0") },
      { tag: 3, value: encodeNonce(nonce) },
      { tag: 4, value: encodeBoolean(true) },
      { tag: 5, value: encodeBoolean(true) },
      { tag: 6, value: encodeVersionText("14.4") },
    ]),
  });
}

function healthResult(
  frame: NativeFrame,
  keychain: NativeKeychainStatusCode = NativeKeychainStatusCode.available,
): Uint8Array {
  return encodeNativeFrame({
    type: NativeMessageType.healthResult,
    requestId: frame.requestId,
    payload: encodeFieldTable([
      { tag: 1, value: encodeU16(keychain) },
      { tag: 2, value: encodeBoolean(true) },
    ]),
  });
}

function safeFailure(
  requestId: number,
  code: NativeSafeFailureCode,
): Uint8Array {
  return encodeNativeFrame({
    type: NativeMessageType.safeFailure,
    requestId,
    payload: encodeFieldTable([{ tag: 1, value: encodeU16(code) }]),
  });
}

function rawFrame(options: {
  readonly type: number;
  readonly requestId: number;
  readonly protocolVersion?: number;
  readonly payload?: Uint8Array;
}): Uint8Array {
  const payload = options.payload ?? encodeFieldTable([]);
  const bytes = new Uint8Array(NATIVE_FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, NATIVE_FRAME_MAGIC, false);
  view.setUint16(4, options.protocolVersion ?? 1, false);
  view.setUint16(6, options.type, false);
  view.setUint32(8, payload.byteLength, false);
  view.setUint32(12, options.requestId, false);
  bytes.set(payload, NATIVE_FRAME_HEADER_BYTES);
  return bytes;
}

class ScriptedDuplex extends Duplex {
  readonly requests: NativeFrame[] = [];
  readonly #decoder = new NativeFrameDecoder();
  readonly #onRequest: (frame: NativeFrame, socket: ScriptedDuplex) => void;

  constructor(
    onRequest: (frame: NativeFrame, socket: ScriptedDuplex) => void,
  ) {
    super();
    this.#onRequest = onRequest;
  }

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      for (const frame of this.#decoder.push(chunk)) {
        this.requests.push(frame);
        this.#onRequest(frame, this);
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  respond(bytes: Uint8Array): void {
    this.push(Buffer.from(bytes));
  }

  peerCloses(): void {
    this.push(null);
  }

  peerFails(error: Error): void {
    this.destroy(error);
  }
}

const connectOptions: NativeAuthorityClientConnectOptions = {
  engineVersion: "0.1.0",
  handshakeTimeoutMilliseconds: 100,
  requestTimeoutMilliseconds: 100,
  createNonce: () => testNonce,
};

describe("native authority client", () => {
  it("exports the injected-duplex connector without inherited-descriptor factories", () => {
    expect(publicAuth).toMatchObject({
      connectNativeAuthorityClient: expect.any(Function),
      FakeNativeAuthorityStatusPort: expect.any(Function),
    });
    expect(publicAuth).not.toHaveProperty(
      "createNativeAuthorityClientFromInheritedFd",
    );
    expect(publicAuth).not.toHaveProperty("takeInheritedNativeAuthoritySocket");
  });

  it("echoes a fresh nonce before exposing exact attestation and health", async () => {
    const socket = new ScriptedDuplex((frame, peer) => {
      if (frame.type === NativeMessageType.hello) {
        const fields = decodeFieldTable(frame.payload);
        expect(fields.map(({ tag }) => tag)).toEqual([1, 2]);
        expect(fields[1]?.value).toEqual(testNonce);
        peer.respond(helloResult(frame, testNonce));
      } else if (frame.type === NativeMessageType.health) {
        peer.respond(healthResult(frame));
      }
    });

    const client = await connectNativeAuthorityClient(socket, connectOptions);

    await expect(client.status()).resolves.toEqual({
      state: "ready",
      attestation: {
        protocolVersion: 1,
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        platform: "darwin",
        minimumMacosVersion: "14.4",
        productionSigned: true,
        persistentCredentials: true,
      },
      health: {
        keychain: "available",
        broker: "available",
        peerIdentity: "verified",
      },
    });
    expect(socket.requests.map(({ type }) => type)).toEqual([
      NativeMessageType.hello,
      NativeMessageType.health,
    ]);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(client))).toEqual([
      "constructor",
      "status",
      "close",
    ]);

    client.close();
  });

  it("interoperates with the bounded inherited-FD fake native peer", async () => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL(
          "../../native-engine/test/fixtures/fake-native-peer.mjs",
          import.meta.url,
        )),
        "--component-version",
        connectOptions.engineVersion,
      ],
      { stdio: ["ignore", "ignore", "pipe", "pipe"] },
    );
    const inheritedPipe = child.stdio[3];
    if (!(inheritedPipe instanceof Duplex)) {
      child.kill();
      throw new Error("test fixture did not expose a duplex pipe");
    }

    try {
      const client = await connectNativeAuthorityClient(
        inheritedPipe,
        connectOptions,
      );
      await expect(client.status()).resolves.toMatchObject({
        state: "ready",
        health: {
          keychain: "available",
          broker: "available",
          peerIdentity: "verified",
        },
      });
      client.close();
    } finally {
      child.kill();
    }
  });

  it("correlates simultaneous health responses by unique request ID", async () => {
    const healthRequests: NativeFrame[] = [];
    const socket = new ScriptedDuplex((frame, peer) => {
      if (frame.type === NativeMessageType.hello) {
        peer.respond(helloResult(frame, testNonce));
        return;
      }
      healthRequests.push(frame);
      if (healthRequests.length === 2) {
        peer.respond(
          healthResult(
            healthRequests[1] as NativeFrame,
            NativeKeychainStatusCode.locked,
          ),
        );
        peer.respond(healthResult(healthRequests[0] as NativeFrame));
      }
    });
    const client = await connectNativeAuthorityClient(socket, connectOptions);

    const first = client.status();
    const second = client.status();

    await expect(first).resolves.toMatchObject({
      state: "ready",
      health: { keychain: "available" },
    });
    await expect(second).resolves.toMatchObject({
      state: "ready",
      health: { keychain: "locked" },
    });
    expect(new Set(healthRequests.map(({ requestId }) => requestId)).size).toBe(2);
    client.close();
  });

  it("fails closed before exceeding the bounded in-flight request set", async () => {
    const socket = new ScriptedDuplex((frame, peer) => {
      if (frame.type === NativeMessageType.hello) {
        peer.respond(helloResult(frame, testNonce));
      }
    });
    const client = await connectNativeAuthorityClient(socket, {
      ...connectOptions,
      requestTimeoutMilliseconds: 1_000,
    });

    const pending = Array.from({ length: 65 }, () => client.status());
    const healthRequestCount = socket.requests.filter(
      ({ type }) => type === NativeMessageType.health,
    ).length;
    client.close();
    const statuses = await Promise.all(pending);

    expect(healthRequestCount).toBe(64);
    expect(statuses).toHaveLength(65);
    expect(statuses.every((status) =>
      status.state === "unavailable" && status.reason === "protocol_mismatch"
    )).toBe(true);
    expect(socket.destroyed).toBe(true);
  });

  it("fails closed when the handshake nonce is not echoed exactly", async () => {
    const socket = new ScriptedDuplex((frame, peer) => {
      peer.respond(helloResult(frame, new Uint8Array(32).fill(99)));
    });

    await expect(
      connectNativeAuthorityClient(socket, connectOptions),
    ).rejects.toMatchObject({
      name: "NativeAuthorityClientUnavailableError",
      reason: "protocol_mismatch",
      message: "Native authority is unavailable.",
    });
    expect(socket.destroyed).toBe(true);
  });

  it.each(["launcher", "broker"] as const)(
    "requires the %s version to exactly match the engine without reflecting it",
    async (component) => {
      const canary = `SECRET_${component.toUpperCase()}_VERSION_CANARY`;
      const socket = new ScriptedDuplex((frame, peer) => {
        peer.respond(helloResult(frame, testNonce, { [component]: canary }));
      });

      const error = await connectNativeAuthorityClient(
        socket,
        connectOptions,
      ).catch((caught: unknown) => caught);

      expect(error).toMatchObject({
        name: "NativeAuthorityClientUnavailableError",
        reason: "protocol_mismatch",
        message: "Native authority is unavailable.",
      });
      expect(JSON.stringify(error)).not.toContain(canary);
      expect(socket.destroyed).toBe(true);
    },
  );

  it("rejects a duplicate response delivered with the terminal handshake", async () => {
    const socket = new ScriptedDuplex((frame, peer) => {
      const response = helloResult(frame, testNonce);
      peer.respond(Buffer.concat([response, response]));
    });

    await expect(
      connectNativeAuthorityClient(socket, connectOptions),
    ).rejects.toMatchObject({
      name: "NativeAuthorityClientUnavailableError",
      reason: "protocol_mismatch",
    });
    expect(socket.destroyed).toBe(true);
  });

  it.each([
    ["wrong protocol version", { protocolVersion: 2, type: NativeMessageType.helloResult }],
    ["unknown message type", { type: 77 }],
  ] as const)("maps a %s handshake to a fixed protocol failure", async (_name, invalid) => {
    const socket = new ScriptedDuplex((frame, peer) => {
      peer.respond(rawFrame({
        requestId: frame.requestId,
        ...invalid,
      }));
    });

    const error = await connectNativeAuthorityClient(socket, connectOptions).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(NativeAuthorityClientUnavailableError);
    expect(error).toMatchObject({ reason: "protocol_mismatch" });
    expect(JSON.stringify(error)).not.toMatch(/77|version|payload|canary/iu);
    expect(socket.destroyed).toBe(true);
  });

  it("rejects duplicate responses and every response after terminal", async () => {
    let duplicate: Uint8Array | undefined;
    const socket = new ScriptedDuplex((frame, peer) => {
      if (frame.type === NativeMessageType.hello) {
        peer.respond(helloResult(frame, testNonce));
        return;
      }
      duplicate = healthResult(frame);
      peer.respond(duplicate);
    });
    const client = await connectNativeAuthorityClient(socket, connectOptions);

    await expect(client.status()).resolves.toMatchObject({ state: "ready" });
    socket.respond(duplicate as Uint8Array);

    await expect(client.status()).resolves.toEqual({
      state: "unavailable",
      reason: "protocol_mismatch",
    });
    expect(socket.destroyed).toBe(true);
  });

  it("makes duplicate rejection authoritative over an earlier safe failure", async () => {
    const socket = new ScriptedDuplex((frame, peer) => {
      if (frame.type === NativeMessageType.hello) {
        peer.respond(helloResult(frame, testNonce));
        return;
      }
      const response = safeFailure(
        frame.requestId,
        NativeSafeFailureCode.keychainUnavailable,
      );
      peer.respond(Buffer.concat([response, response]));
    });
    const client = await connectNativeAuthorityClient(socket, connectOptions);

    await expect(client.status()).resolves.toEqual({
      state: "unavailable",
      reason: "protocol_mismatch",
    });
    expect(socket.destroyed).toBe(true);
  });

  it("rejects an unknown response ID", async () => {
    const socket = new ScriptedDuplex((frame, peer) => {
      if (frame.type === NativeMessageType.hello) {
        peer.respond(helloResult(frame, testNonce));
      }
    });
    const client = await connectNativeAuthorityClient(socket, connectOptions);

    const pending = client.status();
    socket.respond(healthResult({
      type: NativeMessageType.health,
      requestId: 900,
      payload: new Uint8Array(),
    }));

    await expect(pending).resolves.toEqual({
      state: "unavailable",
      reason: "protocol_mismatch",
    });
    expect(socket.destroyed).toBe(true);
  });

  it("maps peer close and transport error text to broker_unavailable", async () => {
    const canary = "CREDENTIAL_PAYLOAD_CANARY";
    const sockets = [
      new ScriptedDuplex((frame, peer) => {
        if (frame.type === NativeMessageType.hello) {
          peer.respond(helloResult(frame, testNonce));
        } else {
          peer.peerCloses();
        }
      }),
      new ScriptedDuplex((frame, peer) => {
        if (frame.type === NativeMessageType.hello) {
          peer.respond(helloResult(frame, testNonce));
        } else {
          peer.peerFails(new Error(canary));
        }
      }),
    ];

    for (const socket of sockets) {
      const client = await connectNativeAuthorityClient(socket, connectOptions);
      const status = await client.status();
      expect(status).toEqual({
        state: "unavailable",
        reason: "broker_unavailable",
      });
      expect(JSON.stringify(status)).not.toContain(canary);
    }
  });

  it("times out with a fixed unavailable status and closes the transport", async () => {
    const socket = new ScriptedDuplex((frame, peer) => {
      if (frame.type === NativeMessageType.hello) {
        peer.respond(helloResult(frame, testNonce));
      }
    });
    const client = await connectNativeAuthorityClient(socket, {
      ...connectOptions,
      requestTimeoutMilliseconds: 5,
    });

    await expect(client.status()).resolves.toEqual({
      state: "unavailable",
      reason: "broker_unavailable",
    });
    expect(socket.destroyed).toBe(true);
  });

  it("does not reflect malformed response payload bytes into status", async () => {
    const canary = "SECRET_NATIVE_PAYLOAD_CANARY";
    const socket = new ScriptedDuplex((frame, peer) => {
      if (frame.type === NativeMessageType.hello) {
        peer.respond(helloResult(frame, testNonce));
      } else {
        peer.respond(encodeNativeFrame({
          type: NativeMessageType.healthResult,
          requestId: frame.requestId,
          payload: new TextEncoder().encode(canary),
        }));
      }
    });
    const client = await connectNativeAuthorityClient(socket, connectOptions);

    const status = await client.status();

    expect(status).toEqual({
      state: "unavailable",
      reason: "protocol_mismatch",
    });
    expect(JSON.stringify(status)).not.toContain(canary);
    expect(socket.destroyed).toBe(true);
  });

  it("fails cleanly when timeout terminalizes a truncated buffered frame", async () => {
    const canary = "SECRET_TRUNCATED_FRAME_CANARY";
    const socket = new ScriptedDuplex((frame, peer) => {
      if (frame.type === NativeMessageType.hello) {
        peer.respond(helloResult(frame, testNonce));
      } else {
        const response = rawFrame({
          type: NativeMessageType.healthResult,
          requestId: frame.requestId,
          payload: new TextEncoder().encode(canary),
        });
        peer.respond(response.subarray(0, response.byteLength - 1));
      }
    });
    const client = await connectNativeAuthorityClient(socket, {
      ...connectOptions,
      requestTimeoutMilliseconds: 5,
    });

    const status = await client.status();

    expect(status).toEqual({
      state: "unavailable",
      reason: "broker_unavailable",
    });
    expect(JSON.stringify(status)).not.toContain(canary);
    expect(socket.destroyed).toBe(true);
  });

  it.each([
    [NativeSafeFailureCode.unsupportedPlatform, "unsupported_platform"],
    [NativeSafeFailureCode.unsupportedOsVersion, "unsupported_os_version"],
    [NativeSafeFailureCode.launcherUnavailable, "launcher_unavailable"],
    [NativeSafeFailureCode.brokerUnavailable, "broker_unavailable"],
    [NativeSafeFailureCode.protocolMismatch, "protocol_mismatch"],
    [NativeSafeFailureCode.peerIdentityUnverified, "peer_identity_unverified"],
    [NativeSafeFailureCode.productionSigningRequired, "production_signing_required"],
    [NativeSafeFailureCode.keychainUnavailable, "keychain_unavailable"],
    [NativeSafeFailureCode.unsupportedOperation, "unsupported_operation"],
  ] as const)(
    "maps safe failure %s only to %s",
    async (code, reason) => {
      const socket = new ScriptedDuplex((frame, peer) => {
        if (frame.type === NativeMessageType.hello) {
          peer.respond(helloResult(frame, testNonce));
        } else {
          peer.respond(safeFailure(frame.requestId, code));
        }
      });
      const client = await connectNativeAuthorityClient(socket, connectOptions);

      await expect(client.status()).resolves.toEqual({
        state: "unavailable",
        reason,
      });
      client.close();
    },
  );

  it("sends one correlated cancel and rejects the operation with AbortError", async () => {
    const requests: NativeFrame[] = [];
    const socket = new ScriptedDuplex((frame, peer) => {
      requests.push(frame);
      if (frame.type === NativeMessageType.hello) {
        peer.respond(helloResult(frame, testNonce));
      }
    });
    const client = await connectNativeAuthorityClient(socket, connectOptions);
    const controller = new AbortController();
    const pending = client.status(controller.signal);
    controller.abort("SECRET_ABORT_CANARY");

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({ name: "AbortError", message: "The operation was aborted." });
    expect(JSON.stringify(error)).not.toContain("SECRET_ABORT_CANARY");
    expect(requests.map(({ type }) => type)).toEqual([
      NativeMessageType.hello,
      NativeMessageType.health,
      NativeMessageType.cancel,
    ]);
    expect(new Set(requests.map(({ requestId }) => requestId)).size).toBe(3);
    const cancelFields = decodeFieldTable(requests[2]?.payload ?? new Uint8Array());
    expect(decodeU32(cancelFields[0]?.value ?? new Uint8Array())).toBe(
      requests[1]?.requestId,
    );
    client.close();
  });

  it("does not write when cancellation is already requested", async () => {
    const socket = new ScriptedDuplex((frame, peer) => {
      if (frame.type === NativeMessageType.hello) {
        peer.respond(helloResult(frame, testNonce));
      }
    });
    const client = await connectNativeAuthorityClient(socket, connectOptions);
    const controller = new AbortController();
    controller.abort();

    await expect(client.status(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
      message: "The operation was aborted.",
    });
    expect(socket.requests).toHaveLength(1);
    client.close();
  });

  it("maps hostile cancellation signal access without reflecting its error", async () => {
    const canary = "SECRET_SIGNAL_GETTER_CANARY";
    const socket = new ScriptedDuplex((frame, peer) => {
      if (frame.type === NativeMessageType.hello) {
        peer.respond(helloResult(frame, testNonce));
      }
    });
    const client = await connectNativeAuthorityClient(socket, connectOptions);
    const signal = Object.defineProperty({}, "aborted", {
      get() {
        throw new Error(canary);
      },
    }) as AbortSignal;

    const result = await client.status(signal).catch((error: unknown) => error);

    expect(result).toEqual({
      state: "unavailable",
      reason: "protocol_mismatch",
    });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(socket.destroyed).toBe(true);
  });

  it("rejects a response to a cancelled terminal request", async () => {
    let cancelledHealth: NativeFrame | undefined;
    const socket = new ScriptedDuplex((frame, peer) => {
      if (frame.type === NativeMessageType.hello) {
        peer.respond(helloResult(frame, testNonce));
      } else if (frame.type === NativeMessageType.health) {
        cancelledHealth = frame;
      }
    });
    const client = await connectNativeAuthorityClient(socket, connectOptions);
    const controller = new AbortController();
    const pending = client.status(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    socket.respond(healthResult(cancelledHealth as NativeFrame));

    await expect(client.status()).resolves.toEqual({
      state: "unavailable",
      reason: "protocol_mismatch",
    });
    expect(socket.destroyed).toBe(true);
  });

  it("maps nonce-generator exceptions without exposing injected error text", async () => {
    const socket = new ScriptedDuplex(() => {});

    const error = await connectNativeAuthorityClient(socket, {
      ...connectOptions,
      handshakeTimeoutMilliseconds: 5,
      createNonce: () => {
        throw new Error("SECRET_NONCE_CANARY");
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "NativeAuthorityClientUnavailableError",
      message: "Native authority is unavailable.",
      reason: "protocol_mismatch",
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_NONCE_CANARY");
    expect(socket.destroyed).toBe(true);
  });

  it("closes after a handshake timeout with broker_unavailable", async () => {
    const socket = new ScriptedDuplex(() => {});

    await expect(connectNativeAuthorityClient(socket, {
      ...connectOptions,
      handshakeTimeoutMilliseconds: 5,
    })).rejects.toMatchObject({
      name: "NativeAuthorityClientUnavailableError",
      message: "Native authority is unavailable.",
      reason: "broker_unavailable",
    });
    expect(socket.destroyed).toBe(true);
  });

  it("cancels an in-flight handshake without exposing the abort reason", async () => {
    const controller = new AbortController();
    const socket = new ScriptedDuplex(() => {
      queueMicrotask(() => {
        controller.abort("SECRET_HANDSHAKE_ABORT_CANARY");
      });
    });

    const error = await connectNativeAuthorityClient(socket, {
      ...connectOptions,
      signal: controller.signal,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DOMException);
    expect(error).toMatchObject({
      name: "AbortError",
      message: "The operation was aborted.",
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_HANDSHAKE_ABORT_CANARY");
    expect(socket.destroyed).toBe(true);
  });

  it("closes idempotently and never writes another request", async () => {
    const socket = new ScriptedDuplex((frame, peer) => {
      peer.respond(helloResult(frame, testNonce));
    });
    const client = await connectNativeAuthorityClient(socket, connectOptions);

    client.close();
    client.close();

    await expect(client.status()).resolves.toEqual({
      state: "unavailable",
      reason: "broker_unavailable",
    });
    expect(socket.requests).toHaveLength(1);
    expect(socket.destroyed).toBe(true);
  });

});

describe("fake native authority status port", () => {
  const ready: NativeAuthorityStatus = {
    state: "ready",
    attestation: {
      protocolVersion: 1,
      launcherVersion: "0.1.0",
      brokerVersion: "0.1.0",
      platform: "darwin",
      minimumMacosVersion: "14.4",
      productionSigned: true,
      persistentCredentials: true,
    },
    health: {
      keychain: "available",
      broker: "available",
      peerIdentity: "verified",
    },
  };

  it("returns a deeply frozen structural clone with no injected fields", async () => {
    const injected = {
      ...ready,
      secretCanary: "SECRET_FAKE_CANARY",
    } as NativeAuthorityStatus;
    const port = new FakeNativeAuthorityStatusPort(injected);

    const status = await port.status();

    expect(status).toEqual(ready);
    expect(status).not.toBe(injected);
    expect(Object.isFrozen(status)).toBe(true);
    if (status.state === "ready") {
      expect(Object.isFrozen(status.attestation)).toBe(true);
      expect(Object.isFrozen(status.health)).toBe(true);
    }
    expect(JSON.stringify(status)).not.toContain("SECRET_FAKE_CANARY");
  });

  it.each([
    "unsupported_platform",
    "unsupported_os_version",
    "launcher_unavailable",
    "broker_unavailable",
    "protocol_mismatch",
    "peer_identity_unverified",
    "production_signing_required",
    "keychain_unavailable",
    "unsupported_operation",
  ] satisfies readonly NativeAuthorityUnavailableReason[])(
    "returns the fixed unavailable status %s",
    async (reason) => {
      const port = new FakeNativeAuthorityStatusPort({
        state: "unavailable",
        reason,
      });
      await expect(port.status()).resolves.toEqual({
        state: "unavailable",
        reason,
      });
    },
  );

  it("honors an already-aborted signal without serializing its reason", async () => {
    const port = new FakeNativeAuthorityStatusPort(ready);
    const controller = new AbortController();
    controller.abort("SECRET_FAKE_ABORT_CANARY");

    const error = await port.status(controller.signal).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "AbortError",
      message: "The operation was aborted.",
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_FAKE_ABORT_CANARY");
  });
});
