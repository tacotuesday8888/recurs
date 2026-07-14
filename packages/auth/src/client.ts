import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";

import {
  NATIVE_AUTHORITY_PROTOCOL_VERSION,
  nativeOpenAIOnboardingFailure,
  nativeOpenAIOnboardingSucceeded,
  NativeOpenAIResponsesError,
  type NativeAuthorityAttestation,
  type NativeAuthorityPort,
  type NativeAuthorityStatus,
  type NativeAuthorityUnavailableReason,
  type NativeOpenAIActivationReconciliation,
  type NativeOpenAIOnboardingAborted,
  type NativeOpenAIOnboardingBegun,
  type NativeOpenAIOnboardingCatalogPage,
  type NativeOpenAIOnboardingCommitted,
  type NativeOpenAIOnboardingFailureCode,
  type NativeOpenAIOnboardingOutcome,
  type NativeOpenAIResponsesPort,
  type ProviderEvent,
  type ProviderRequest,
} from "@recurs/contracts";

import { NativeFrameDecoder, NativeMessageType } from "./frame.js";
import type { NativeFrame } from "./frame.js";
import {
  decodeOpenAIGenerationEvent,
  decodeOpenAIGenerationFailure,
  encodeOpenAIGenerationRequest,
} from "./openai-generation.js";
import {
  decodeHealthResult,
  decodeHelloResult,
  decodeSafeFailure,
  encodeCancel,
  encodeHealth,
  encodeHello,
} from "./messages.js";
import {
  NativeOpenAIOnboardingFailureCode as NativeOpenAIOnboardingWireFailureCode,
  decodeOpenAIOnboardingAborted,
  decodeOpenAIOnboardingBegun,
  decodeOpenAIOnboardingCatalogPage,
  decodeOpenAIOnboardingCommitted,
  decodeOpenAIOnboardingFailure,
  decodeOpenAIOnboardingReconciliation,
  encodeOpenAIOnboardingRequest,
} from "./openai-onboarding.js";
import type {
  NativeOpenAIOnboardingCatalogPage as NativeOpenAIOnboardingWireCatalogPage,
  NativeOpenAIOnboardingRequest,
} from "./openai-onboarding.js";

const NATIVE_NONCE_BYTE_LENGTH = 32;
const MAX_NATIVE_IN_FLIGHT_REQUESTS = 64;
const DEFAULT_NATIVE_TIMEOUT_MILLISECONDS = 5_000;
const MAX_NATIVE_TIMEOUT_MILLISECONDS = 60_000;
const DEFAULT_ONBOARDING_BEGIN_TIMEOUT_MILLISECONDS = 300_000;
const MAX_ONBOARDING_BEGIN_TIMEOUT_MILLISECONDS = 300_000;
const DEFAULT_ONBOARDING_CONTROL_TIMEOUT_MILLISECONDS = 30_000;
const NATIVE_CANCEL_FLUSH_MILLISECONDS = 100;
const NativeAbortSignal = AbortSignal;
const abortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  NativeAbortSignal.prototype,
  "aborted",
)?.get as (this: AbortSignal) => boolean;
const nativeAddEventListener = EventTarget.prototype.addEventListener;
const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;

type OpenAIOnboardingState =
  | { readonly kind: "fresh" }
  | {
      readonly kind: "awaiting_verification";
      readonly connectionId: string;
    }
  | {
      readonly kind: "catalog";
      readonly connectionId: string;
      readonly totalModelCount: number;
      readonly nextCursor: number | null;
      readonly catalogRequestId: string | null;
      readonly lastModelId: string;
      readonly seenModelIds: ReadonlySet<string>;
    }
  | { readonly kind: "terminal" };

