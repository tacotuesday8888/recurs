import {
  NATIVE_AUTHORITY_PROTOCOL_VERSION,
  NATIVE_COMPONENT_VERSION,
  type NativeAuthorityStatus,
  type NativeAuthorityStatusPort,
  type NativeAuthorityUnavailableReason,
} from "@recurs/contracts";

const UNAVAILABLE = Object.freeze({
  state: "unavailable",
  reason: "broker_unavailable",
} satisfies NativeAuthorityStatus);

const unavailableReasons = new Set<NativeAuthorityUnavailableReason>([
  "unsupported_platform",
  "unsupported_os_version",
  "launcher_unavailable",
  "broker_unavailable",
  "protocol_mismatch",
  "peer_identity_unverified",
  "production_signing_required",
  "keychain_unavailable",
  "unsupported_operation",
]);

const missing = Symbol("missing native authority field");

type UnknownRecord = object;

export class NativeAuthorityService implements NativeAuthorityStatusPort {
  readonly #port: NativeAuthorityStatusPort;
  readonly #close: (() => void) | undefined;
  #closed = false;

  constructor(port: NativeAuthorityStatusPort, close?: () => void) {
    this.#port = port;
    this.#close = close;
  }

  async status(signal?: AbortSignal): Promise<NativeAuthorityStatus> {
    if (isCancelled(signal)) throw cancellation();
    if (this.#closed) return UNAVAILABLE;
    try {
      const source: unknown = await this.#port.status(signal);
      if (isCancelled(signal)) throw cancellation();
      if (this.#closed) return UNAVAILABLE;
      const status = sanitizeStatus(source);
      if (isCancelled(signal)) throw cancellation();
      if (this.#closed) return UNAVAILABLE;
      return status;
    } catch (error) {
      if (isCancelled(signal) || isAbortError(error)) {
        throw cancellation();
      }
      return UNAVAILABLE;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#close?.();
    } catch {
      // Closing is terminal and never exposes implementation details.
    }
  }
}

function sanitizeStatus(source: unknown): NativeAuthorityStatus {
  if (!isRecord(source)) return UNAVAILABLE;
  const state = ownData(source, "state");
  if (state === "unavailable") {
    const reason = ownData(source, "reason");
    return isUnavailableReason(reason)
      ? Object.freeze({ state, reason })
      : UNAVAILABLE;
  }
  if (state !== "ready") return UNAVAILABLE;

  const attestation = ownData(source, "attestation");
  const health = ownData(source, "health");
  if (!isRecord(attestation) || !isRecord(health)) return UNAVAILABLE;

  const protocolVersion = ownData(attestation, "protocolVersion");
  const launcherVersion = ownData(attestation, "launcherVersion");
  const brokerVersion = ownData(attestation, "brokerVersion");
  const platform = ownData(attestation, "platform");
  const minimumMacosVersion = ownData(attestation, "minimumMacosVersion");
  const productionSigned = ownData(attestation, "productionSigned");
  const persistentCredentials = ownData(attestation, "persistentCredentials");
  const keychain = ownData(health, "keychain");
  const broker = ownData(health, "broker");
  const peerIdentity = ownData(health, "peerIdentity");

  if (
    protocolVersion !== NATIVE_AUTHORITY_PROTOCOL_VERSION ||
    launcherVersion !== NATIVE_COMPONENT_VERSION ||
    brokerVersion !== NATIVE_COMPONENT_VERSION ||
    platform !== "darwin" ||
    minimumMacosVersion !== "14.4" ||
    productionSigned !== true ||
    persistentCredentials !== true ||
    (keychain !== "available" &&
      keychain !== "locked" &&
      keychain !== "unavailable") ||
    broker !== "available" ||
    peerIdentity !== "verified"
  ) {
    return UNAVAILABLE;
  }

  return Object.freeze({
    state,
    attestation: Object.freeze({
      protocolVersion,
      launcherVersion,
      brokerVersion,
      platform,
      minimumMacosVersion,
      productionSigned,
      persistentCredentials,
    }),
    health: Object.freeze({ keychain, broker, peerIdentity }),
  });
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownData(value: UnknownRecord, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor
    ? descriptor.value
    : missing;
}

function isUnavailableReason(
  value: unknown,
): value is NativeAuthorityUnavailableReason {
  return typeof value === "string" && unavailableReasons.has(
    value as NativeAuthorityUnavailableReason,
  );
}

function cancellation(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  try {
    return signal?.aborted === true;
  } catch {
    return false;
  }
}

function isAbortError(error: unknown): boolean {
  try {
    return error instanceof DOMException && error.name === "AbortError";
  } catch {
    return false;
  }
}
