import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  ContinuationReadCapability,
  ContinuationWriteCapability,
  RunAuthorization,
  RuntimeContinuationAuthority,
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
}

interface PendingReconciliation {
  readonly authorization: RunAuthorization;
  readonly handle: RuntimeContinuationHandle;
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
  readonly #latestByLane = new Map<string, string>();
  readonly #pendingReconciliations = new Map<string, PendingReconciliation>();
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
      commit: async (input: {
        readonly authorization: RunAuthorization;
        readonly handle: RuntimeContinuationHandle;
      }) => this.#commit(input.authorization, input.handle),
      discard: async (input: {
        readonly authorization: RunAuthorization;
        readonly handle: RuntimeContinuationHandle;
      }) => this.#discard(input.authorization, input.handle),
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
    this.#latestByLane.clear();
    this.#pendingReconciliations.clear();
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
    if (this.#latestByLane.get(stored.lane) === id) {
      this.#latestByLane.delete(stored.lane);
    }
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
    for (const [id, continuation] of this.#continuations) {
      if (
        continuation.handle.expiresAt === undefined ||
        !canonicalFuture(continuation.handle.expiresAt, now)
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
      if (latestId !== undefined) {
        throw new RuntimeContinuationStoreError("continuation_handle_invalid");
      }
      return;
    }
    const stored = this.#storedExact(previous, now);
    if (
      previous.status !== "committed" ||
      latestId !== previous.id ||
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
    const capability = this.#mintCapability("runtime-write", input.authorization);
    this.#writers.set(capability.id, {
      capability,
      authorization: clone(input.authorization),
      pin: clone(input.pin),
      expectedSessionRecordSequence: input.expectedSessionRecordSequence,
      previous: input.previous === null ? null : clone(input.previous),
      stateVersion: input.stateVersion,
      lane,
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
      const stored = this.#storedExact(handle, now);
      if (
        handle.status !== (input.purpose === "run" ? "committed" : "uncertain") ||
        stored.lane !== laneFor(input.authorization, input.pin) ||
        this.#latestByLane.get(stored.lane) !== handle.id ||
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
    });
    this.#storedBytes += payload.byteLength;
    this.#latestByLane.set(binding.lane, handle.id);
    return handle;
  }

  async #commit(
    authorization: RunAuthorization,
    handle: RuntimeContinuationHandle,
  ): Promise<RuntimeContinuationHandle> {
    this.#assertAvailable();
    const now = this.#currentTime();
    const stored = this.#storedExact(handle, now);
    const originalAuthorization = isDeepStrictEqual(
      authorization,
      stored.authorization,
    );
    const reconciled = originalAuthorization
      ? false
      : this.#consumeReconciliation(authorization, handle);
    if (
      (!originalAuthorization && !reconciled) ||
      !canonicalFuture(authorization.expiresAt, now) ||
      this.#latestByLane.get(stored.lane) !== handle.id
    ) {
      throw new RuntimeContinuationStoreError("continuation_handle_invalid");
    }
    if (handle.status === "committed") {
      return handle;
    }
    if (handle.status !== "uncertain") {
      throw new RuntimeContinuationStoreError("continuation_handle_invalid");
    }
    stored.handle = frozenHandle({ ...handle, status: "committed" });
    if (stored.previousId !== null) {
      this.#deleteContinuation(stored.previousId);
    }
    return stored.handle;
  }

  #consumeReconciliation(
    authorization: RunAuthorization,
    handle: RuntimeContinuationHandle,
  ): boolean {
    const pending = this.#pendingReconciliations.get(authorization.id);
    if (
      pending === undefined ||
      !isDeepStrictEqual(pending.authorization, authorization) ||
      !isDeepStrictEqual(pending.handle, handle)
    ) {
      return false;
    }
    this.#pendingReconciliations.delete(authorization.id);
    return true;
  }

  async #discard(
    authorization: RunAuthorization,
    handle: RuntimeContinuationHandle,
  ): Promise<void> {
    this.#assertAvailable();
    const now = this.#currentTime();
    const stored = this.#storedExact(handle, now);
    if (
      handle.status !== "uncertain" ||
      this.#latestByLane.get(stored.lane) !== handle.id ||
      !canonicalFuture(authorization.expiresAt, now) ||
      !this.#consumeReconciliation(authorization, handle)
    ) {
      throw new RuntimeContinuationStoreError("continuation_handle_invalid");
    }
    const previousId = stored.previousId;
    this.#deleteContinuation(handle.id);
    if (previousId === null) {
      return;
    }
    const previous = this.#continuations.get(previousId);
    if (previous !== undefined && previous.handle.status === "committed") {
      this.#latestByLane.set(stored.lane, previousId);
    }
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
    const stored = this.#storedExact(handle, now);
    if (
      handle.status !== (binding.purpose === "run" ? "committed" : "uncertain") ||
      this.#latestByLane.get(stored.lane) !== handle.id
    ) {
      throw new RuntimeContinuationStoreError("continuation_handle_invalid");
    }
    if (binding.purpose === "reconcile") {
      if (this.#pendingReconciliations.has(binding.authorization.id)) {
        throw new RuntimeContinuationStoreError("continuation_capability_invalid");
      }
      this.#pendingReconciliations.set(binding.authorization.id, {
        authorization: binding.authorization,
        handle: clone(handle),
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
