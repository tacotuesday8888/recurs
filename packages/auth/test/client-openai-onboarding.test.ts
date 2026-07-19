import { Duplex } from "node:stream";

import {
  NativeFrameDecoder,
  NativeMessageType,
  NativeOpenAIOnboardingFailureCode,
  NativeSafeFailureCode,
  connectNativeAuthorityClient,
  decodeFieldTable,
  decodeOpenAIOnboardingRequest,
  decodeU32,
  encodeBoolean,
  encodeFieldTable,
  encodeHello,
  encodeNativeFrame,
  encodeNonce,
  encodeOpenAIOnboardingAborted,
  encodeOpenAIOnboardingBegun,
  encodeOpenAIOnboardingCatalogPage,
  encodeOpenAIOnboardingCommitted,
  encodeOpenAIOnboardingFailure,
  encodeOpenAIOnboardingReconciliation,
  encodeU16,
  encodeVersionText,
  type NativeAuthorityClientConnectOptions,
  type NativeFrame,
  type NativeOpenAIOnboardingRequest,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const testNonce = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const connectionId = "01234567-89ab-cdef-8123-456789abcdef";
const fingerprint = `sha256:${"d".repeat(64)}`;
const catalogRequestId = "catalog-request-1";

const connectOptions: NativeAuthorityClientConnectOptions = {
  engineVersion: "0.1.0",
  handshakeTimeoutMilliseconds: 100,
  requestTimeoutMilliseconds: 100,
  onboardingBeginTimeoutMilliseconds: 100,
  onboardingControlTimeoutMilliseconds: 100,
  createNonce: () => testNonce,
};

const failureExpectations = [
  [NativeOpenAIOnboardingFailureCode.invalidRequest, "invalid_request", "The native OpenAI onboarding request is invalid."],
  [NativeOpenAIOnboardingFailureCode.sessionNotReady, "session_not_ready", "Native OpenAI onboarding is not ready for that operation."],
  [NativeOpenAIOnboardingFailureCode.busy, "busy", "Native OpenAI onboarding is busy."],
  [NativeOpenAIOnboardingFailureCode.cancelled, "cancelled", "Native OpenAI onboarding was cancelled."],
  [NativeOpenAIOnboardingFailureCode.expired, "expired", "Native OpenAI onboarding expired."],
  [NativeOpenAIOnboardingFailureCode.verificationFailed, "verification_failed", "OpenAI credential verification failed."],
  [NativeOpenAIOnboardingFailureCode.invalidModel, "invalid_model", "The selected OpenAI model is invalid."],
  [NativeOpenAIOnboardingFailureCode.noCompatibleModels, "no_compatible_models", "No compatible OpenAI models are available."],
  [NativeOpenAIOnboardingFailureCode.commitFailed, "commit_failed", "The OpenAI connection could not be committed."],
  [NativeOpenAIOnboardingFailureCode.credentialStoreUnavailable, "credential_store_unavailable", "Secure credential storage is unavailable."],
  [NativeOpenAIOnboardingFailureCode.cleanupFailed, "cleanup_failed", "Native OpenAI onboarding cleanup failed."],
  [NativeOpenAIOnboardingFailureCode.reconciliationRequired, "reconciliation_required", "The OpenAI connection requires reconciliation."],
  [NativeOpenAIOnboardingFailureCode.authorityUnavailable, "authority_unavailable", "Native OpenAI onboarding authority is unavailable."],
  [NativeOpenAIOnboardingFailureCode.operationUnavailable, "operation_unavailable", "Native OpenAI onboarding is unavailable for this invocation."],
] as const;

class ScriptedOnboardingPeer extends Duplex {
  readonly requests: NativeFrame[] = [];
  readonly #decoder = new NativeFrameDecoder();
  readonly #onRequest: (
    frame: NativeFrame,
    socket: ScriptedOnboardingPeer,
  ) => void;
  #holdOnboardingWrite: boolean;
  #holdCancelWrite: boolean;
  #heldWriteCallback: ((error?: Error | null) => void) | undefined;
  destroyCalls = 0;

  constructor(
    onRequest: (
      frame: NativeFrame,
      socket: ScriptedOnboardingPeer,
    ) => void,
    options: {
      readonly holdOnboardingWrite?: boolean;
      readonly holdCancelWrite?: boolean;
    } = {},
  ) {
    super();
    this.#onRequest = onRequest;
    this.#holdOnboardingWrite = options.holdOnboardingWrite ?? false;
    this.#holdCancelWrite = options.holdCancelWrite ?? false;
  }

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    try {
      const frames = this.#decoder.push(chunk);
      for (const frame of frames) {
        this.requests.push(frame);
        this.#onRequest(frame, this);
      }
      if (
        (this.#holdOnboardingWrite && frames.some(({ type }) =>
          type === NativeMessageType.openAIOnboardingRequest
        )) ||
        (this.#holdCancelWrite && frames.some(({ type }) =>
          type === NativeMessageType.cancel
        ))
      ) {
        this.#holdOnboardingWrite = false;
        this.#holdCancelWrite = false;
        this.#heldWriteCallback = callback;
        return;
      }
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    this.destroyCalls += 1;
    callback(error);
  }

  respond(bytes: Uint8Array): void {
    this.push(Buffer.from(bytes));
  }

  peerCloses(): void {
    this.push(null);
  }

  releaseHeldWrite(): void {
    const callback = this.#heldWriteCallback;
    this.#heldWriteCallback = undefined;
    callback?.();
  }
}