export interface NativeAuthorityClientOptions {
  readonly engineVersion: string;
  readonly handshakeTimeoutMilliseconds?: number;
  readonly requestTimeoutMilliseconds?: number;
  readonly onboardingBeginTimeoutMilliseconds?: number;
  readonly onboardingControlTimeoutMilliseconds?: number;
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

export interface NativeAuthorityClient extends NativeAuthorityPort, NativeOpenAIResponsesPort {
  close(): void;
}

class BoundedNativeAuthorityClient implements NativeAuthorityClient {
  readonly #duplex: Duplex;
  readonly #requestTimeoutMilliseconds: number;
  readonly #onboardingBeginTimeoutMilliseconds: number;
  readonly #onboardingControlTimeoutMilliseconds: number;
  readonly #decoder = new NativeFrameDecoder();
  readonly #pending = new Map<number, PendingFrame>();
  #generation: PendingGeneration | undefined;
  #attestation: NativeAuthorityAttestation | undefined;
  #nextRequestId = 1;
  #openAIOnboardingActive = false;
  #openAIOnboardingState: OpenAIOnboardingState = { kind: "fresh" };
  #terminalReason: NativeAuthorityUnavailableReason | undefined;
  #transportDestroyed = false;

  private constructor(
    duplex: Duplex,
    requestTimeoutMilliseconds: number,
    onboardingBeginTimeoutMilliseconds: number,
    onboardingControlTimeoutMilliseconds: number,
  ) {
    this.#duplex = duplex;
    this.#requestTimeoutMilliseconds = requestTimeoutMilliseconds;
    this.#onboardingBeginTimeoutMilliseconds =
      onboardingBeginTimeoutMilliseconds;
    this.#onboardingControlTimeoutMilliseconds =
      onboardingControlTimeoutMilliseconds;
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
    let onboardingBeginTimeoutMilliseconds: number;
    let onboardingControlTimeoutMilliseconds: number;
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
      onboardingBeginTimeoutMilliseconds = requireTimeout(
        options.onboardingBeginTimeoutMilliseconds ??
          DEFAULT_ONBOARDING_BEGIN_TIMEOUT_MILLISECONDS,
        MAX_ONBOARDING_BEGIN_TIMEOUT_MILLISECONDS,
      );
      onboardingControlTimeoutMilliseconds = requireTimeout(
        options.onboardingControlTimeoutMilliseconds ??
          DEFAULT_ONBOARDING_CONTROL_TIMEOUT_MILLISECONDS,
      );
      signal = options.signal;
      readAbortSignal(signal);
    } catch {
      destroyWithoutDetails(duplex);
      throw new NativeAuthorityClientUnavailableError("protocol_mismatch");
    }

    const client = new BoundedNativeAuthorityClient(
      duplex,
      requestTimeoutMilliseconds,
      onboardingBeginTimeoutMilliseconds,
      onboardingControlTimeoutMilliseconds,
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
    let cancelled: boolean;
    try {
      cancelled = readAbortSignal(signal);
    } catch {
      this.#terminate("protocol_mismatch");
      return unavailable("protocol_mismatch");
    }
    if (cancelled) {
      throw abortError();
    }
    if (this.#terminalReason !== undefined) {
      return unavailable(this.#terminalReason);
    }
    if (
      this.#openAIOnboardingActive ||
      this.#openAIOnboardingState.kind !== "fresh"
    ) {
      this.#terminate("protocol_mismatch");
      return unavailable("protocol_mismatch");
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

  async beginOpenAIOnboarding(
    signal?: AbortSignal,
    provider: "openai" | "anthropic" = "openai",
  ): Promise<NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingBegun>> {
    if (!this.#canStartOpenAIOnboarding("fresh", signal)) {
      return this.#invalidOpenAIOnboardingUse();
    }
    return this.#exchangeOpenAIOnboarding(
      { kind: provider === "anthropic" ? "begin_anthropic" : "begin" },
      this.#onboardingBeginTimeoutMilliseconds,
      signal,
      NativeMessageType.openAIOnboardingBegun,
      decodeOpenAIOnboardingBegun,
      (value) => {
        this.#openAIOnboardingState = {
          kind: "awaiting_verification",
          connectionId: value.connectionId,
        };
        return Object.freeze({
          connectionId: value.connectionId,
          credentialIdentityFingerprint:
            value.credentialIdentityFingerprint,
        });
      },
    );
  }

  async verifyOpenAIOnboarding(
    signal?: AbortSignal,
  ): Promise<
    NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingCatalogPage>
  > {
    const state = this.#openAIOnboardingState;
    if (
      state.kind !== "awaiting_verification" ||
      !this.#canStartOpenAIOnboarding("awaiting_verification", signal)
    ) {
      return this.#invalidOpenAIOnboardingUse();
    }
    return this.#exchangeOpenAIOnboarding(
      { kind: "verify" },
      this.#onboardingControlTimeoutMilliseconds,
      signal,
      NativeMessageType.openAIOnboardingCatalogPage,
      decodeOpenAIOnboardingCatalogPage,
      (page) => {
        if (page.cursor !== 0) return undefined;
        this.#openAIOnboardingState = catalogState(
          state,
          page,
          new Set(page.modelIds),
        );
        return publicCatalogPage(page);
      },
    );
  }

