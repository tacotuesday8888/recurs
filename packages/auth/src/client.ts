import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";

import {
  NATIVE_AUTHORITY_PROTOCOL_VERSION,
  type NativeAuthorityAttestation,
  type NativeAuthorityStatus,
  type NativeAuthorityStatusPort,
  type NativeAuthorityUnavailableReason,
} from "@recurs/contracts";

import { NativeFrameDecoder, NativeMessageType } from "./frame.js";
import type { NativeFrame } from "./frame.js";
import {
  decodeHealthResult,
  decodeHelloResult,
  decodeSafeFailure,
  encodeCancel,
  encodeHealth,
  encodeHello,
} from "./messages.js";
import {
  discardInheritedNativeAuthorityDescriptorEnvironment,
  takeInheritedNativeAuthoritySocket,
} from "./socket.js";

const NATIVE_NONCE_BYTE_LENGTH = 32;
const MAX_NATIVE_IN_FLIGHT_REQUESTS = 64;
const DEFAULT_NATIVE_TIMEOUT_MILLISECONDS = 5_000;
const MAX_NATIVE_TIMEOUT_MILLISECONDS = 60_000;

export interface NativeAuthorityClientOptions {
  readonly engineVersion: string;
  readonly handshakeTimeoutMilliseconds?: number;
  readonly requestTimeoutMilliseconds?: number;
  readonly signal?: AbortSignal;
}

export interface NativeAuthorityClientConnectOptions
  extends NativeAuthorityClientOptions {
  readonly createNonce?: () => Uint8Array;
}

export class NativeAuthorityClientUnavailableError extends Error {
  readonly reason: NativeAuthorityUnavailableReason;

  constructor(reason: NativeAuthorityUnavailableReason) {
    super("Native authority is unavailable.");
    this.name = "NativeAuthorityClientUnavailableError";
    this.reason = reason;
  }
}

interface PendingFrame {
  readonly resolve: (frame: NativeFrame) => void;
  readonly reject: (
    error: NativeAuthorityClientUnavailableError | DOMException,
  ) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal | undefined;
  readonly abortListener: (() => void) | undefined;
}

export interface NativeAuthorityClient extends NativeAuthorityStatusPort {
  close(): void;
}

class BoundedNativeAuthorityClient implements NativeAuthorityClient {
  readonly #duplex: Duplex;
  readonly #requestTimeoutMilliseconds: number;
  readonly #decoder = new NativeFrameDecoder();
  readonly #pending = new Map<number, PendingFrame>();
  #attestation: NativeAuthorityAttestation | undefined;
  #nextRequestId = 1;
  #terminalReason: NativeAuthorityUnavailableReason | undefined;

  private constructor(
    duplex: Duplex,
    requestTimeoutMilliseconds: number,
  ) {
    this.#duplex = duplex;
    this.#requestTimeoutMilliseconds = requestTimeoutMilliseconds;
    duplex.on("data", this.#onData);
    duplex.once("error", this.#onPeerError);
    duplex.once("end", this.#onPeerEnd);
    duplex.once("close", this.#onPeerClose);
  }

  static async connect(
    duplex: Duplex,
    options: NativeAuthorityClientConnectOptions,
  ): Promise<NativeAuthorityClient> {
    let engineVersion: string;
    let handshakeTimeoutMilliseconds: number;
    let requestTimeoutMilliseconds: number;
    let signal: AbortSignal | undefined;
    try {
      engineVersion = options.engineVersion;
      if (typeof engineVersion !== "string") {
        throw new Error();
      }
      handshakeTimeoutMilliseconds = requireTimeout(
        options.handshakeTimeoutMilliseconds ??
          DEFAULT_NATIVE_TIMEOUT_MILLISECONDS,
      );
      requestTimeoutMilliseconds = requireTimeout(
        options.requestTimeoutMilliseconds ??
          DEFAULT_NATIVE_TIMEOUT_MILLISECONDS,
      );
      signal = options.signal;
      if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new Error();
      }
    } catch {
      destroyWithoutDetails(duplex);
      throw new NativeAuthorityClientUnavailableError("protocol_mismatch");
    }

    const client = new BoundedNativeAuthorityClient(
      duplex,
      requestTimeoutMilliseconds,
    );
    try {
      const nonce = copyNonce(
        options.createNonce?.() ?? randomBytes(NATIVE_NONCE_BYTE_LENGTH),
      );
      const requestId = client.#claimRequestId();
      const response = await client.#exchange(
        requestId,
        encodeHello(requestId, {
          engineVersion,
          nonce,
        }),
        handshakeTimeoutMilliseconds,
        signal,
      );
      if (client.#terminalReason !== undefined) {
        throw new NativeAuthorityClientUnavailableError(
          client.#terminalReason,
        );
      }
      if (response.type === NativeMessageType.safeFailure) {
        throw new NativeAuthorityClientUnavailableError(
          decodeSafeFailure(response),
        );
      }
      if (response.type !== NativeMessageType.helloResult) {
        throw new NativeAuthorityClientUnavailableError("protocol_mismatch");
      }
      const hello = decodeHelloResult(response);
      if (
        hello.launcherVersion !== engineVersion ||
        hello.brokerVersion !== engineVersion
      ) {
        throw new NativeAuthorityClientUnavailableError("protocol_mismatch");
      }
      if (!equalBytes(nonce, hello.echoedNonce)) {
        throw new NativeAuthorityClientUnavailableError("protocol_mismatch");
      }
      if (!hello.productionSigned || !hello.persistentCredentials) {
        throw new NativeAuthorityClientUnavailableError(
          "production_signing_required",
        );
      }
      client.#attestation = Object.freeze({
        protocolVersion: NATIVE_AUTHORITY_PROTOCOL_VERSION,
        launcherVersion: hello.launcherVersion,
        brokerVersion: hello.brokerVersion,
        platform: "darwin",
        minimumMacosVersion: hello.minimumMacosVersion,
        productionSigned: hello.productionSigned,
        persistentCredentials: hello.persistentCredentials,
      });
      if (client.#terminalReason !== undefined) {
        throw new NativeAuthorityClientUnavailableError(
          client.#terminalReason,
        );
      }
      return client;
    } catch (error) {
      if (isAbortError(error)) {
        client.#terminate("broker_unavailable");
        throw abortError();
      }
      const reason =
        error instanceof NativeAuthorityClientUnavailableError
          ? error.reason
          : "protocol_mismatch";
      client.#terminate(reason);
      throw new NativeAuthorityClientUnavailableError(reason);
    }
  }

