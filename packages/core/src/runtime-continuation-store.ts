import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  ContinuationReadCapability,
  ContinuationWriteCapability,
  RunAuthorization,
  RuntimeContinuationAuthority,
  RuntimeContinuationFinalization,
  RuntimeContinuationFinalizationOutcome,
  RuntimeContinuationFinalizationReceipt,
  RuntimeContinuationHandle,
  RuntimeContinuationReaderRequest,
  RuntimeContinuationStore,
  RuntimeContinuationWriterRequest,
  SessionBackendPin,
} from "@recurs/contracts";

import {
  createBackendFingerprint,
  createBillingSelectionDigest,
} from "./backend-authorization.js";
import { restoredRuntimePredecessor } from "./runtime-continuation-lifecycle.js";

export type RuntimeContinuationStoreErrorCode =
  | "continuation_capability_invalid"
  | "continuation_handle_invalid"
  | "continuation_state_invalid"
  | "continuation_expired"
  | "continuation_unsupported"
  | "continuation_store_disposed";

const messages: Readonly<Record<RuntimeContinuationStoreErrorCode, string>> = {
  continuation_capability_invalid: "Continuation capability is invalid",
  continuation_handle_invalid: "Continuation handle is invalid",
  continuation_state_invalid: "Continuation state is invalid",
  continuation_expired: "Continuation state has expired",
  continuation_unsupported: "Continuation storage mode is unsupported",
  continuation_store_disposed: "Continuation storage is unavailable",
};

export class RuntimeContinuationStoreError extends Error {
  constructor(readonly code: RuntimeContinuationStoreErrorCode) {
    super(messages[code]);
    this.name = "RuntimeContinuationStoreError";
  }
}

export interface ProcessScopedRuntimeContinuationStoreOptions {
  readonly maxPayloadBytes?: number;
  readonly maxStoredBytes?: number;
  readonly maxStoredContinuations?: number;
  readonly capabilityTtlMs?: number;
  readonly continuationTtlMs?: number;
  readonly now?: () => Date;
}

interface WriterBinding {
  readonly capability: ContinuationWriteCapability;
  readonly authorization: RunAuthorization;
  readonly pin: SessionBackendPin & { readonly kind: "agent_runtime" };
  readonly expectedSessionRecordSequence: number;
  readonly previous: RuntimeContinuationHandle | null;
  readonly stateVersion: number;
  readonly lane: string;
}

interface ReaderBinding {
  readonly capability: ContinuationReadCapability;
  readonly authorization: RunAuthorization;
  readonly pin: SessionBackendPin & { readonly kind: "agent_runtime" };
  readonly expectedSessionRecordSequence: number;
  readonly purpose: "run" | "reconcile";
  readonly allowlist: ReadonlyMap<string, RuntimeContinuationHandle>;
}

interface StoredContinuation {
  handle: RuntimeContinuationHandle;
  readonly payload: Uint8Array;
  readonly authorization: RunAuthorization;
  readonly pin: SessionBackendPin & { readonly kind: "agent_runtime" };
  readonly expectedSessionRecordSequence: number;
  readonly lane: string;
  readonly previousId: string | null;
  readonly writerId: string;
}

interface StagedRecovery {
  readonly authorization: RunAuthorization;
  readonly writer: ContinuationWriteCapability;
  readonly handleId: string | null;
}

interface PendingReconciliation {
  readonly authorization: RunAuthorization;
  readonly handle: RuntimeContinuationHandle;
  readonly expectedSessionRecordSequence: number;
}

interface PreparedFinalization {
  readonly receipt: RuntimeContinuationFinalizationReceipt;
  readonly authorization: RunAuthorization;
  readonly uncertainHandle: RuntimeContinuationHandle;
  readonly activeHandle: RuntimeContinuationHandle | null;
  readonly lane: string;
  status: "prepared" | "acknowledged";
  durableSessionRecordSequence: number | null;
}

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_MAX_STORED_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STORED_CONTINUATIONS = 128;
const DEFAULT_CAPABILITY_TTL_MS = 30_000;
const DEFAULT_CONTINUATION_TTL_MS = 15 * 60_000;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function safeInteger(value: number, minimum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum;
}

function canonicalFuture(value: string, now: Date): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value &&
    milliseconds > now.getTime();
}

function exactAuthorizationForPin(
  authorization: RunAuthorization,
  pin: SessionBackendPin & { readonly kind: "agent_runtime" },
  now: Date,
  operation: "run" | "runtime_reconcile",
): boolean {
  return authorization.kind === "run" &&
    authorization.operation === operation &&
    (operation === "run"
      ? typeof authorization.turnId === "string" &&
        authorization.turnId.length > 0
      : authorization.turnId === null) &&
    authorization.id.length > 0 &&
    authorization.sessionId.length > 0 &&
    authorization.operationId.length > 0 &&
    authorization.connectionId === pin.connectionId &&
    authorization.modelId === pin.modelId &&
    authorization.backendFingerprint === createBackendFingerprint(pin) &&
    safeInteger(authorization.connectionRevision, 0) &&
    authorization.policyRevision === pin.policyRevisionAtCreation &&
    authorization.billingMode === pin.billingSelectionAtCreation.mode &&
    authorization.billingSelectionDigest === createBillingSelectionDigest(
      pin.billingSelectionAtCreation,
    ) &&
    SHA256_DIGEST.test(authorization.contextDigest) &&
    safeInteger(authorization.maxRequests, 1) &&
    canonicalFuture(authorization.expiresAt, now);
}