  async openAIOnboardingCatalogPage(
    cursor: number,
    signal?: AbortSignal,
  ): Promise<
    NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingCatalogPage>
  > {
    const state = this.#openAIOnboardingState;
    if (
      state.kind !== "catalog" ||
      state.nextCursor === null ||
      cursor !== state.nextCursor ||
      !this.#canStartOpenAIOnboarding("catalog", signal)
    ) {
      return this.#invalidOpenAIOnboardingUse();
    }
    return this.#exchangeOpenAIOnboarding(
      { kind: "catalog_page", cursor },
      this.#onboardingControlTimeoutMilliseconds,
      signal,
      NativeMessageType.openAIOnboardingCatalogPage,
      decodeOpenAIOnboardingCatalogPage,
      (page) => {
        if (
          page.cursor !== cursor ||
          page.totalModelCount !== state.totalModelCount ||
          page.catalogRequestId !== state.catalogRequestId ||
          compareUtf8(state.lastModelId, page.modelIds[0] ?? "") >= 0
        ) {
          return undefined;
        }
        const seenModelIds = new Set(state.seenModelIds);
        for (const modelId of page.modelIds) seenModelIds.add(modelId);
        this.#openAIOnboardingState = catalogState(
          state,
          page,
          seenModelIds,
        );
        return publicCatalogPage(page);
      },
    );
  }

  async finalizeOpenAIOnboarding(
    exactModelId: string,
    signal?: AbortSignal,
  ): Promise<NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingCommitted>> {
    const state = this.#openAIOnboardingState;
    if (
      state.kind !== "catalog" ||
      !state.seenModelIds.has(exactModelId) ||
      !this.#canStartOpenAIOnboarding("catalog", signal)
    ) {
      return this.#invalidOpenAIOnboardingUse();
    }
    return this.#exchangeOpenAIOnboarding(
      { kind: "finalize", exactModelId },
      this.#onboardingControlTimeoutMilliseconds,
      signal,
      NativeMessageType.openAIOnboardingCommitted,
      decodeOpenAIOnboardingCommitted,
      (committed) => {
        if (
          committed.connectionId !== state.connectionId ||
          committed.selectedModelId !== exactModelId ||
          committed.verifiedModelCount !== state.totalModelCount ||
          committed.catalogRequestId !== state.catalogRequestId
        ) {
          return undefined;
        }
        this.#openAIOnboardingState = { kind: "terminal" };
        return Object.freeze({
          connectionId: committed.connectionId,
          selectedModelId: committed.selectedModelId,
          verifiedModelCount: committed.verifiedModelCount,
        });
      },
    );
  }

  async abortOpenAIOnboarding(
    signal?: AbortSignal,
  ): Promise<NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingAborted>> {
    const state = this.#openAIOnboardingState;
    if (
      (state.kind !== "awaiting_verification" && state.kind !== "catalog") ||
      !this.#canStartOpenAIOnboarding(state.kind, signal)
    ) {
      return this.#invalidOpenAIOnboardingUse();
    }
    return this.#exchangeOpenAIOnboarding(
      { kind: "abort" },
      this.#onboardingControlTimeoutMilliseconds,
      signal,
      NativeMessageType.openAIOnboardingAborted,
      decodeOpenAIOnboardingAborted,
      () => {
        this.#openAIOnboardingState = { kind: "terminal" };
        return Object.freeze({ aborted: true as const });
      },
    );
  }

  async reconcileOpenAIActivation(
    connectionId: string,
    credentialIdentityFingerprint: string,
    signal?: AbortSignal,
  ): Promise<
    NativeOpenAIOnboardingOutcome<NativeOpenAIActivationReconciliation>
  > {
    if (!this.#canStartOpenAIOnboarding("fresh", signal)) {
      return this.#invalidOpenAIOnboardingUse();
    }
    return this.#exchangeOpenAIOnboarding(
      {
        kind: "reconcile",
        connectionId,
        credentialIdentityFingerprint,
      },
      this.#onboardingControlTimeoutMilliseconds,
      signal,
      NativeMessageType.openAIOnboardingReconciliation,
      decodeOpenAIOnboardingReconciliation,
      (reconciliation) => {
        this.#openAIOnboardingState = { kind: "terminal" };
        return Object.freeze({ status: reconciliation.status });
      },
    );
  }

  async *streamOpenAIResponses(
    request: ProviderRequest,
  ): AsyncIterable<ProviderEvent> {
    if (this.#terminalReason !== undefined || this.#generation !== undefined ||
      this.#openAIOnboardingActive || this.#openAIOnboardingState.kind !== "fresh" ||
      this.#pending.size !== 0) {
      throw new NativeOpenAIResponsesError("route_unavailable");
    }
    let requestId: number;
    let encoded: Uint8Array;
    try {
      if (readAbortSignal(request.signal)) throw new NativeOpenAIResponsesError("cancelled");
      requestId = this.#claimRequestId();
      encoded = encodeOpenAIGenerationRequest(requestId, request);
    } catch (error) {
      if (error instanceof NativeOpenAIResponsesError) throw error;
      throw new NativeOpenAIResponsesError("invalid_request");
    }

    const generation = new PendingGeneration(requestId);
    this.#generation = generation;
    const abortListener = () => this.#cancelGeneration(generation);
    addAbortListener(request.signal, abortListener);
    try {
      if (readAbortSignal(request.signal)) this.#cancelGeneration(generation);
      else this.#write(encoded);
      while (true) {
        const frame = await generation.next();
        if (frame.type === NativeMessageType.openAIGenerationFailure) {
          throw new NativeOpenAIResponsesError(decodeOpenAIGenerationFailure(frame));
        }
        const event = decodeOpenAIGenerationEvent(frame);
        yield event;
        if (event.type === "done") return;
      }
    } finally {
      removeAbortListener(request.signal, abortListener);
      if (this.#generation === generation) {
        if (!generation.terminal) {
          generation.draining = true;
          this.#cancelGeneration(generation);
        } else {
          this.#generation = undefined;
        }
      }
    }
  }

  close(): void {
    this.#terminate("broker_unavailable");
  }

  #canStartOpenAIOnboarding(
    expectedState: OpenAIOnboardingState["kind"],
    signal: AbortSignal | undefined,
  ): boolean {
    if (
      this.#terminalReason !== undefined ||
      this.#openAIOnboardingActive ||
      this.#openAIOnboardingState.kind !== expectedState ||
      this.#pending.size !== 0
    ) {
      return false;
    }
    try {
      readAbortSignal(signal);
      return true;
    } catch {
      return false;
    }
  }

  async #exchangeOpenAIOnboarding<WireValue, PublicValue>(
    request: NativeOpenAIOnboardingRequest,
    timeoutMilliseconds: number,
    signal: AbortSignal | undefined,
    expectedType: NativeMessageType,
    decode: (frame: NativeFrame) => WireValue,
    accept: (value: WireValue) => PublicValue | undefined,
  ): Promise<NativeOpenAIOnboardingOutcome<PublicValue>> {
    let cancelled: boolean;
    try {
      cancelled = readAbortSignal(signal);
    } catch {
      return this.#invalidOpenAIOnboardingUse();
    }
    if (cancelled) throw abortError();

    let requestId: number;
    let encoded: Uint8Array;
    try {
      requestId = this.#claimRequestId();
      encoded = encodeOpenAIOnboardingRequest(requestId, request);
    } catch {
      return this.#invalidOpenAIOnboardingUse();
    }

    this.#openAIOnboardingActive = true;
    try {
      const response = await this.#exchange(
        requestId,
        encoded,
        timeoutMilliseconds,
        signal,
      );
      if (this.#terminalReason !== undefined) {
        return nativeOpenAIOnboardingFailure("authority_unavailable");
      }
      if (response.type === NativeMessageType.openAIOnboardingFailure) {
        const failure = decodeOpenAIOnboardingFailure(response);
        const code = mapOpenAIOnboardingFailureCode(failure.code);
        this.#terminate("broker_unavailable");
        return nativeOpenAIOnboardingFailure(code);
      }
      if (response.type === NativeMessageType.safeFailure) {
        const reason = decodeSafeFailure(response);
        this.#terminate(reason);
        return nativeOpenAIOnboardingFailure(
          mapSafeFailureToOpenAIOnboarding(reason),
        );
      }
      if (response.type !== expectedType) {
        return this.#invalidOpenAIOnboardingResponse();
      }
      const wireValue = decode(response);
      if (this.#terminalReason !== undefined) {
        return nativeOpenAIOnboardingFailure("authority_unavailable");
      }
      const value = accept(wireValue);
      if (value === undefined) {
        return this.#invalidOpenAIOnboardingResponse();
      }
      return nativeOpenAIOnboardingSucceeded(value);
    } catch (error) {
      if (isAbortError(error)) throw abortError();
      this.#terminate(
        error instanceof NativeAuthorityClientUnavailableError
          ? error.reason
          : "protocol_mismatch",
      );
      return nativeOpenAIOnboardingFailure("authority_unavailable");
    } finally {
      this.#openAIOnboardingActive = false;
    }
  }

  #invalidOpenAIOnboardingUse<T>(): NativeOpenAIOnboardingOutcome<T> {
    if (this.#terminalReason !== undefined) {
      return nativeOpenAIOnboardingFailure("authority_unavailable");
    }
    this.#openAIOnboardingState = { kind: "terminal" };
    this.#terminate("protocol_mismatch");
    return nativeOpenAIOnboardingFailure("invalid_request");
  }

  #invalidOpenAIOnboardingResponse<T>(): NativeOpenAIOnboardingOutcome<T> {
    this.#openAIOnboardingState = { kind: "terminal" };
    this.#terminate("protocol_mismatch");
    return nativeOpenAIOnboardingFailure("authority_unavailable");
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
    try {
      if (readAbortSignal(signal)) return Promise.reject(abortError());
    } catch {
      this.#terminate("protocol_mismatch");
      return Promise.reject(
        new NativeAuthorityClientUnavailableError("protocol_mismatch"),
      );
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
          this.#cancelAndTerminate(
            requestId,
            () => pending.reject(
              new NativeAuthorityClientUnavailableError("broker_unavailable"),
            ),
          );
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
            this.#cancelAndTerminate(
              requestId,
              () => pending.reject(abortError()),
            );
          };
      this.#pending.set(requestId, {
        resolve,
        reject,
        timer,
        signal,
        abortListener,
      });
      try {
        addAbortListener(signal, abortListener);
        if (readAbortSignal(signal)) {
          abortListener?.();
          return;
        }
      } catch {
        const pending = this.#takePending(requestId);
        pending?.reject(
          new NativeAuthorityClientUnavailableError("protocol_mismatch"),
        );
        this.#terminate("protocol_mismatch");
        return;
      }
      this.#write(encoded);
    });
  }

  #cancelAndTerminate(
    targetRequestId: number,
    settle: () => void,
  ): void {
    try {
      const cancelRequestId = this.#claimRequestId();
      const encoded = encodeCancel(cancelRequestId, targetRequestId);
      this.#poison("broker_unavailable");
      let finished = false;
      const finish = (reason: NativeAuthorityUnavailableReason): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.#poison(reason);
        this.#destroyTransport();
        settle();
      };
      const timer = setTimeout(
        () => finish("broker_unavailable"),
        NATIVE_CANCEL_FLUSH_MILLISECONDS,
      );
      try {
        this.#duplex.write(encoded, () => {
          finish("broker_unavailable");
        });
      } catch {
        finish("broker_unavailable");
      }
    } catch {
      this.#terminate("protocol_mismatch");
      settle();
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
      removeAbortListener(pending.signal, pending.abortListener);
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
        const generation = this.#generation;
        if (generation?.requestId === frame.requestId) {
          if (frame.type !== NativeMessageType.openAIGenerationEvent &&
            frame.type !== NativeMessageType.openAIGenerationFailure) {
            this.#terminate("protocol_mismatch");
            return;
          }
          try {
            const terminal = frame.type === NativeMessageType.openAIGenerationFailure ||
              decodeOpenAIGenerationEvent(frame).type === "done";
            generation.push(frame, terminal);
            if (generation.draining && terminal) this.#generation = undefined;
          } catch {
            this.#terminate("protocol_mismatch");
          }
          continue;
        }
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
    this.#poison(reason);
    this.#destroyTransport();
  }

  #poison(reason: NativeAuthorityUnavailableReason): void {
    if (this.#terminalReason !== undefined) return;
    this.#terminalReason = reason;
    this.#generation?.fail(new NativeAuthorityClientUnavailableError(reason));
    this.#generation = undefined;
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
  }

  #destroyTransport(): void {
    if (this.#transportDestroyed) return;
    this.#transportDestroyed = true;
    destroyWithoutDetails(this.#duplex);
  }

  #cancelGeneration(generation: PendingGeneration): void {
    if (this.#generation !== generation || generation.cancelSent) return;
    generation.cancelSent = true;
    try {
      const cancelRequestId = this.#claimRequestId();
      this.#write(encodeCancel(cancelRequestId, generation.requestId));
    } catch {
      this.#terminate("protocol_mismatch");
    }
  }
}