  async status(signal?: AbortSignal): Promise<NativeAuthorityStatus> {
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      this.#terminate("protocol_mismatch");
      return unavailable("protocol_mismatch");
    }
    if (signal?.aborted === true) {
      throw abortError();
    }
    if (this.#terminalReason !== undefined) {
      return unavailable(this.#terminalReason);
    }
    const attestation = this.#attestation;
    if (attestation === undefined) {
      this.#terminate("protocol_mismatch");
      return unavailable("protocol_mismatch");
    }

    try {
      const requestId = this.#claimRequestId();
      const response = await this.#exchange(
        requestId,
        encodeHealth(requestId),
        this.#requestTimeoutMilliseconds,
        signal,
      );
      if (this.#terminalReason !== undefined) {
        return unavailable(this.#terminalReason);
      }
      if (response.type === NativeMessageType.safeFailure) {
        const reason = decodeSafeFailure(response);
        this.#terminate(reason);
        return unavailable(reason);
      }
      if (response.type !== NativeMessageType.healthResult) {
        this.#terminate("protocol_mismatch");
        return unavailable("protocol_mismatch");
      }
      const health = decodeHealthResult(response);
      if (!health.peerVerified) {
        this.#terminate("peer_identity_unverified");
        return unavailable("peer_identity_unverified");
      }
      if (this.#terminalReason !== undefined) {
        return unavailable(this.#terminalReason);
      }
      return Object.freeze({
        state: "ready",
        attestation,
        health: Object.freeze({
          keychain: health.keychain,
          broker: "available",
          peerIdentity: "verified",
        }),
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      const reason =
        error instanceof NativeAuthorityClientUnavailableError
          ? error.reason
          : "protocol_mismatch";
      this.#terminate(reason);
      return unavailable(reason);
    }
  }

  close(): void {
    this.#terminate("broker_unavailable");
  }

  #claimRequestId(): number {
    if (
      this.#terminalReason !== undefined ||
      this.#nextRequestId > 0xffff_ffff
    ) {
      throw new NativeAuthorityClientUnavailableError(
        this.#terminalReason ?? "protocol_mismatch",
      );
    }
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    return requestId;
  }

  #exchange(
    requestId: number,
    encoded: Uint8Array,
    timeoutMilliseconds: number,
    signal?: AbortSignal,
  ): Promise<NativeFrame> {
    if (this.#terminalReason !== undefined) {
      return Promise.reject(
        new NativeAuthorityClientUnavailableError(this.#terminalReason),
      );
    }
    if (signal?.aborted === true) {
      return Promise.reject(abortError());
    }
    if (this.#pending.size >= MAX_NATIVE_IN_FLIGHT_REQUESTS) {
      this.#terminate("protocol_mismatch");
      return Promise.reject(
        new NativeAuthorityClientUnavailableError("protocol_mismatch"),
      );
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#takePending(requestId);
        if (pending !== undefined) {
          pending.reject(
            new NativeAuthorityClientUnavailableError("broker_unavailable"),
          );
          this.#terminate("broker_unavailable");
        }
      }, timeoutMilliseconds);
      timer.unref();
      const abortListener = signal === undefined
        ? undefined
        : () => {
            const pending = this.#takePending(requestId);
            if (pending === undefined) {
              return;
            }
            pending.reject(abortError());
            this.#sendCancel(requestId);
          };
      this.#pending.set(requestId, {
        resolve,
        reject,
        timer,
        signal,
        abortListener,
      });
      signal?.addEventListener("abort", abortListener as () => void, {
        once: true,
      });
      if (signal?.aborted === true) {
        abortListener?.();
        return;
      }
      this.#write(encoded);
    });
  }

  #sendCancel(targetRequestId: number): void {
    try {
      const cancelRequestId = this.#claimRequestId();
      this.#write(encodeCancel(cancelRequestId, targetRequestId));
    } catch {
      this.#terminate("protocol_mismatch");
    }
  }

  #write(encoded: Uint8Array): void {
    if (this.#terminalReason !== undefined) {
      return;
    }
    try {
      this.#duplex.write(encoded, (error: Error | null | undefined) => {
        if (error !== null && error !== undefined) {
          this.#terminate("broker_unavailable");
        }
      });
    } catch {
      this.#terminate("broker_unavailable");
    }
  }

  #takePending(requestId: number): PendingFrame | undefined {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      return undefined;
    }
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    if (pending.abortListener !== undefined) {
      pending.signal?.removeEventListener("abort", pending.abortListener);
    }
    return pending;
  }

  readonly #onData = (chunk: unknown): void => {
    if (this.#terminalReason !== undefined) {
      return;
    }
    try {
      if (!(chunk instanceof Uint8Array)) {
        throw new Error();
      }
      for (const frame of this.#decoder.push(chunk)) {
        const pending = this.#takePending(frame.requestId);
        if (pending === undefined) {
          this.#terminate("protocol_mismatch");
          return;
        }
        pending.resolve(frame);
      }
    } catch {
      this.#terminate("protocol_mismatch");
    }
  };

  readonly #onPeerError = (): void => {
    this.#terminate("broker_unavailable");
  };

  readonly #onPeerEnd = (): void => {
    if (this.#terminalReason !== undefined) {
      return;
    }
    try {
      this.#decoder.finish();
      this.#terminate("broker_unavailable");
    } catch {
      this.#terminate("protocol_mismatch");
    }
  };

  readonly #onPeerClose = (): void => {
    this.#terminate("broker_unavailable");
  };

  #terminate(reason: NativeAuthorityUnavailableReason): void {
    if (this.#terminalReason !== undefined) {
      return;
    }
    this.#terminalReason = reason;
    this.#duplex.off("data", this.#onData);
    try {
      this.#decoder.finish();
    } catch {
      // Truncation poisons the decoder and clears its retained frame buffer.
    }
    const pending = [...this.#pending.keys()]
      .map((requestId) => this.#takePending(requestId))
      .filter((request): request is PendingFrame => request !== undefined);
    for (const request of pending) {
      request.reject(new NativeAuthorityClientUnavailableError(reason));
    }
    destroyWithoutDetails(this.#duplex);
  }
}

export function connectNativeAuthorityClient(
  duplex: Duplex,
  options: NativeAuthorityClientConnectOptions,
): Promise<NativeAuthorityClient> {
  return BoundedNativeAuthorityClient.connect(duplex, options);
}

function restrictUnverifiedInheritedClient(
  client: NativeAuthorityClient,
): NativeAuthorityClient {
  return Object.freeze({
    async status(signal?: AbortSignal): Promise<NativeAuthorityStatus> {
      try {
        const status = await client.status(signal);
        return status.state === "ready"
          ? unavailable("peer_identity_unverified")
          : status;
      } finally {
        client.close();
      }
    },
    close(): void {
      client.close();
    },
  });
}

export async function createNativeAuthorityClientFromInheritedFd(
  options: NativeAuthorityClientOptions,
): Promise<NativeAuthorityClient> {
  if (process.platform !== "darwin") {
    discardInheritedNativeAuthorityDescriptorEnvironment(process.env);
    throw new NativeAuthorityClientUnavailableError("unsupported_platform");
  }
  let duplex: Duplex;
  try {
    duplex = takeInheritedNativeAuthoritySocket(process.env);
  } catch {
    throw new NativeAuthorityClientUnavailableError("launcher_unavailable");
  }
  const client = await connectNativeAuthorityClient(duplex, options);
  return restrictUnverifiedInheritedClient(client);
}

function requireTimeout(value: number): number {
  if (
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_NATIVE_TIMEOUT_MILLISECONDS
  ) {
    throw new Error();
  }
  return value;
}

function copyNonce(value: Uint8Array): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength !== NATIVE_NONCE_BYTE_LENGTH
  ) {
    throw new Error();
  }
  return new Uint8Array(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function unavailable(
  reason: NativeAuthorityUnavailableReason,
): NativeAuthorityStatus {
  return Object.freeze({ state: "unavailable", reason });
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function isAbortError(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "AbortError";
}

function destroyWithoutDetails(duplex: Duplex): void {
  try {
    duplex.destroy();
  } catch {
    // The fixed unavailable result is authoritative.
  }
}