function laneFor(
  authorization: RunAuthorization,
  pin: SessionBackendPin,
): string {
  return JSON.stringify([
    authorization.sessionId,
    pin.providerId,
    pin.adapterId,
    pin.connectionId,
    pin.modelId,
    authorization.backendFingerprint,
  ]);
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function frozenCapability<T extends ContinuationReadCapability | ContinuationWriteCapability>(
  capability: T,
): T {
  return Object.freeze(capability);
}

function frozenHandle(handle: RuntimeContinuationHandle): RuntimeContinuationHandle {
  return Object.freeze(handle);
}

export class ProcessScopedRuntimeContinuationStore {
  readonly #maxPayloadBytes: number;
  readonly #maxStoredBytes: number;
  readonly #maxStoredContinuations: number;
  readonly #capabilityTtlMs: number;
  readonly #continuationTtlMs: number;
  readonly #now: () => Date;
  readonly #ownerInstanceId = opaqueId("runtime-owner");
  readonly #writers = new Map<string, WriterBinding>();
  readonly #readers = new Map<string, ReaderBinding>();
  readonly #continuations = new Map<string, StoredContinuation>();
  readonly #stagedByWriter = new Map<string, StagedRecovery>();
  readonly #latestByLane = new Map<string, string>();
  readonly #pendingReconciliations = new Map<string, PendingReconciliation>();
  readonly #finalizations = new Map<string, PreparedFinalization>();
  readonly #authorityFacet: RuntimeContinuationAuthority;
  #storedBytes = 0;
  #disposed = false;

  constructor(options: ProcessScopedRuntimeContinuationStoreOptions = {}) {
    this.#maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.#maxStoredBytes = options.maxStoredBytes ?? DEFAULT_MAX_STORED_BYTES;
    this.#maxStoredContinuations = options.maxStoredContinuations ??
      DEFAULT_MAX_STORED_CONTINUATIONS;
    this.#capabilityTtlMs = options.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS;
    this.#continuationTtlMs = options.continuationTtlMs ??
      DEFAULT_CONTINUATION_TTL_MS;
    this.#now = options.now ?? (() => new Date());
    if (
      !safeInteger(this.#maxPayloadBytes, 1) ||
      !safeInteger(this.#maxStoredBytes, 1) ||
      !safeInteger(this.#maxStoredContinuations, 1) ||
      !safeInteger(this.#capabilityTtlMs, 1) ||
      !safeInteger(this.#continuationTtlMs, 1)
    ) {
      throw new RuntimeContinuationStoreError("continuation_state_invalid");
    }
    this.#authorityFacet = Object.freeze({
      ownerInstanceId: this.#ownerInstanceId,
      mintWriter: async (input: RuntimeContinuationWriterRequest) =>
        this.#mintWriter(input),
      mintReader: async (input: RuntimeContinuationReaderRequest) =>
        this.#mintReader(input),
      recoverStaged: async (input: {
        readonly authorization: RunAuthorization;
        readonly writer: ContinuationWriteCapability;
      }) => this.#recoverStaged(input.authorization, input.writer),
      prepareFinalization: async (input: {
        readonly authorization: RunAuthorization;
        readonly handle: RuntimeContinuationHandle;
        readonly outcome: RuntimeContinuationFinalizationOutcome;
        readonly expectedSessionRecordSequence: number;
      }) => this.#prepareFinalization(input),
      acknowledgeFinalization: async (input: {
        readonly authorization: RunAuthorization;
        readonly receipt: RuntimeContinuationFinalizationReceipt;
        readonly durableSessionRecordSequence: number;
      }) => this.#acknowledgeFinalization(input),
      release: async (
        capability: ContinuationReadCapability | ContinuationWriteCapability,
      ) => this.#release(capability),
    });
  }

  get ownerInstanceId(): string {
    return this.#ownerInstanceId;
  }

  get authority(): RuntimeContinuationAuthority {
    return this.#authorityFacet;
  }

  get runtimeStore(): RuntimeContinuationStore {
    return Object.freeze({
      put: async (input: {
        readonly writer: ContinuationWriteCapability;
        readonly payload: Uint8Array;
      }) => this.#put(input.writer, input.payload),
      load: async (input: {
        readonly reader: ContinuationReadCapability;
        readonly handle: RuntimeContinuationHandle;
      }) => this.#load(input.reader, input.handle),
    });
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const continuation of this.#continuations.values()) {
      continuation.payload.fill(0);
    }
    this.#writers.clear();
    this.#readers.clear();
    this.#continuations.clear();
    this.#stagedByWriter.clear();
    this.#latestByLane.clear();
    this.#pendingReconciliations.clear();
    this.#finalizations.clear();
    this.#storedBytes = 0;
  }

  #assertAvailable(): void {
    if (this.#disposed) {
      throw new RuntimeContinuationStoreError("continuation_store_disposed");
    }
  }

  #currentTime(): Date {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new RuntimeContinuationStoreError("continuation_state_invalid");
    }
    this.#pruneExpired(now);
    return now;
  }

  #deleteContinuation(id: string): void {
    const stored = this.#continuations.get(id);
    if (stored === undefined) {
      return;
    }
    stored.payload.fill(0);
    this.#storedBytes -= stored.payload.byteLength;
    this.#continuations.delete(id);
    this.#stagedByWriter.delete(stored.writerId);
    for (const [authorizationId, reconciliation] of this.#pendingReconciliations) {
      if (reconciliation.handle.id === id) {
        this.#pendingReconciliations.delete(authorizationId);
      }
    }
    if (this.#latestByLane.get(stored.lane) === id) {
      this.#latestByLane.delete(stored.lane);
    }
  }

  #retainedByLiveSuccessor(id: string, now: Date): boolean {
    for (const successor of this.#continuations.values()) {
      if (
        successor.previousId === id &&
        successor.handle.expiresAt !== undefined &&
        canonicalFuture(successor.handle.expiresAt, now)
      ) {
        return true;
      }
    }
    return false;
  }

  #backedPreparedGoneView(
    finalization: PreparedFinalization,
    now: Date,
  ): boolean {
    if (
      finalization.status !== "prepared" ||
      finalization.receipt.outcome !== "gone" ||
      finalization.activeHandle === null ||
      finalization.activeHandle.expiresAt === undefined ||
      !canonicalFuture(finalization.activeHandle.expiresAt, now)
    ) {
      return false;
    }
    const uncertain = this.#continuations.get(
      finalization.receipt.continuationId,
    );
    const active = this.#continuations.get(finalization.activeHandle.id);
    return uncertain !== undefined &&
      active !== undefined &&
      uncertain.handle.status === "uncertain" &&
      active.handle.status === "committed" &&
      uncertain.previousId === active.handle.id &&
      uncertain.lane === finalization.lane &&
      active.lane === finalization.lane &&
      this.#latestByLane.get(finalization.lane) === uncertain.handle.id &&
      isDeepStrictEqual(uncertain.handle, finalization.uncertainHandle) &&
      isDeepStrictEqual(
        restoredRuntimePredecessor(active.handle, uncertain.handle),
        finalization.activeHandle,
      );
  }

  #retainedByPreparedGoneView(id: string, now: Date): boolean {
    for (const finalization of this.#finalizations.values()) {
      if (
        finalization.receipt.continuationId === id &&
        this.#backedPreparedGoneView(finalization, now)
      ) {
        return true;
      }
    }
    return false;
  }

  #pruneExpired(now: Date): void {
    for (const [id, writer] of this.#writers) {
      if (!canonicalFuture(writer.capability.expiresAt, now)) {
        this.#writers.delete(id);
      }
    }
    for (const [id, reader] of this.#readers) {
      if (!canonicalFuture(reader.capability.expiresAt, now)) {
        this.#readers.delete(id);
      }
    }
    for (const [id, reconciliation] of this.#pendingReconciliations) {
      if (!canonicalFuture(reconciliation.authorization.expiresAt, now)) {
        this.#pendingReconciliations.delete(id);
      }
    }
    for (const [id, finalization] of this.#finalizations) {
      if (
        !canonicalFuture(finalization.receipt.expiresAt, now) &&
        !this.#backedPreparedGoneView(finalization, now)
      ) {
        this.#finalizations.delete(id);
      }
    }
    for (const [id, recovery] of this.#stagedByWriter) {
      if (
        recovery.handleId === null &&
        (!canonicalFuture(recovery.writer.expiresAt, now) ||
          !canonicalFuture(recovery.authorization.expiresAt, now))
      ) {
        this.#stagedByWriter.delete(id);
      }
    }
    for (const [id, continuation] of this.#continuations) {
      if (
        continuation.handle.expiresAt === undefined ||
        (!canonicalFuture(continuation.handle.expiresAt, now) &&
          !this.#retainedByLiveSuccessor(id, now) &&
          !this.#retainedByPreparedGoneView(id, now))
      ) {
        this.#deleteContinuation(id);
      }
    }
  }

  #expiry(now: Date, authorization: RunAuthorization, ttlMs: number): string {
    return new Date(
      Math.min(Date.parse(authorization.expiresAt), now.getTime() + ttlMs),
    ).toISOString();
  }

  #validatePinAndAuthorization(
    pin: SessionBackendPin & { readonly kind: "agent_runtime" },
    authorization: RunAuthorization,
    now: Date,
    operation: "run" | "runtime_reconcile",
  ): void {
    if (pin.kind !== "agent_runtime") {
      throw new RuntimeContinuationStoreError("continuation_unsupported");
    }
    if (!exactAuthorizationForPin(authorization, pin, now, operation)) {
      throw new RuntimeContinuationStoreError("continuation_capability_invalid");
    }
  }

  #storedExact(
    handle: RuntimeContinuationHandle,
    now: Date,
  ): StoredContinuation {
    if (
      handle.storageClass !== "process_scoped" ||
      handle.ownerInstanceId !== this.#ownerInstanceId
    ) {
      throw new RuntimeContinuationStoreError("continuation_handle_invalid");
    }
    const stored = this.#continuations.get(handle.id);
    if (stored === undefined || !isDeepStrictEqual(handle, stored.handle)) {
      throw new RuntimeContinuationStoreError("continuation_handle_invalid");
    }
    if (
      stored.handle.expiresAt === undefined ||
      !canonicalFuture(stored.handle.expiresAt, now)
    ) {
      throw new RuntimeContinuationStoreError("continuation_expired");
    }
    return stored;
  }

  #preparedRunView(
    handle: RuntimeContinuationHandle,
    expectedSessionRecordSequence: number,
  ): {
    readonly finalization: PreparedFinalization;
    readonly active: StoredContinuation;
  } | null {
    for (const finalization of this.#finalizations.values()) {
      if (
        finalization.status !== "prepared" ||
        expectedSessionRecordSequence <=
          finalization.receipt.expectedSessionRecordSequence ||
        finalization.activeHandle === null ||
        !isDeepStrictEqual(finalization.activeHandle, handle)
      ) {
        continue;
      }
      const uncertain = this.#continuations.get(
        finalization.receipt.continuationId,
      );
      const active = this.#continuations.get(handle.id);
      if (
        uncertain === undefined ||
        active === undefined ||
        uncertain.lane !== finalization.lane ||
        active.lane !== finalization.lane ||
        this.#latestByLane.get(finalization.lane) !== uncertain.handle.id
      ) {
        continue;
      }
      return { finalization, active };
    }
    return null;
  }

  #storedRunView(
    handle: RuntimeContinuationHandle,
    expectedSessionRecordSequence: number,
    now: Date,
    authorization: RunAuthorization,
    pin: SessionBackendPin & { readonly kind: "agent_runtime" },
  ): StoredContinuation {
    if (handle.status !== "committed") {
      throw new RuntimeContinuationStoreError("continuation_handle_invalid");
    }
    const stored = this.#continuations.get(handle.id);
    if (
      stored !== undefined &&
      isDeepStrictEqual(stored.handle, handle) &&
      this.#latestByLane.get(stored.lane) === handle.id
    ) {
      return this.#storedExact(handle, now);
    }
    const prepared = this.#preparedRunView(
      handle,
      expectedSessionRecordSequence,
    );
    if (
      prepared === null ||
      handle.expiresAt === undefined ||
      !canonicalFuture(handle.expiresAt, now) ||
      prepared.active.lane !== laneFor(authorization, pin) ||
      prepared.active.authorization.sessionId !== authorization.sessionId ||
      !isDeepStrictEqual(prepared.active.pin, pin) ||
      expectedSessionRecordSequence <=
        prepared.active.expectedSessionRecordSequence
    ) {
      throw new RuntimeContinuationStoreError("continuation_handle_invalid");
    }
    const materialized = this.#materializePreparedFinalization(
      prepared.finalization,
      prepared.finalization.receipt.expectedSessionRecordSequence + 1,
    );
    if (
      materialized === null ||
      materialized.lane !== prepared.active.lane ||
      !isDeepStrictEqual(materialized.handle, handle) ||
      this.#latestByLane.get(materialized.lane) !== handle.id
    ) {
      throw new RuntimeContinuationStoreError("continuation_handle_invalid");
    }
    return this.#storedExact(handle, now);
  }

  #preparedEmptyLane(
    lane: string,
    expectedSessionRecordSequence: number,
    authorization: RunAuthorization,
    pin: SessionBackendPin & { readonly kind: "agent_runtime" },
  ): boolean {
    for (const finalization of this.#finalizations.values()) {
      if (
        finalization.status === "prepared" &&
        finalization.lane === lane &&
        finalization.receipt.outcome === "gone" &&
        finalization.activeHandle === null &&
        expectedSessionRecordSequence >
          finalization.receipt.expectedSessionRecordSequence &&
        this.#latestByLane.get(lane) === finalization.receipt.continuationId
      ) {
        const uncertain = this.#continuations.get(
          finalization.receipt.continuationId,
        );
        if (
          uncertain === undefined ||
          uncertain.lane !== lane ||
          uncertain.authorization.sessionId !== authorization.sessionId ||
          !isDeepStrictEqual(uncertain.pin, pin) ||
          expectedSessionRecordSequence <=
            uncertain.expectedSessionRecordSequence
        ) {
          continue;
        }
        this.#materializePreparedFinalization(
          finalization,
          finalization.receipt.expectedSessionRecordSequence + 1,
        );
        return this.#latestByLane.get(lane) === undefined;
      }
    }
    return false;
  }

  #validatePredecessor(
    previous: RuntimeContinuationHandle | null,
    lane: string,
    authorization: RunAuthorization,
    pin: SessionBackendPin & { readonly kind: "agent_runtime" },
    expectedSessionRecordSequence: number,
    now: Date,
  ): void {
    const latestId = this.#latestByLane.get(lane);
    if (previous === null) {
      if (
        latestId !== undefined &&
        !this.#preparedEmptyLane(
          lane,
          expectedSessionRecordSequence,
          authorization,
          pin,
        )
      ) {
        throw new RuntimeContinuationStoreError("continuation_handle_invalid");
      }
      return;
    }
    const stored = this.#storedRunView(
      previous,
      expectedSessionRecordSequence,
      now,
      authorization,
      pin,
    );
    if (
      stored.lane !== lane ||
      stored.authorization.sessionId !== authorization.sessionId ||
      !isDeepStrictEqual(stored.pin, pin) ||
      expectedSessionRecordSequence <= stored.expectedSessionRecordSequence
    ) {
      throw new RuntimeContinuationStoreError("continuation_handle_invalid");
    }
  }

  #mintCapability(prefix: string, authorization: RunAuthorization): {
    readonly id: string;
    readonly expiresAt: string;
  } {
    const now = this.#currentTime();
    return frozenCapability({
      id: opaqueId(prefix),
      expiresAt: this.#expiry(now, authorization, this.#capabilityTtlMs),
    });
  }

  async #mintWriter(
    input: RuntimeContinuationWriterRequest,
  ): Promise<ContinuationWriteCapability> {
    this.#assertAvailable();
    const now = this.#currentTime();
    this.#validatePinAndAuthorization(
      input.pin,
      input.authorization,
      now,
      "run",
    );
    if (
      !safeInteger(input.expectedSessionRecordSequence, 0) ||
      !safeInteger(input.stateVersion, 1)
    ) {
      throw new RuntimeContinuationStoreError("continuation_capability_invalid");
    }
    const lane = laneFor(input.authorization, input.pin);
    this.#validatePredecessor(
      input.previous,
      lane,
      input.authorization,
      input.pin,
      input.expectedSessionRecordSequence,
      now,
    );
    if (this.#stagedByWriter.size >= this.#maxStoredContinuations) {
      throw new RuntimeContinuationStoreError("continuation_capability_invalid");
    }
    const capability = this.#mintCapability("runtime-write", input.authorization);
    const binding = {
      capability,
      authorization: clone(input.authorization),
      pin: clone(input.pin),
      expectedSessionRecordSequence: input.expectedSessionRecordSequence,
      previous: input.previous === null ? null : clone(input.previous),
      stateVersion: input.stateVersion,
      lane,
    } satisfies WriterBinding;
    this.#writers.set(capability.id, binding);
    this.#stagedByWriter.set(capability.id, {
      authorization: binding.authorization,
      writer: binding.capability,
      handleId: null,
    });
    return capability;
  }

  async #mintReader(
    input: RuntimeContinuationReaderRequest,
  ): Promise<ContinuationReadCapability> {
    this.#assertAvailable();
    const now = this.#currentTime();
    this.#validatePinAndAuthorization(
      input.pin,
      input.authorization,
      now,
      input.purpose === "run" ? "run" : "runtime_reconcile",
    );
    if (
      !safeInteger(input.expectedSessionRecordSequence, 0) ||
      input.activeHandles.length !== 1
    ) {
      throw new RuntimeContinuationStoreError("continuation_capability_invalid");
    }
    const allowlist = new Map<string, RuntimeContinuationHandle>();
    for (const handle of input.activeHandles) {
      const stored = input.purpose === "run"
        ? this.#storedRunView(
            handle,
            input.expectedSessionRecordSequence,
            now,
            input.authorization,
            input.pin,
          )
        : this.#storedExact(handle, now);
      if (
        handle.status !== (input.purpose === "run" ? "committed" : "uncertain") ||
        stored.lane !== laneFor(input.authorization, input.pin) ||
        (input.purpose === "reconcile" &&
          this.#latestByLane.get(stored.lane) !== handle.id) ||
        stored.authorization.sessionId !== input.authorization.sessionId ||
        !isDeepStrictEqual(stored.pin, input.pin) ||
        input.expectedSessionRecordSequence <=
          stored.expectedSessionRecordSequence ||
        allowlist.has(handle.id)
      ) {
        throw new RuntimeContinuationStoreError("continuation_handle_invalid");
      }
      allowlist.set(handle.id, clone(handle));
    }
    const capability = this.#mintCapability("runtime-read", input.authorization);
    this.#readers.set(capability.id, {
      capability,
      authorization: clone(input.authorization),
      pin: clone(input.pin),
      expectedSessionRecordSequence: input.expectedSessionRecordSequence,
      purpose: input.purpose,
      allowlist,
    });
    return capability;
  }

  #consumeWriter(
    writer: ContinuationWriteCapability,
    now: Date,
  ): WriterBinding {
    const binding = this.#writers.get(writer.id);
    if (binding !== undefined) {
      this.#writers.delete(writer.id);
    }
    if (
      binding === undefined ||
      !isDeepStrictEqual(writer, binding.capability) ||
      !canonicalFuture(binding.capability.expiresAt, now) ||
      !canonicalFuture(binding.authorization.expiresAt, now)
    ) {
      throw new RuntimeContinuationStoreError("continuation_capability_invalid");
    }
    return binding;
  }

  async #put(
    writer: ContinuationWriteCapability,
    payload: Uint8Array,
  ): Promise<RuntimeContinuationHandle> {
    this.#assertAvailable();
    const now = this.#currentTime();
    const binding = this.#consumeWriter(writer, now);
    if (
      !(payload instanceof Uint8Array) ||
      payload.byteLength === 0 ||
      payload.byteLength > this.#maxPayloadBytes
    ) {
      throw new RuntimeContinuationStoreError("continuation_state_invalid");
    }
    this.#validatePredecessor(
      binding.previous,
      binding.lane,
      binding.authorization,
      binding.pin,
      binding.expectedSessionRecordSequence,
      now,
    );
    if (
      this.#continuations.size >= this.#maxStoredContinuations ||
      this.#storedBytes + payload.byteLength > this.#maxStoredBytes
    ) {
      throw new RuntimeContinuationStoreError("continuation_state_invalid");
    }
    const previousSequence = binding.previous?.continuationSequence ?? 0;
    const previousVendorSequence = binding.previous?.vendorTurnSequence ?? 0;
    const handle = frozenHandle({
      kind: "runtime",
      id: opaqueId("runtime-continuation"),
      storageClass: "process_scoped",
      ownerInstanceId: this.#ownerInstanceId,
      expiresAt: this.#expiry(now, binding.authorization, this.#continuationTtlMs),
      recursSessionId: binding.authorization.sessionId,
      connectionId: binding.pin.connectionId,
      adapterId: binding.pin.adapterId,
      modelId: binding.pin.modelId,
      backendFingerprint: binding.authorization.backendFingerprint,
      stateVersion: binding.stateVersion,
      originTurnId: binding.authorization.turnId as string,
      continuationSequence: previousSequence + 1,
      status: "uncertain",
      vendorTurnSequence: previousVendorSequence + 1,
    });
    this.#continuations.set(handle.id, {
      handle,
      payload: new Uint8Array(payload),
      authorization: binding.authorization,
      pin: binding.pin,
      expectedSessionRecordSequence: binding.expectedSessionRecordSequence,
      lane: binding.lane,
      previousId: binding.previous?.id ?? null,
      writerId: binding.capability.id,
    });
    this.#storedBytes += payload.byteLength;
    const recovery = this.#stagedByWriter.get(binding.capability.id);
    if (
      recovery === undefined ||
      recovery.handleId !== null ||
      !isDeepStrictEqual(recovery.authorization, binding.authorization) ||
      !isDeepStrictEqual(recovery.writer, binding.capability)
    ) {
      this.#deleteContinuation(handle.id);
      throw new RuntimeContinuationStoreError("continuation_capability_invalid");
    }
    this.#stagedByWriter.set(binding.capability.id, {
      ...recovery,
      handleId: handle.id,
    });
    this.#latestByLane.set(binding.lane, handle.id);
    return handle;
  }

  async #recoverStaged(
    authorization: RunAuthorization,
    writer: ContinuationWriteCapability,
  ): Promise<RuntimeContinuationHandle | null> {
    this.#assertAvailable();
    const now = this.#currentTime();
    const staged = this.#stagedByWriter.get(writer.id);
    if (staged !== undefined) {
      if (
        !isDeepStrictEqual(writer, staged.writer) ||
        !isDeepStrictEqual(authorization, staged.authorization) ||
        !canonicalFuture(authorization.expiresAt, now)
      ) {
        throw new RuntimeContinuationStoreError(
          "continuation_capability_invalid",
        );
      }
      if (staged.handleId === null) {
        if (!canonicalFuture(writer.expiresAt, now)) {
          throw new RuntimeContinuationStoreError(
            "continuation_capability_invalid",
          );
        }
        return null;
      }
      const stored = this.#continuations.get(staged.handleId);
      if (
        stored === undefined ||
        stored.writerId !== writer.id ||
        stored.handle.status !== "uncertain" ||
        this.#latestByLane.get(stored.lane) !== stored.handle.id
      ) {
        throw new RuntimeContinuationStoreError("continuation_handle_invalid");
      }
      this.#storedExact(stored.handle, now);
      return stored.handle;
    }
    throw new RuntimeContinuationStoreError("continuation_capability_invalid");
  }

  #matchingReconciliation(
    authorization: RunAuthorization,
    handle: RuntimeContinuationHandle,
    expectedSessionRecordSequence: number,
  ): boolean {
    const pending = this.#pendingReconciliations.get(authorization.id);
    return pending !== undefined &&
      isDeepStrictEqual(pending.authorization, authorization) &&
      isDeepStrictEqual(pending.handle, handle) &&
      pending.expectedSessionRecordSequence === expectedSessionRecordSequence;
  }

  async #prepareFinalization(input: {
    readonly authorization: RunAuthorization;
    readonly handle: RuntimeContinuationHandle;
    readonly outcome: RuntimeContinuationFinalizationOutcome;
    readonly expectedSessionRecordSequence: number;
  }): Promise<RuntimeContinuationFinalization> {
    this.#assertAvailable();
    const now = this.#currentTime();
    const stored = this.#storedExact(input.handle, now);
    let existing: PreparedFinalization | null = null;
    for (const finalization of this.#finalizations.values()) {
      if (
        finalization.status === "prepared" &&
        isDeepStrictEqual(finalization.authorization, input.authorization) &&
        isDeepStrictEqual(finalization.uncertainHandle, input.handle) &&
        finalization.receipt.outcome === input.outcome &&
        finalization.receipt.expectedSessionRecordSequence ===
          input.expectedSessionRecordSequence
      ) {
        existing = finalization;
        break;
      }
    }
    const originalAuthorization = isDeepStrictEqual(
      input.authorization,
      stored.authorization,
    );
    const reconciliation = this.#matchingReconciliation(
      input.authorization,
      input.handle,
      input.expectedSessionRecordSequence,
    );
    if (
      input.handle.status !== "uncertain" ||
      this.#latestByLane.get(stored.lane) !== input.handle.id ||
      !safeInteger(input.expectedSessionRecordSequence, 0) ||
      input.expectedSessionRecordSequence <=
        stored.expectedSessionRecordSequence ||
      !canonicalFuture(input.authorization.expiresAt, now) ||
      (!(originalAuthorization && input.outcome === "committed") &&
        !reconciliation && existing === null)
    ) {
      throw new RuntimeContinuationStoreError("continuation_handle_invalid");
    }
    if (existing !== null) {
      return Object.freeze({
        receipt: existing.receipt,
        activeHandle: existing.activeHandle,
      });
    }
    for (const [id, finalization] of this.#finalizations) {
      if (
        finalization.status === "prepared" &&
        finalization.receipt.continuationId === input.handle.id &&
        finalization.receipt.expectedSessionRecordSequence ===
          input.expectedSessionRecordSequence
      ) {
        this.#finalizations.delete(id);
      }
    }
    if (this.#finalizations.size >= this.#maxStoredContinuations) {
      for (const [id, finalization] of this.#finalizations) {
        if (finalization.status === "acknowledged") {
          this.#finalizations.delete(id);
          if (this.#finalizations.size < this.#maxStoredContinuations) {
            break;
          }
        }
      }
    }
    if (this.#finalizations.size >= this.#maxStoredContinuations) {
      throw new RuntimeContinuationStoreError("continuation_state_invalid");
    }
    let activeHandle: RuntimeContinuationHandle | null;
    if (input.outcome === "committed") {
      activeHandle = frozenHandle({ ...input.handle, status: "committed" });
    } else if (stored.previousId === null) {
      activeHandle = null;
    } else {
      const previous = this.#continuations.get(stored.previousId);
      if (
        previous === undefined ||
        previous.handle.status !== "committed" ||
        previous.lane !== stored.lane
      ) {
        throw new RuntimeContinuationStoreError("continuation_handle_invalid");
      }
      activeHandle = frozenHandle(
        restoredRuntimePredecessor(previous.handle, input.handle)!,
      );
    }
    if (input.handle.expiresAt === undefined) {
      throw new RuntimeContinuationStoreError("continuation_expired");
    }
    const receipt = Object.freeze({
      kind: "runtime_continuation_finalization" as const,
      id: opaqueId("runtime-finalization"),
      ownerInstanceId: this.#ownerInstanceId,
      authorizationId: input.authorization.id,
      sessionId: input.authorization.sessionId,
      backendFingerprint: input.authorization.backendFingerprint,
      continuationId: input.handle.id,
      continuationSequence: input.handle.continuationSequence,
      expectedSessionRecordSequence: input.expectedSessionRecordSequence,
      outcome: input.outcome,
      expiresAt: input.handle.expiresAt,
    } satisfies RuntimeContinuationFinalizationReceipt);
    this.#finalizations.set(receipt.id, {
      receipt,
      authorization: clone(input.authorization),
      uncertainHandle: clone(input.handle),
      activeHandle,
      lane: stored.lane,
      status: "prepared",
      durableSessionRecordSequence: null,
    });
    if (reconciliation) {
      this.#pendingReconciliations.delete(input.authorization.id);
    }
    return Object.freeze({ receipt, activeHandle });
  }

  #materializePreparedFinalization(
    finalization: PreparedFinalization,
    durableSessionRecordSequence: number,
  ): StoredContinuation | null {
    if (
      !safeInteger(durableSessionRecordSequence, 0) ||
      durableSessionRecordSequence !==
        finalization.receipt.expectedSessionRecordSequence + 1
    ) {
      throw new RuntimeContinuationStoreError("continuation_capability_invalid");
    }
    if (finalization.status === "acknowledged") {
      if (
        finalization.durableSessionRecordSequence !==
          durableSessionRecordSequence
      ) {
        throw new RuntimeContinuationStoreError(
          "continuation_capability_invalid",
        );
      }
      return finalization.activeHandle === null
        ? null
        : this.#continuations.get(finalization.activeHandle.id) ?? null;
    }
    const stored = this.#continuations.get(
      finalization.receipt.continuationId,
    );
    if (
      stored === undefined ||
      stored.lane !== finalization.lane ||
      !isDeepStrictEqual(stored.handle, finalization.uncertainHandle)
    ) {
      throw new RuntimeContinuationStoreError("continuation_handle_invalid");
    }
    let restoredPrevious: StoredContinuation | null = null;
    if (finalization.receipt.outcome === "gone") {
      if (stored.previousId === null) {
        if (finalization.activeHandle !== null) {
          throw new RuntimeContinuationStoreError("continuation_state_invalid");
        }
      } else {
        const previous = this.#continuations.get(stored.previousId);
        if (
          previous === undefined ||
          previous.handle.status !== "committed" ||
          previous.lane !== stored.lane ||
          finalization.activeHandle === null ||
          !isDeepStrictEqual(
            restoredRuntimePredecessor(previous.handle, stored.handle),
            finalization.activeHandle,
          )
        ) {
          throw new RuntimeContinuationStoreError("continuation_handle_invalid");
        }
        restoredPrevious = previous;
      }
    }
    for (const [id, candidate] of this.#finalizations) {
      if (
        id !== finalization.receipt.id &&
        candidate.receipt.continuationId ===
          finalization.receipt.continuationId
      ) {
        this.#finalizations.delete(id);
      }
    }
    for (const [id, pending] of this.#pendingReconciliations) {
      if (pending.handle.id === finalization.receipt.continuationId) {
        this.#pendingReconciliations.delete(id);
      }
    }
    let active: StoredContinuation | null;
    if (finalization.receipt.outcome === "committed") {
      if (finalization.activeHandle === null) {
        throw new RuntimeContinuationStoreError("continuation_state_invalid");
      }
      stored.handle = finalization.activeHandle;
      this.#stagedByWriter.delete(stored.writerId);
      if (stored.previousId !== null) {
        this.#deleteContinuation(stored.previousId);
      }
      active = stored;
    } else {
      const wasLatest = this.#latestByLane.get(stored.lane) === stored.handle.id;
      const previousId = stored.previousId;
      if (restoredPrevious !== null) {
        restoredPrevious.handle = finalization.activeHandle!;
      }
      this.#deleteContinuation(stored.handle.id);
      if (wasLatest && previousId !== null && restoredPrevious !== null) {
        this.#latestByLane.set(stored.lane, previousId);
      }
      active = restoredPrevious;
    }
    finalization.status = "acknowledged";
    finalization.durableSessionRecordSequence = durableSessionRecordSequence;
    this.#finalizations.set(finalization.receipt.id, finalization);
    return active;
  }

  async #acknowledgeFinalization(input: {
    readonly authorization: RunAuthorization;
    readonly receipt: RuntimeContinuationFinalizationReceipt;
    readonly durableSessionRecordSequence: number;
  }): Promise<void> {
    this.#assertAvailable();
    const now = this.#currentTime();
    const finalization = this.#finalizations.get(input.receipt.id);
    if (
      finalization === undefined ||
      !isDeepStrictEqual(finalization.receipt, input.receipt) ||
      !isDeepStrictEqual(finalization.authorization, input.authorization) ||
      input.receipt.ownerInstanceId !== this.#ownerInstanceId ||
      (finalization.status === "prepared" &&
        !canonicalFuture(input.receipt.expiresAt, now))
    ) {
      throw new RuntimeContinuationStoreError("continuation_capability_invalid");
    }
    this.#materializePreparedFinalization(
      finalization,
      input.durableSessionRecordSequence,
    );
  }

  #consumeReader(
    reader: ContinuationReadCapability,
    now: Date,
  ): ReaderBinding {
    const binding = this.#readers.get(reader.id);
    if (binding !== undefined) {
      this.#readers.delete(reader.id);
    }
    if (
      binding === undefined ||
      !isDeepStrictEqual(reader, binding.capability) ||
      !canonicalFuture(binding.capability.expiresAt, now) ||
      !canonicalFuture(binding.authorization.expiresAt, now)
    ) {
      throw new RuntimeContinuationStoreError("continuation_capability_invalid");
    }
    return binding;
  }

  async #load(
    reader: ContinuationReadCapability,
    handle: RuntimeContinuationHandle,
  ): Promise<Uint8Array> {
    this.#assertAvailable();
    const now = this.#currentTime();
    const binding = this.#consumeReader(reader, now);
    const allowed = binding.allowlist.get(handle.id);
    if (allowed === undefined || !isDeepStrictEqual(allowed, handle)) {
      throw new RuntimeContinuationStoreError("continuation_handle_invalid");
    }
    const stored = binding.purpose === "run"
      ? this.#storedRunView(
          handle,
          binding.expectedSessionRecordSequence,
          now,
          binding.authorization,
          binding.pin,
        )
      : this.#storedExact(handle, now);
    if (
      handle.status !== (binding.purpose === "run" ? "committed" : "uncertain") ||
      (binding.purpose === "reconcile" &&
        this.#latestByLane.get(stored.lane) !== handle.id)
    ) {
      throw new RuntimeContinuationStoreError("continuation_handle_invalid");
    }
    if (binding.purpose === "reconcile") {
      if (
        this.#pendingReconciliations.has(binding.authorization.id) ||
        this.#pendingReconciliations.size >= this.#maxStoredContinuations
      ) {
        throw new RuntimeContinuationStoreError("continuation_capability_invalid");
      }
      this.#pendingReconciliations.set(binding.authorization.id, {
        authorization: binding.authorization,
        handle: clone(handle),
        expectedSessionRecordSequence: binding.expectedSessionRecordSequence,
      });
    }
    return new Uint8Array(stored.payload);
  }

  async #release(
    capability: ContinuationReadCapability | ContinuationWriteCapability,
  ): Promise<void> {
    this.#writers.delete(capability.id);
    this.#readers.delete(capability.id);
  }
}