class PendingGeneration {
  readonly frames: NativeFrame[] = [];
  waiter: { resolve(frame: NativeFrame): void; reject(error: unknown): void } | undefined;
  terminal = false;
  draining = false;
  cancelSent = false;
  failure: unknown | undefined;

  constructor(readonly requestId: number) {}

  next(): Promise<NativeFrame> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const frame = this.frames.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    if (this.waiter !== undefined) return Promise.reject(new Error());
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }

  push(frame: NativeFrame, terminal: boolean): void {
    if (this.terminal) throw new Error();
    this.terminal = terminal;
    if (this.draining) return;
    const waiter = this.waiter;
    if (waiter === undefined) this.frames.push(frame);
    else {
      this.waiter = undefined;
      waiter.resolve(frame);
    }
  }

  fail(error: unknown): void {
    this.failure = error;
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.reject(error);
  }
}

export function connectNativeAuthorityClient(
  duplex: Duplex,
  options: NativeAuthorityClientConnectOptions,
): Promise<NativeAuthorityClient> {
  return BoundedNativeAuthorityClient.connect(duplex, options);
}

function requireTimeout(
  value: number,
  maximum = MAX_NATIVE_TIMEOUT_MILLISECONDS,
): number {
  if (
    !Number.isInteger(value) ||
    value <= 0 ||
    value > maximum
  ) {
    throw new Error();
  }
  return value;
}

