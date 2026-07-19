import { Duplex } from "node:stream";

import {
  NATIVE_COMPONENT_VERSION,
  type NativeAuthorityPort,
} from "@recurs/contracts";
import {
  NativeFrameDecoder,
  NativeKeychainStatusCode,
  NativeMessageType,
  NativeSafeFailureCode,
  decodeFieldTable,
  decodeOpenAIOnboardingRequest,
  encodeBoolean,
  encodeFieldTable,
  encodeNativeFrame,
  encodeOpenAIOnboardingAborted,
  encodeOpenAIOnboardingBegun,
  encodeOpenAIOnboardingCatalogPage,
  encodeOpenAIOnboardingCommitted,
  encodeOpenAIOnboardingReconciliation,
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
  createPrivateNativeAuthorityPort,
  createPrivateNativeAuthorityStatusPort,
  runPrivateEngineProcess,
  type PrivateNativeAuthorityPort,
} from "../src/native-authority.js";

const connectionId = "00000000-0000-4000-8000-000000000001";
const credentialIdentityFingerprint = `sha256:${"a".repeat(64)}`;

class SelfAttestingNativePeer extends Duplex {
  readonly requests: NativeFrame[] = [];
  destroyCalls = 0;
  readonly #decoder = new NativeFrameDecoder();
  readonly #healthFailure: NativeSafeFailureCode | undefined;
  readonly #respondToHello: boolean;
  readonly #respondToHealth: boolean;
  readonly #respondToOnboarding: boolean;

  constructor(options: {
    readonly healthFailure?: NativeSafeFailureCode;
    readonly respondToHello?: boolean;
    readonly respondToHealth?: boolean;
    readonly respondToOnboarding?: boolean;
  } = {}) {
    super();
    this.#healthFailure = options.healthFailure;
    this.#respondToHello = options.respondToHello ?? true;
    this.#respondToHealth = options.respondToHealth ?? true;
    this.#respondToOnboarding = options.respondToOnboarding ?? true;
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
        this.#respond(frame);
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

  #respond(frame: NativeFrame): void {
    if (frame.type === NativeMessageType.hello && this.#respondToHello) {
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
      return;
    }
    if (
      frame.type === NativeMessageType.openAIOnboardingRequest &&
      this.#respondToOnboarding
    ) {
      const request = decodeOpenAIOnboardingRequest(frame);
      switch (request.kind) {
        case "begin":
          this.push(encodeOpenAIOnboardingBegun(frame.requestId, {
            connectionId,
            credentialIdentityFingerprint,
          }));
          return;
        case "verify":
          this.push(encodeOpenAIOnboardingCatalogPage(frame.requestId, {
            cursor: 0,
            totalModelCount: 2,
            nextCursor: 1,
            catalogRequestId: "catalog-1",
            modelIds: ["gpt-5"],
          }));
          return;
        case "catalog_page":
          this.push(encodeOpenAIOnboardingCatalogPage(frame.requestId, {
            cursor: request.cursor,
            totalModelCount: 2,
            nextCursor: null,
            catalogRequestId: "catalog-1",
            modelIds: ["gpt-5.1"],
          }));
          return;
        case "finalize":
          this.push(encodeOpenAIOnboardingCommitted(frame.requestId, {
            connectionId,
            selectedModelId: request.exactModelId,
            verifiedModelCount: 2,
            catalogRequestId: "catalog-1",
          }));
          return;
        case "abort":
          this.push(encodeOpenAIOnboardingAborted(frame.requestId));
          return;
        case "reconcile":
          this.push(encodeOpenAIOnboardingReconciliation(
            frame.requestId,
            "absent",
          ));
          return;
      }
    }
  }
}

afterEach(() => {
  cli.runCliProcess.mockReset();
});