function helloResult(frame: NativeFrame): Uint8Array {
  return encodeNativeFrame({
    type: NativeMessageType.helloResult,
    requestId: frame.requestId,
    payload: encodeFieldTable([
      { tag: 1, value: encodeVersionText("0.1.0") },
      { tag: 2, value: encodeVersionText("0.1.0") },
      { tag: 3, value: encodeNonce(testNonce) },
      { tag: 4, value: encodeBoolean(true) },
      { tag: 5, value: encodeBoolean(true) },
      { tag: 6, value: encodeVersionText("14.4") },
    ]),
  });
}

function healthResult(frame: NativeFrame): Uint8Array {
  return encodeNativeFrame({
    type: NativeMessageType.healthResult,
    requestId: frame.requestId,
    payload: encodeFieldTable([
      { tag: 1, value: encodeU16(1) },
      { tag: 2, value: encodeBoolean(true) },
    ]),
  });
}

function onboardingRequest(frame: NativeFrame): NativeOpenAIOnboardingRequest {
  expect(frame.type).toBe(NativeMessageType.openAIOnboardingRequest);
  return decodeOpenAIOnboardingRequest(frame);
}

function respondToHello(frame: NativeFrame, peer: ScriptedOnboardingPeer): boolean {
  if (frame.type !== NativeMessageType.hello) return false;
  peer.respond(helloResult(frame));
  return true;
}