function catalogState(
  identity: {
    readonly connectionId: string;
  },
  page: NativeOpenAIOnboardingWireCatalogPage,
  seenModelIds: ReadonlySet<string>,
): OpenAIOnboardingState {
  return {
    kind: "catalog",
    connectionId: identity.connectionId,
    totalModelCount: page.totalModelCount,
    nextCursor: page.nextCursor,
    catalogRequestId: page.catalogRequestId,
    lastModelId: page.modelIds[page.modelIds.length - 1] as string,
    seenModelIds,
  };
}

function publicCatalogPage(
  page: NativeOpenAIOnboardingWireCatalogPage,
): NativeOpenAIOnboardingCatalogPage {
  return Object.freeze({
    cursor: page.cursor,
    totalModelCount: page.totalModelCount,
    nextCursor: page.nextCursor,
    modelIds: Object.freeze([...page.modelIds]),
  });
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const count = Math.min(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < count; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.byteLength - rightBytes.byteLength;
}

function mapOpenAIOnboardingFailureCode(
  code: NativeOpenAIOnboardingWireFailureCode,
): NativeOpenAIOnboardingFailureCode {
  switch (code) {
    case NativeOpenAIOnboardingWireFailureCode.invalidRequest:
      return "invalid_request";
    case NativeOpenAIOnboardingWireFailureCode.sessionNotReady:
      return "session_not_ready";
    case NativeOpenAIOnboardingWireFailureCode.busy:
      return "busy";
    case NativeOpenAIOnboardingWireFailureCode.cancelled:
      return "cancelled";
    case NativeOpenAIOnboardingWireFailureCode.expired:
      return "expired";
    case NativeOpenAIOnboardingWireFailureCode.verificationFailed:
      return "verification_failed";
    case NativeOpenAIOnboardingWireFailureCode.invalidModel:
      return "invalid_model";
    case NativeOpenAIOnboardingWireFailureCode.noCompatibleModels:
      return "no_compatible_models";
    case NativeOpenAIOnboardingWireFailureCode.commitFailed:
      return "commit_failed";
    case NativeOpenAIOnboardingWireFailureCode.credentialStoreUnavailable:
      return "credential_store_unavailable";
    case NativeOpenAIOnboardingWireFailureCode.cleanupFailed:
      return "cleanup_failed";
    case NativeOpenAIOnboardingWireFailureCode.reconciliationRequired:
      return "reconciliation_required";
    case NativeOpenAIOnboardingWireFailureCode.authorityUnavailable:
      return "authority_unavailable";
    case NativeOpenAIOnboardingWireFailureCode.operationUnavailable:
      return "operation_unavailable";
  }
}

function mapSafeFailureToOpenAIOnboarding(
  reason: NativeAuthorityUnavailableReason,
): NativeOpenAIOnboardingFailureCode {
  switch (reason) {
    case "keychain_unavailable":
      return "credential_store_unavailable";
    case "unsupported_operation":
      return "operation_unavailable";
    default:
      return "authority_unavailable";
  }
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
  try {
    return error instanceof DOMException && error.name === "AbortError";
  } catch {
    return false;
  }
}

function readAbortSignal(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  if (!(signal instanceof NativeAbortSignal)) throw new TypeError();
  return Reflect.apply(abortSignalAbortedGetter, signal, []) as boolean;
}

function addAbortListener(
  signal: AbortSignal | undefined,
  listener: (() => void) | undefined,
): void {
  if (signal === undefined || listener === undefined) return;
  Reflect.apply(nativeAddEventListener, signal, [
    "abort",
    listener,
    { once: true },
  ]);
}

function removeAbortListener(
  signal: AbortSignal | undefined,
  listener: () => void,
): void {
  if (signal === undefined) return;
  try {
    Reflect.apply(nativeRemoveEventListener, signal, ["abort", listener]);
  } catch {
    // A signal that loses EventTarget validity cannot retain client details.
  }
}

function destroyWithoutDetails(duplex: Duplex): void {
  try {
    duplex.destroy();
  } catch {
    // The fixed unavailable result is authoritative.
  }
}
