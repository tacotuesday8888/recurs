import type { NativeAuthorityUnavailableReason } from "@recurs/contracts";

import {
  NativeCodecError,
  NativeMessageType,
  encodeNativeFrame,
  failNativeCodec,
} from "./frame.js";
import type { NativeFrame } from "./frame.js";
import {
  decodeBoolean,
  decodeFieldTable,
  decodeNonce,
  decodeU16,
  decodeVersionText,
  encodeFieldTable,
  encodeNonce,
  encodeU32,
  encodeVersionText,
} from "./fields.js";
import type { NativeField } from "./fields.js";

export interface NativeHello {
  readonly engineVersion: string;
  readonly nonce: Uint8Array;
}

export interface NativeHelloResult {
  readonly launcherVersion: string;
  readonly brokerVersion: string;
  readonly echoedNonce: Uint8Array;
  readonly productionSigned: boolean;
  readonly persistentCredentials: boolean;
  readonly minimumMacosVersion: "14.4";
}

export interface NativeHealthResult {
  readonly keychain: "available" | "locked" | "unavailable";
  readonly peerVerified: boolean;
}

export enum NativeKeychainStatusCode {
  available = 1,
  locked = 2,
  unavailable = 3,
}
Object.freeze(NativeKeychainStatusCode);

export enum NativeSafeFailureCode {
  unsupportedPlatform = 1,
  unsupportedOsVersion = 2,
  launcherUnavailable = 3,
  brokerUnavailable = 4,
  protocolMismatch = 5,
  peerIdentityUnverified = 6,
  productionSigningRequired = 7,
  keychainUnavailable = 8,
}
Object.freeze(NativeSafeFailureCode);

function requireExactFields(
  frame: NativeFrame,
  expectedType: NativeMessageType,
  expectedTags: readonly number[],
): readonly NativeField[] {
  if (frame.type !== expectedType) {
    failNativeCodec("invalid_message");
  }
  const fields = decodeFieldTable(frame.payload);
  if (
    fields.length !== expectedTags.length ||
    fields.some((field, index) => field.tag !== expectedTags[index])
  ) {
    failNativeCodec("invalid_message");
  }
  return fields;
}

function decodeSemanticMessage<T>(decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof NativeCodecError && error.code === "invalid_message") {
      throw error;
    }
    failNativeCodec("invalid_message");
  }
}

export function encodeHello(requestId: number, hello: NativeHello): Uint8Array {
  const payload = encodeFieldTable([
    { tag: 1, value: encodeVersionText(hello.engineVersion) },
    { tag: 2, value: encodeNonce(hello.nonce) },
  ]);
  return encodeNativeFrame({ type: NativeMessageType.hello, requestId, payload });
}

export function decodeHelloResult(frame: NativeFrame): NativeHelloResult {
  return decodeSemanticMessage(() => {
    const fields = requireExactFields(
      frame,
      NativeMessageType.helloResult,
      [1, 2, 3, 4, 5, 6],
    );
    const launcherVersion = decodeVersionText(fields[0]?.value ?? new Uint8Array());
    const brokerVersion = decodeVersionText(fields[1]?.value ?? new Uint8Array());
    const echoedNonce = decodeNonce(fields[2]?.value ?? new Uint8Array());
    const productionSigned = decodeBoolean(fields[3]?.value ?? new Uint8Array());
    const persistentCredentials = decodeBoolean(
      fields[4]?.value ?? new Uint8Array(),
    );
    const minimumMacosVersion = decodeVersionText(
      fields[5]?.value ?? new Uint8Array(),
    );
    if (minimumMacosVersion !== "14.4") {
      failNativeCodec("invalid_message");
    }

    const storedNonce = new Uint8Array(echoedNonce);
    return Object.freeze({
      launcherVersion,
      brokerVersion,
      get echoedNonce(): Uint8Array {
        return new Uint8Array(storedNonce);
      },
      productionSigned,
      persistentCredentials,
      minimumMacosVersion,
    });
  });
}

export function encodeHealth(requestId: number): Uint8Array {
  return encodeNativeFrame({
    type: NativeMessageType.health,
    requestId,
    payload: encodeFieldTable([]),
  });
}

const keychainValues = Object.freeze({
  [NativeKeychainStatusCode.available]: "available",
  [NativeKeychainStatusCode.locked]: "locked",
  [NativeKeychainStatusCode.unavailable]: "unavailable",
} as const);

export function decodeHealthResult(frame: NativeFrame): NativeHealthResult {
  return decodeSemanticMessage(() => {
    const fields = requireExactFields(
      frame,
      NativeMessageType.healthResult,
      [1, 2],
    );
    const keychainCode = decodeU16(fields[0]?.value ?? new Uint8Array());
    const keychain = keychainValues[keychainCode as keyof typeof keychainValues];
    if (keychain === undefined) {
      failNativeCodec("invalid_message");
    }
    const peerVerified = decodeBoolean(fields[1]?.value ?? new Uint8Array());
    return Object.freeze({ keychain, peerVerified });
  });
}

export function encodeCancel(
  requestId: number,
  targetRequestId: number,
): Uint8Array {
  if (
    !Number.isInteger(targetRequestId) ||
    targetRequestId <= 0 ||
    targetRequestId > 0xffff_ffff
  ) {
    failNativeCodec("invalid_message");
  }
  return encodeNativeFrame({
    type: NativeMessageType.cancel,
    requestId,
    payload: encodeFieldTable([{ tag: 1, value: encodeU32(targetRequestId) }]),
  });
}

const safeFailureValues: Readonly<Record<number, NativeAuthorityUnavailableReason>> =
  Object.freeze({
    [NativeSafeFailureCode.unsupportedPlatform]: "unsupported_platform",
    [NativeSafeFailureCode.unsupportedOsVersion]: "unsupported_os_version",
    [NativeSafeFailureCode.launcherUnavailable]: "launcher_unavailable",
    [NativeSafeFailureCode.brokerUnavailable]: "broker_unavailable",
    [NativeSafeFailureCode.protocolMismatch]: "protocol_mismatch",
    [NativeSafeFailureCode.peerIdentityUnverified]: "peer_identity_unverified",
    [NativeSafeFailureCode.productionSigningRequired]:
      "production_signing_required",
    [NativeSafeFailureCode.keychainUnavailable]: "keychain_unavailable",
  });

export function decodeSafeFailure(
  frame: NativeFrame,
): NativeAuthorityUnavailableReason {
  return decodeSemanticMessage(() => {
    const fields = requireExactFields(
      frame,
      NativeMessageType.safeFailure,
      [1],
    );
    const code = decodeU16(fields[0]?.value ?? new Uint8Array());
    const reason = safeFailureValues[code];
    if (reason === undefined) {
      failNativeCodec("invalid_message");
    }
    return reason;
  });
}