describe("native OpenAI onboarding client", () => {
  it("shares one handshake across health and a coherent paginated commit", async () => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      if (respondToHello(frame, socket)) return;
      if (frame.type === NativeMessageType.health) {
        socket.respond(healthResult(frame));
        return;
      }
      const request = onboardingRequest(frame);
      switch (request.kind) {
        case "begin":
          socket.respond(encodeOpenAIOnboardingBegun(frame.requestId, {
            connectionId,
            credentialIdentityFingerprint: fingerprint,
          }));
          break;
        case "verify":
          socket.respond(encodeOpenAIOnboardingCatalogPage(frame.requestId, {
            cursor: 0,
            totalModelCount: 3,
            nextCursor: 2,
            catalogRequestId,
            modelIds: ["gpt-5.1", "gpt-5.2"],
          }));
          break;
        case "catalog_page":
          expect(request.cursor).toBe(2);
          socket.respond(encodeOpenAIOnboardingCatalogPage(frame.requestId, {
            cursor: 2,
            totalModelCount: 3,
            nextCursor: null,
            catalogRequestId,
            modelIds: ["gpt-5.3"],
          }));
          break;
        case "finalize":
          expect(request.exactModelId).toBe("gpt-5.3");
          socket.respond(encodeOpenAIOnboardingCommitted(frame.requestId, {
            connectionId,
            selectedModelId: "gpt-5.3",
            verifiedModelCount: 3,
            catalogRequestId,
          }));
          break;
        default:
          throw new Error("unexpected onboarding request");
      }
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);

    await expect(client.status()).resolves.toMatchObject({ state: "ready" });
    await expect(client.beginOpenAIOnboarding()).resolves.toEqual({
      state: "succeeded",
      value: { connectionId, credentialIdentityFingerprint: fingerprint },
    });
    await expect(client.verifyOpenAIOnboarding()).resolves.toEqual({
      state: "succeeded",
      value: {
        cursor: 0,
        totalModelCount: 3,
        nextCursor: 2,
        modelIds: ["gpt-5.1", "gpt-5.2"],
      },
    });
    await expect(client.openAIOnboardingCatalogPage(2)).resolves.toEqual({
      state: "succeeded",
      value: {
        cursor: 2,
        totalModelCount: 3,
        nextCursor: null,
        modelIds: ["gpt-5.3"],
      },
    });
    await expect(client.finalizeOpenAIOnboarding("gpt-5.3")).resolves.toEqual({
      state: "succeeded",
      value: {
        connectionId,
        selectedModelId: "gpt-5.3",
        verifiedModelCount: 3,
      },
    });

    expect(peer.requests.map(({ type }) => type)).toEqual([
      NativeMessageType.hello,
      NativeMessageType.health,
      ...Array<NativeMessageType>(4).fill(
        NativeMessageType.openAIOnboardingRequest,
      ),
    ]);
    expect(peer.requests.map(({ requestId }) => requestId)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(peer.destroyed).toBe(false);
    client.close();
    expect(peer.destroyCalls).toBe(1);
  });

  it("supports abort after begin and makes the sequence terminal", async () => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      if (respondToHello(frame, socket)) return;
      const request = onboardingRequest(frame);
      if (request.kind === "begin") {
        socket.respond(encodeOpenAIOnboardingBegun(frame.requestId, {
          connectionId,
          credentialIdentityFingerprint: fingerprint,
        }));
      } else if (request.kind === "abort") {
        socket.respond(encodeOpenAIOnboardingAborted(frame.requestId));
      }
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);

    await client.beginOpenAIOnboarding();
    await expect(client.abortOpenAIOnboarding()).resolves.toEqual({
      state: "succeeded",
      value: { aborted: true },
    });
    await expect(client.beginOpenAIOnboarding()).resolves.toEqual({
      state: "failed",
      code: "invalid_request",
      safeMessage: "The native OpenAI onboarding request is invalid.",
    });
    expect(peer.requests).toHaveLength(3);
    expect(peer.destroyed).toBe(true);
  });

  it("allows redacted reconciliation only on a fresh client and then terminalizes onboarding", async () => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      if (respondToHello(frame, socket)) return;
      expect(onboardingRequest(frame)).toEqual({
        kind: "reconcile",
        connectionId,
        credentialIdentityFingerprint: fingerprint,
      });
      socket.respond(encodeOpenAIOnboardingReconciliation(
        frame.requestId,
        "ready_openai",
      ));
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);

    await expect(client.reconcileOpenAIActivation(
      connectionId,
      fingerprint,
    )).resolves.toEqual({
      state: "succeeded",
      value: { status: "ready_openai" },
    });
    await expect(client.status()).resolves.toEqual({
      state: "unavailable",
      reason: "protocol_mismatch",
    });
    expect(peer.requests).toHaveLength(2);
    expect(peer.destroyed).toBe(true);
  });

  it.each(failureExpectations)(
    "maps native onboarding failure %s to fixed %s without hostile text",
    async (wireCode, code, safeMessage) => {
      const canary = "SECRET_HOSTILE_NATIVE_ERROR_CANARY";
      const peer = new ScriptedOnboardingPeer((frame, socket) => {
        if (respondToHello(frame, socket)) return;
        socket.respond(Buffer.concat([
          encodeOpenAIOnboardingFailure(frame.requestId, wireCode),
          Buffer.from(canary),
        ]).subarray(0, encodeOpenAIOnboardingFailure(
          frame.requestId,
          wireCode,
        ).byteLength));
      });
      const client = await connectNativeAuthorityClient(peer, connectOptions);

      const outcome = await client.beginOpenAIOnboarding();

      expect(outcome).toEqual({
        state: "failed",
        code,
        safeMessage,
      });
      expect(JSON.stringify(outcome)).not.toContain(canary);
      expect(peer.destroyed).toBe(true);
    },
  );

  it.each([
    ["verify before begin", async (client: Awaited<ReturnType<typeof connectNativeAuthorityClient>>) => client.verifyOpenAIOnboarding()],
    ["page before begin", async (client: Awaited<ReturnType<typeof connectNativeAuthorityClient>>) => client.openAIOnboardingCatalogPage(0)],
    ["finalize before begin", async (client: Awaited<ReturnType<typeof connectNativeAuthorityClient>>) => client.finalizeOpenAIOnboarding("gpt-5.1")],
    ["abort before begin", async (client: Awaited<ReturnType<typeof connectNativeAuthorityClient>>) => client.abortOpenAIOnboarding()],
  ] as const)("fails closed without a write for %s", async (_name, operation) => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      respondToHello(frame, socket);
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);

    await expect(operation(client)).resolves.toMatchObject({
      state: "failed",
      code: "invalid_request",
    });
    expect(peer.requests).toHaveLength(1);
    expect(peer.destroyed).toBe(true);
  });

  it("rejects a non-progressing page request locally without writing it", async () => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      if (respondToHello(frame, socket)) return;
      const request = onboardingRequest(frame);
      if (request.kind === "begin") {
        socket.respond(encodeOpenAIOnboardingBegun(frame.requestId, {
          connectionId,
          credentialIdentityFingerprint: fingerprint,
        }));
      } else {
        socket.respond(encodeOpenAIOnboardingCatalogPage(frame.requestId, {
          cursor: 0,
          totalModelCount: 3,
          nextCursor: 2,
          catalogRequestId,
          modelIds: ["gpt-5.1", "gpt-5.2"],
        }));
      }
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);
    await client.beginOpenAIOnboarding();
    await client.verifyOpenAIOnboarding();

    await expect(client.openAIOnboardingCatalogPage(1)).resolves.toMatchObject({
      state: "failed",
      code: "invalid_request",
    });
    expect(peer.requests).toHaveLength(3);
    expect(peer.destroyed).toBe(true);
  });

  it("fails closed when a syntactically valid later page changes catalog identity", async () => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      if (respondToHello(frame, socket)) return;
      const request = onboardingRequest(frame);
      if (request.kind === "begin") {
        socket.respond(encodeOpenAIOnboardingBegun(frame.requestId, {
          connectionId,
          credentialIdentityFingerprint: fingerprint,
        }));
      } else if (request.kind === "verify") {
        socket.respond(encodeOpenAIOnboardingCatalogPage(frame.requestId, {
          cursor: 0,
          totalModelCount: 3,
          nextCursor: 2,
          catalogRequestId,
          modelIds: ["gpt-5.1", "gpt-5.2"],
        }));
      } else {
        socket.respond(encodeOpenAIOnboardingCatalogPage(frame.requestId, {
          cursor: 2,
          totalModelCount: 3,
          nextCursor: null,
          catalogRequestId: "changed-catalog",
          modelIds: ["gpt-5.3"],
        }));
      }
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);
    await client.beginOpenAIOnboarding();
    await client.verifyOpenAIOnboarding();

    await expect(client.openAIOnboardingCatalogPage(2)).resolves.toMatchObject({
      state: "failed",
      code: "authority_unavailable",
    });
    expect(peer.destroyed).toBe(true);
  });

  it("fails closed when a commit receipt does not match the selected model", async () => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      if (respondToHello(frame, socket)) return;
      const request = onboardingRequest(frame);
      switch (request.kind) {
        case "begin":
          socket.respond(encodeOpenAIOnboardingBegun(frame.requestId, {
            connectionId,
            credentialIdentityFingerprint: fingerprint,
          }));
          break;
        case "verify":
          socket.respond(encodeOpenAIOnboardingCatalogPage(frame.requestId, {
            cursor: 0,
            totalModelCount: 1,
            nextCursor: null,
            catalogRequestId,
            modelIds: ["gpt-5.1"],
          }));
          break;
        case "finalize":
          socket.respond(encodeOpenAIOnboardingCommitted(frame.requestId, {
            connectionId,
            selectedModelId: "gpt-hostile",
            verifiedModelCount: 1,
            catalogRequestId,
          }));
          break;
        default:
          throw new Error("unexpected request");
      }
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);
    await client.beginOpenAIOnboarding();
    await client.verifyOpenAIOnboarding();

    await expect(client.finalizeOpenAIOnboarding("gpt-5.1")).resolves.toMatchObject({
      state: "failed",
      code: "authority_unavailable",
    });
    expect(peer.destroyed).toBe(true);
  });

  it("rejects a pre-aborted begin without writing or consuming the sequence", async () => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      if (respondToHello(frame, socket)) return;
      socket.respond(encodeOpenAIOnboardingBegun(frame.requestId, {
        connectionId,
        credentialIdentityFingerprint: fingerprint,
      }));
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);
    const controller = new AbortController();
    controller.abort("SECRET_PRE_ABORT_CANARY");

    const error = await client.beginOpenAIOnboarding(controller.signal).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      name: "AbortError",
      message: "The operation was aborted.",
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_");
    expect(peer.requests).toHaveLength(1);
    expect(peer.destroyed).toBe(false);
    await expect(client.beginOpenAIOnboarding()).resolves.toMatchObject({
      state: "succeeded",
    });
    client.close();
  });

  it("fails closed without exposing a prototype-forged AbortSignal getter", async () => {
    const canary = "SECRET_ABORT_SIGNAL_GETTER_CANARY";
    const signal = Object.defineProperty(
      Object.create(AbortSignal.prototype) as AbortSignal,
      "aborted",
      {
        get() {
          throw new Error(canary);
        },
      },
    );

    for (const operation of ["status", "onboarding"] as const) {
      const peer = new ScriptedOnboardingPeer((frame, socket) => {
        respondToHello(frame, socket);
      });
      const client = await connectNativeAuthorityClient(peer, connectOptions);
      const result = operation === "status"
        ? await client.status(signal)
        : await client.beginOpenAIOnboarding(signal);

      expect(result).toMatchObject(
        operation === "status"
          ? { state: "unavailable", reason: "protocol_mismatch" }
          : { state: "failed", code: "invalid_request" },
      );
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(peer.requests).toHaveLength(1);
      expect(peer.destroyed).toBe(true);
    }
  });

  it("uses captured EventTarget methods when a real signal is shadowed", async () => {
    const canary = "SECRET_SHADOWED_SIGNAL_METHOD_CANARY";
    const controller = new AbortController();
    Object.defineProperties(controller.signal, {
      addEventListener: {
        get() {
          throw new Error(canary);
        },
      },
      removeEventListener: {
        get() {
          throw new Error(canary);
        },
      },
    });
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      if (respondToHello(frame, socket)) return;
      socket.respond(encodeOpenAIOnboardingBegun(frame.requestId, {
        connectionId,
        credentialIdentityFingerprint: fingerprint,
      }));
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);

    const result = await client.beginOpenAIOnboarding(controller.signal);

    expect(result).toMatchObject({ state: "succeeded" });
    expect(JSON.stringify(result)).not.toContain(canary);
    client.close();
  });

  it("sends one correlated cancel and closes on in-flight abort", async () => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      respondToHello(frame, socket);
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);
    const controller = new AbortController();
    const pending = client.beginOpenAIOnboarding(controller.signal);
    controller.abort("SECRET_IN_FLIGHT_ABORT_CANARY");

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "AbortError",
      message: "The operation was aborted.",
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_");
    expect(peer.requests.map(({ type }) => type)).toEqual([
      NativeMessageType.hello,
      NativeMessageType.openAIOnboardingRequest,
      NativeMessageType.cancel,
    ]);
    const cancelFields = decodeFieldTable(peer.requests[2]?.payload ?? new Uint8Array());
    expect(decodeU32(cancelFields[0]?.value ?? new Uint8Array())).toBe(
      peer.requests[1]?.requestId,
    );
    expect(peer.destroyed).toBe(true);
  });

  it("flushes one cancel after an outstanding write is released", async () => {
    const peer = new ScriptedOnboardingPeer(
      (frame, socket) => {
        respondToHello(frame, socket);
      },
      { holdOnboardingWrite: true },
    );
    const client = await connectNativeAuthorityClient(peer, connectOptions);
    const controller = new AbortController();
    const pending = client.beginOpenAIOnboarding(controller.signal);

    controller.abort("SECRET_STALLED_WRITE_ABORT_CANARY");
    await Promise.resolve();
    expect(peer.requests.map(({ type }) => type)).toEqual([
      NativeMessageType.hello,
      NativeMessageType.openAIOnboardingRequest,
    ]);
    expect(peer.destroyed).toBe(false);

    peer.releaseHeldWrite();
    const error = await pending.catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      name: "AbortError",
      message: "The operation was aborted.",
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_");
    expect(peer.requests.map(({ type }) => type)).toEqual([
      NativeMessageType.hello,
      NativeMessageType.openAIOnboardingRequest,
      NativeMessageType.cancel,
    ]);
    expect(peer.destroyed).toBe(true);
  });

  it("poisons sibling requests before waiting for cancel flush", async () => {
    const healthRequests: NativeFrame[] = [];
    const peer = new ScriptedOnboardingPeer(
      (frame, socket) => {
        if (respondToHello(frame, socket)) return;
        if (frame.type === NativeMessageType.health) {
          healthRequests.push(frame);
        }
      },
      { holdCancelWrite: true },
    );
    const client = await connectNativeAuthorityClient(peer, connectOptions);
    const controller = new AbortController();
    const cancelled = client.status(controller.signal);
    const sibling = client.status();

    controller.abort();
    await expect(sibling).resolves.toEqual({
      state: "unavailable",
      reason: "broker_unavailable",
    });
    expect(healthRequests).toHaveLength(2);
    peer.respond(healthResult(healthRequests[1] as NativeFrame));
    peer.releaseHeldWrite();

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.status()).resolves.toEqual({
      state: "unavailable",
      reason: "broker_unavailable",
    });
    expect(peer.destroyed).toBe(true);
  });

  it("closes within a fixed bound when an outstanding write never releases", async () => {
    const peer = new ScriptedOnboardingPeer(
      (frame, socket) => {
        respondToHello(frame, socket);
      },
      { holdOnboardingWrite: true },
    );
    const client = await connectNativeAuthorityClient(peer, connectOptions);
    const controller = new AbortController();
    const pending = client.beginOpenAIOnboarding(controller.signal);

    controller.abort();
    const error = await pending.catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "AbortError" });
    expect(peer.destroyed).toBe(true);
    expect(peer.destroyCalls).toBe(1);
  });

  it("sends one correlated cancel and returns a fixed failure on timeout", async () => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      respondToHello(frame, socket);
    });
    const client = await connectNativeAuthorityClient(peer, {
      ...connectOptions,
      onboardingBeginTimeoutMilliseconds: 5,
    });

    await expect(client.beginOpenAIOnboarding()).resolves.toEqual({
      state: "failed",
      code: "authority_unavailable",
      safeMessage: "Native OpenAI onboarding authority is unavailable.",
    });
    expect(peer.requests.map(({ type }) => type)).toEqual([
      NativeMessageType.hello,
      NativeMessageType.openAIOnboardingRequest,
      NativeMessageType.cancel,
    ]);
    const cancelFields = decodeFieldTable(peer.requests[2]?.payload ?? new Uint8Array());
    expect(decodeU32(cancelFields[0]?.value ?? new Uint8Array())).toBe(
      peer.requests[1]?.requestId,
    );
    expect(peer.destroyed).toBe(true);
  });

  it("fails closed on an exact-ID response of the wrong onboarding type", async () => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      if (respondToHello(frame, socket)) return;
      socket.respond(encodeOpenAIOnboardingAborted(frame.requestId));
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);

    await expect(client.beginOpenAIOnboarding()).resolves.toMatchObject({
      state: "failed",
      code: "authority_unavailable",
    });
    expect(peer.destroyed).toBe(true);
  });

  it("maps a fixed Keychain safe failure without exposing transport detail", async () => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      if (respondToHello(frame, socket)) return;
      socket.respond(encodeNativeFrame({
        type: NativeMessageType.safeFailure,
        requestId: frame.requestId,
        payload: encodeFieldTable([{
          tag: 1,
          value: encodeU16(NativeSafeFailureCode.keychainUnavailable),
        }]),
      }));
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);

    await expect(client.beginOpenAIOnboarding()).resolves.toEqual({
      state: "failed",
      code: "credential_store_unavailable",
      safeMessage: "Secure credential storage is unavailable.",
    });
    expect(peer.destroyed).toBe(true);
  });

  it("rejects a malformed secret-shaped failure payload without retaining it", async () => {
    const canary = "SECRET_MALFORMED_ONBOARDING_PAYLOAD_CANARY";
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      if (respondToHello(frame, socket)) return;
      socket.respond(encodeNativeFrame({
        type: NativeMessageType.openAIOnboardingFailure,
        requestId: frame.requestId,
        payload: new TextEncoder().encode(canary),
      }));
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);

    const outcome = await client.beginOpenAIOnboarding();

    expect(outcome).toEqual({
      state: "failed",
      code: "authority_unavailable",
      safeMessage: "Native OpenAI onboarding authority is unavailable.",
    });
    expect(JSON.stringify(outcome)).not.toContain(canary);
    expect(peer.destroyed).toBe(true);
  });

  it("makes a duplicate terminal reply authoritative over an apparent success", async () => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      if (respondToHello(frame, socket)) return;
      const response = encodeOpenAIOnboardingBegun(frame.requestId, {
        connectionId,
        credentialIdentityFingerprint: fingerprint,
      });
      socket.respond(Buffer.concat([response, response]));
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);

    await expect(client.beginOpenAIOnboarding()).resolves.toMatchObject({
      state: "failed",
      code: "authority_unavailable",
    });
    expect(peer.destroyed).toBe(true);
  });

  it("fails both operations closed when onboarding calls overlap", async () => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      respondToHello(frame, socket);
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);

    const first = client.beginOpenAIOnboarding();
    const second = client.beginOpenAIOnboarding();

    await expect(second).resolves.toMatchObject({
      state: "failed",
      code: "invalid_request",
    });
    await expect(first).resolves.toMatchObject({
      state: "failed",
      code: "authority_unavailable",
    });
    expect(peer.requests.map(({ type }) => type)).toEqual([
      NativeMessageType.hello,
      NativeMessageType.openAIOnboardingRequest,
    ]);
    expect(peer.destroyed).toBe(true);
  });

  it("commits a successful state transition before releasing the operation lock", async () => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      if (respondToHello(frame, socket)) return;
      socket.respond(encodeOpenAIOnboardingBegun(frame.requestId, {
        connectionId,
        credentialIdentityFingerprint: fingerprint,
      }));
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);

    const first = client.beginOpenAIOnboarding();
    const second = Promise.resolve().then(() =>
      client.beginOpenAIOnboarding()
    );

    await expect(first).resolves.toMatchObject({ state: "succeeded" });
    await expect(second).resolves.toMatchObject({
      state: "failed",
      code: "invalid_request",
    });
    expect(peer.requests.map(({ type }) => type)).toEqual([
      NativeMessageType.hello,
      NativeMessageType.openAIOnboardingRequest,
    ]);
    expect(peer.destroyed).toBe(true);
  });

  it("fails closed rather than racing onboarding with pending health", async () => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      respondToHello(frame, socket);
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);

    const health = client.status();
    const onboarding = client.beginOpenAIOnboarding();

    await expect(onboarding).resolves.toMatchObject({
      state: "failed",
      code: "invalid_request",
    });
    await expect(health).resolves.toEqual({
      state: "unavailable",
      reason: "protocol_mismatch",
    });
    expect(peer.requests.map(({ type }) => type)).toEqual([
      NativeMessageType.hello,
      NativeMessageType.health,
    ]);
    expect(peer.destroyed).toBe(true);
  });

  it("settles a pending begin safely when the peer closes", async () => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      if (respondToHello(frame, socket)) return;
      socket.peerCloses();
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);

    await expect(client.beginOpenAIOnboarding()).resolves.toMatchObject({
      state: "failed",
      code: "authority_unavailable",
    });
    expect(peer.destroyed).toBe(true);
  });

  it("reports authority loss instead of caller misuse after peer closure", async () => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      if (respondToHello(frame, socket)) return;
      if (frame.type === NativeMessageType.health) {
        socket.respond(healthResult(frame));
      }
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);
    await expect(client.status()).resolves.toMatchObject({ state: "ready" });

    peer.peerCloses();
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(client.beginOpenAIOnboarding()).resolves.toEqual({
      state: "failed",
      code: "authority_unavailable",
      safeMessage: "Native OpenAI onboarding authority is unavailable.",
    });
    expect(peer.requests.map(({ type }) => type)).toEqual([
      NativeMessageType.hello,
      NativeMessageType.health,
    ]);
    expect(peer.destroyed).toBe(true);
  });

  it.each([
    { onboardingBeginTimeoutMilliseconds: 300_001 },
    { onboardingControlTimeoutMilliseconds: 60_001 },
  ])("rejects invalid onboarding timeout options before use", async (option) => {
    const peer = new ScriptedOnboardingPeer(() => {});

    await expect(connectNativeAuthorityClient(peer, {
      ...connectOptions,
      ...option,
    })).rejects.toMatchObject({
      name: "NativeAuthorityClientUnavailableError",
      reason: "protocol_mismatch",
    });
    expect(peer.requests).toHaveLength(0);
    expect(peer.destroyed).toBe(true);
  });

  it("does not expose a legacy raw request encoder as an authority method", async () => {
    const peer = new ScriptedOnboardingPeer((frame, socket) => {
      respondToHello(frame, socket);
    });
    const client = await connectNativeAuthorityClient(peer, connectOptions);

    expect(client).not.toHaveProperty("request");
    expect(client).not.toHaveProperty("send");
    expect(client).not.toHaveProperty("getSecret");
    expect(client).not.toHaveProperty("endpoint");
    expect(encodeHello).toBeTypeOf("function");
    client.close();
  });
});