describe("private native authority host", () => {
  it("keeps one lazy socket alive across status and OpenAI onboarding", async () => {
    const socket = new SelfAttestingNativePeer();
    const port = createPrivateNativeAuthorityPort(socket, {
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
    });

    await expect(port.status()).resolves.toEqual({
      state: "unavailable",
      reason: "peer_identity_unverified",
    });
    expect(socket.destroyed).toBe(false);

    await expect(port.beginOpenAIOnboarding()).resolves.toEqual({
      state: "succeeded",
      value: { connectionId, credentialIdentityFingerprint },
    });
    expect(socket.requests.map(({ type }) => type)).toEqual([
      NativeMessageType.hello,
      NativeMessageType.health,
      NativeMessageType.openAIOnboardingRequest,
    ]);
    expect(socket.destroyed).toBe(false);

    port.close();
    expect(socket.destroyed).toBe(true);
    expect(socket.destroyCalls).toBe(1);
  });

  it("delegates verify, page, finalize, abort, and reconciliation", async () => {
    const completedSocket = new SelfAttestingNativePeer();
    const completed = createPrivateNativeAuthorityPort(completedSocket, {
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
    });
    await completed.beginOpenAIOnboarding();
    await expect(completed.verifyOpenAIOnboarding()).resolves.toMatchObject({
      state: "succeeded",
      value: { cursor: 0, nextCursor: 1, modelIds: ["gpt-5"] },
    });
    await expect(completed.openAIOnboardingCatalogPage(1)).resolves.toMatchObject({
      state: "succeeded",
      value: { cursor: 1, nextCursor: null, modelIds: ["gpt-5.1"] },
    });
    await expect(completed.finalizeOpenAIOnboarding("gpt-5.1"))
      .resolves.toMatchObject({
        state: "succeeded",
        value: { connectionId, selectedModelId: "gpt-5.1" },
      });
    completed.close();

    const abortedSocket = new SelfAttestingNativePeer();
    const aborted = createPrivateNativeAuthorityPort(abortedSocket, {
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
    });
    await aborted.beginOpenAIOnboarding();
    await expect(aborted.abortOpenAIOnboarding()).resolves.toEqual({
      state: "succeeded",
      value: { aborted: true },
    });
    aborted.close();

    const reconciledSocket = new SelfAttestingNativePeer();
    const reconciled = createPrivateNativeAuthorityPort(reconciledSocket, {
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
    });
    await expect(reconciled.reconcileOpenAIActivation(
      connectionId,
      credentialIdentityFingerprint,
    )).resolves.toEqual({
      state: "succeeded",
      value: { status: "absent" },
    });
    reconciled.close();
  });

  it("memoizes one handshake for concurrent first status calls", async () => {
    const socket = new SelfAttestingNativePeer();
    const port = createPrivateNativeAuthorityPort(socket, {
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
    });

    await expect(Promise.all([port.status(), port.status()])).resolves.toEqual([
      { state: "unavailable", reason: "peer_identity_unverified" },
      { state: "unavailable", reason: "peer_identity_unverified" },
    ]);
    expect(socket.requests.filter(({ type }) => type === NativeMessageType.hello))
      .toHaveLength(1);
    expect(socket.requests.filter(({ type }) => type === NativeMessageType.health))
      .toHaveLength(2);
    expect(socket.destroyed).toBe(false);
    port.close();
  });

  it("closes once while the lazy handshake is still pending", async () => {
    const socket = new SelfAttestingNativePeer({ respondToHello: false });
    const port = createPrivateNativeAuthorityPort(socket, {
      handshakeTimeoutMilliseconds: 1_000,
      requestTimeoutMilliseconds: 100,
    });

    const pending = port.status();
    await new Promise<void>((resolve) => setImmediate(resolve));
    port.close();
    port.close();

    await expect(pending).resolves.toEqual({
      state: "unavailable",
      reason: "broker_unavailable",
    });
    expect(socket.destroyed).toBe(true);
    expect(socket.destroyCalls).toBe(1);
  });

  it("closes a client that settles after teardown without double destruction", async () => {
    const socket = new SelfAttestingNativePeer();
    const port = createPrivateNativeAuthorityPort(socket, {
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
    });

    const pending = port.status();
    port.close();
    port.close();

    await expect(pending).resolves.toEqual({
      state: "unavailable",
      reason: "broker_unavailable",
    });
    expect(socket.requests.filter(({ type }) => type === NativeMessageType.hello))
      .toHaveLength(1);
    expect(socket.destroyed).toBe(true);
    expect(socket.destroyCalls).toBe(1);
  });

  it("converges peer-driven closure and owner teardown on one close", async () => {
    const socket = new SelfAttestingNativePeer();
    const port = createPrivateNativeAuthorityPort(socket, {
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
    });
    await port.status();

    socket.push(null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    port.close();

    expect(socket.destroyed).toBe(true);
    expect(socket.destroyCalls).toBe(1);
  });

  it("closes once when OpenAI onboarding is cancelled", async () => {
    const socket = new SelfAttestingNativePeer({ respondToOnboarding: false });
    const port = createPrivateNativeAuthorityPort(socket, {
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
      onboardingBeginTimeoutMilliseconds: 1_000,
    });
    const controller = new AbortController();

    const pending = port.beginOpenAIOnboarding(controller.signal);
    controller.abort("SECRET_ONBOARDING_ABORT_CANARY");

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      name: "AbortError",
      message: "The operation was aborted.",
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_");
    expect(socket.destroyed).toBe(true);
    expect(socket.destroyCalls).toBe(1);
    port.close();
    expect(socket.destroyCalls).toBe(1);
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

  it("closes the socket when status is called with a pre-aborted signal", async () => {
    const socket = new SelfAttestingNativePeer();
    const port = createPrivateNativeAuthorityStatusPort(socket, {
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
    });
    const controller = new AbortController();
    controller.abort("SECRET_PRIVATE_HOST_PRE_ABORT_CANARY");

    const error = await port.status(controller.signal).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      name: "AbortError",
      message: "The operation was aborted.",
    });
    expect(JSON.stringify(error)).not.toContain("SECRET_");
    expect(socket.destroyed).toBe(true);
  });

  it("maps hostile cancellation signal access without reflecting it", async () => {
    const canary = "SECRET_PRIVATE_HOST_SIGNAL_GETTER_CANARY";
    const signal = Object.defineProperty({}, "aborted", {
      get() {
        throw new Error(canary);
      },
    }) as AbortSignal;

    for (const { operation, expected } of [
      {
        operation: async (port: PrivateNativeAuthorityPort) =>
          port.status(signal),
        expected: { state: "unavailable", reason: "protocol_mismatch" },
      },
      {
        operation: async (port: PrivateNativeAuthorityPort) =>
          port.beginOpenAIOnboarding(signal),
        expected: {
          state: "failed",
          code: "authority_unavailable",
          safeMessage: "Native OpenAI onboarding authority is unavailable.",
        },
      },
    ] as const) {
      const socket = new SelfAttestingNativePeer();
      const port = createPrivateNativeAuthorityPort(socket, {
        handshakeTimeoutMilliseconds: 100,
        requestTimeoutMilliseconds: 100,
      });

      const result = await operation(port).catch((error: unknown) => error);

      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain(canary);
      expect(socket.destroyed).toBe(true);
      port.close();
    }
  });

  it("fails closed on a hostile signal after the connection is established", async () => {
    const canary = "SECRET_PRIVATE_HOST_CONNECTED_SIGNAL_CANARY";
    const signal = Object.defineProperty({}, "aborted", {
      get() {
        throw new Error(canary);
      },
    }) as AbortSignal;
    const socket = new SelfAttestingNativePeer();
    const port = createPrivateNativeAuthorityPort(socket, {
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
    });
    await port.status();

    const result = await port.status(signal).catch((error: unknown) => error);

    expect(result).toEqual({
      state: "unavailable",
      reason: "protocol_mismatch",
    });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(socket.destroyed).toBe(true);
  });

  it("ignores fabricated trust arguments from untyped JavaScript", async () => {
    const callFromUntypedJavascript =
      createPrivateNativeAuthorityStatusPort as (
        duplex: Duplex,
        options: Record<string, unknown>,
        fabricatedTrust?: unknown,
      ) => PrivateNativeAuthorityPort;

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
      expect(socket.destroyed).toBe(false);
      port.close();
      expect(socket.destroyed).toBe(true);
    }
  });

  it("allowlists connection options from hostile untyped JavaScript", async () => {
    const canary = "SECRET_PRIVATE_HOST_OPTIONS_CANARY";
    const injectedController = new AbortController();
    injectedController.abort(canary);
    const callFromUntypedJavascript =
      createPrivateNativeAuthorityPort as (
        duplex: Duplex,
        options: Record<string, unknown>,
      ) => PrivateNativeAuthorityPort;
    const socket = new SelfAttestingNativePeer();
    const port = callFromUntypedJavascript(socket, {
      handshakeTimeoutMilliseconds: 100,
      requestTimeoutMilliseconds: 100,
      onboardingBeginTimeoutMilliseconds: 100,
      onboardingControlTimeoutMilliseconds: 100,
      engineVersion: "attacker-controlled-version",
      createNonce: () => {
        throw new Error(canary);
      },
      signal: injectedController.signal,
    });

    const result = await port.status();

    expect(result).toEqual({
      state: "unavailable",
      reason: "peer_identity_unverified",
    });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(socket.destroyed).toBe(false);
    port.close();
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
    expect(socket.destroyCalls).toBe(1);
  });

  it("closes an owned socket after normal process completion", async () => {
    const socket = new SelfAttestingNativePeer();

    await runPrivateEngineProcess({ duplex: socket });

    expect(cli.runCliProcess).toHaveBeenCalledOnce();
    expect(socket.destroyed).toBe(true);
    expect(socket.destroyCalls).toBe(1);
  });

  it("passes a fixed unavailable combined port into source process assembly", async () => {
    let received: NativeAuthorityPort | undefined;
    cli.runCliProcess.mockImplementationOnce(async (port) => {
      received = port as NativeAuthorityPort;
    });

    await runPrivateEngineProcess({ unavailableReason: "launcher_unavailable" });

    await expect(received?.status()).resolves.toEqual({
      state: "unavailable",
      reason: "launcher_unavailable",
    });
    const onboarding = await received?.beginOpenAIOnboarding();
    expect(onboarding).toEqual({
      state: "failed",
      code: "operation_unavailable",
      safeMessage:
        "Native OpenAI onboarding is unavailable for this invocation.",
    });
    expect(Object.isFrozen(onboarding)).toBe(true);
  });
});
