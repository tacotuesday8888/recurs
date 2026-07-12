import {
  NATIVE_FRAME_MAX_PAYLOAD_BYTES,
  allocateNativeBytes,
  copyNativeBytes,
  failNativeCodec,
  isNativeByteArray,
  nativeByteLength,
  nativeByteOffset,
  nativeByteStorage,
  nativeByteView,
  writeNativeBytes,
} from "./frame.js";

export const NATIVE_FIELD_MAX_COUNT = 64;
export const NATIVE_TEXT_MAX_UTF8_BYTES = 256;
export const NATIVE_NONCE_BYTES = 32;

export interface NativeField {
  readonly tag: number;
  readonly value: Uint8Array;
}

function withFixedCodecError<T>(
  code: "invalid_field" | "invalid_field_table",
  operation: () => T,
): T {
  try {
    return operation();
  } catch {
    failNativeCodec(code);
  }
}

function isBoundedInteger(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= maximum;
}

function snapshotExactBytes(value: Uint8Array, length: number): Uint8Array {
  if (!isNativeByteArray(value) || nativeByteLength(value) !== length) {
    failNativeCodec("invalid_field");
  }
  rejectSharedByteStorage(value, "invalid_field");
  return copyNativeBytes(value);
}

function rejectSharedByteStorage(
  value: Uint8Array,
  code: "invalid_field" | "invalid_field_table",
): void {
  const storage = nativeByteStorage(value);
  if (
    typeof SharedArrayBuffer !== "undefined" &&
    storage instanceof SharedArrayBuffer
  ) {
    failNativeCodec(code);
  }
}

export function encodeU16(value: number): Uint8Array {
  return withFixedCodecError("invalid_field", () => {
    if (!isBoundedInteger(value, 0xffff)) {
      failNativeCodec("invalid_field");
    }
    const encoded = allocateNativeBytes(2);
    new DataView(nativeByteStorage(encoded)).setUint16(0, value, false);
    return encoded;
  });
}

export function decodeU16(value: Uint8Array): number {
  return withFixedCodecError("invalid_field", () => {
    const snapshot = snapshotExactBytes(value, 2);
    return new DataView(
      nativeByteStorage(snapshot),
      nativeByteOffset(snapshot),
      2,
    ).getUint16(0, false);
  });
}

export function encodeU32(value: number): Uint8Array {
  return withFixedCodecError("invalid_field", () => {
    if (!isBoundedInteger(value, 0xffff_ffff)) {
      failNativeCodec("invalid_field");
    }
    const encoded = allocateNativeBytes(4);
    new DataView(nativeByteStorage(encoded)).setUint32(0, value, false);
    return encoded;
  });
}

export function decodeU32(value: Uint8Array): number {
  return withFixedCodecError("invalid_field", () => {
    const snapshot = snapshotExactBytes(value, 4);
    return new DataView(
      nativeByteStorage(snapshot),
      nativeByteOffset(snapshot),
      4,
    ).getUint32(0, false);
  });
}

export function encodeU64(value: bigint): Uint8Array {
  return withFixedCodecError("invalid_field", () => {
    if (
      typeof value !== "bigint" ||
      value < 0n ||
      value > 0xffff_ffff_ffff_ffffn
    ) {
      failNativeCodec("invalid_field");
    }
    const encoded = allocateNativeBytes(8);
    new DataView(nativeByteStorage(encoded)).setBigUint64(0, value, false);
    return encoded;
  });
}

export function decodeU64(value: Uint8Array): bigint {
  return withFixedCodecError("invalid_field", () => {
    const snapshot = snapshotExactBytes(value, 8);
    return new DataView(
      nativeByteStorage(snapshot),
      nativeByteOffset(snapshot),
      8,
    ).getBigUint64(0, false);
  });
}

export function encodeBoolean(value: boolean): Uint8Array {
  return withFixedCodecError("invalid_field", () => {
    if (typeof value !== "boolean") {
      failNativeCodec("invalid_field");
    }
    const encoded = allocateNativeBytes(1);
    encoded[0] = value ? 1 : 0;
    return encoded;
  });
}

export function decodeBoolean(value: Uint8Array): boolean {
  return withFixedCodecError("invalid_field", () => {
    const snapshot = snapshotExactBytes(value, 1);
    if (snapshot[0] === 0) {
      return false;
    }
    if (snapshot[0] === 1) {
      return true;
    }
    failNativeCodec("invalid_field");
  });
}

export function encodeNonce(value: Uint8Array): Uint8Array {
  return withFixedCodecError("invalid_field", () => {
    return snapshotExactBytes(value, NATIVE_NONCE_BYTES);
  });
}

export function decodeNonce(value: Uint8Array): Uint8Array {
  return withFixedCodecError("invalid_field", () => {
    return snapshotExactBytes(value, NATIVE_NONCE_BYTES);
  });
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function encodeVersionText(value: string): Uint8Array {
  return withFixedCodecError("invalid_field", () => {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > NATIVE_TEXT_MAX_UTF8_BYTES ||
      hasLoneSurrogate(value)
    ) {
      failNativeCodec("invalid_field");
    }
    const encoded = new TextEncoder().encode(value);
    if (
      nativeByteLength(encoded) === 0 ||
      nativeByteLength(encoded) > NATIVE_TEXT_MAX_UTF8_BYTES
    ) {
      failNativeCodec("invalid_field");
    }
    return encoded;
  });
}

export function decodeVersionText(value: Uint8Array): string {
  return withFixedCodecError("invalid_field", () => {
    if (
      !isNativeByteArray(value) ||
      nativeByteLength(value) === 0 ||
      nativeByteLength(value) > NATIVE_TEXT_MAX_UTF8_BYTES
    ) {
      failNativeCodec("invalid_field");
    }
    rejectSharedByteStorage(value, "invalid_field");
    const snapshot = copyNativeBytes(value);
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(snapshot);
    if (decoded.length === 0) {
      failNativeCodec("invalid_field");
    }
    return decoded;
  });
}

function createNativeField(tag: number, value: Uint8Array): NativeField {
  const storedValue = copyNativeBytes(value);
  return Object.freeze({
    tag,
    get value(): Uint8Array {
      return copyNativeBytes(storedValue);
    },
  });
}

function validateTag(tag: number, previousTag: number): void {
  if (
    !isBoundedInteger(tag, 0xffff) ||
    tag === 0 ||
    tag <= previousTag
  ) {
    failNativeCodec("invalid_field_table");
  }
}

export function encodeFieldTable(fields: readonly NativeField[]): Uint8Array {
  try {
    if (!Array.isArray(fields)) {
      failNativeCodec("invalid_field_table");
    }
    const fieldCount = fields.length;
    if (fieldCount > NATIVE_FIELD_MAX_COUNT) {
      failNativeCodec("invalid_field_table");
    }

    let encodedLength = 2;
    let previousTag = 0;
    const snapshots: { readonly tag: number; readonly value: Uint8Array }[] = [];
    for (let index = 0; index < fieldCount; index += 1) {
      const field = fields[index];
      if (field === undefined || field === null) {
        failNativeCodec("invalid_field_table");
      }
      const tag = field.tag;
      const inputValue = field.value;
      validateTag(tag, previousTag);
      if (!isNativeByteArray(inputValue)) {
        failNativeCodec("invalid_field_table");
      }
      rejectSharedByteStorage(inputValue, "invalid_field_table");
      const value = copyNativeBytes(inputValue);
      encodedLength += 6 + nativeByteLength(value);
      if (encodedLength > NATIVE_FRAME_MAX_PAYLOAD_BYTES) {
        failNativeCodec("invalid_field_table");
      }
      snapshots.push(Object.freeze({ tag, value }));
      previousTag = tag;
    }

    const encoded = allocateNativeBytes(encodedLength);
    const view = new DataView(nativeByteStorage(encoded));
    view.setUint16(0, fieldCount, false);
    let offset = 2;
    for (const snapshot of snapshots) {
      view.setUint16(offset, snapshot.tag, false);
      const valueLength = nativeByteLength(snapshot.value);
      view.setUint32(offset + 2, valueLength, false);
      writeNativeBytes(encoded, snapshot.value, offset + 6);
      offset += 6 + valueLength;
    }
    return encoded;
  } catch {
    failNativeCodec("invalid_field_table");
  }
}

export function decodeFieldTable(payload: Uint8Array): readonly NativeField[] {
  return withFixedCodecError("invalid_field_table", () => {
    if (
      !isNativeByteArray(payload) ||
      nativeByteLength(payload) < 2 ||
      nativeByteLength(payload) > NATIVE_FRAME_MAX_PAYLOAD_BYTES
    ) {
      failNativeCodec("invalid_field_table");
    }
    rejectSharedByteStorage(payload, "invalid_field_table");
    const snapshot = copyNativeBytes(payload);

    const payloadLength = nativeByteLength(snapshot);
    const view = new DataView(
      nativeByteStorage(snapshot),
      nativeByteOffset(snapshot),
      payloadLength,
    );
    const fieldCount = view.getUint16(0, false);
    if (fieldCount > NATIVE_FIELD_MAX_COUNT) {
      failNativeCodec("invalid_field_table");
    }

    const fields: NativeField[] = [];
    let offset = 2;
    let previousTag = 0;
    for (let index = 0; index < fieldCount; index += 1) {
      if (payloadLength - offset < 6) {
        failNativeCodec("invalid_field_table");
      }
      const tag = view.getUint16(offset, false);
      const length = view.getUint32(offset + 2, false);
      validateTag(tag, previousTag);
      offset += 6;
      if (length > payloadLength - offset) {
        failNativeCodec("invalid_field_table");
      }
      fields.push(
        createNativeField(tag, nativeByteView(snapshot, offset, offset + length)),
      );
      offset += length;
      previousTag = tag;
    }
    if (offset !== payloadLength) {
      failNativeCodec("invalid_field_table");
    }
    return Object.freeze(fields);
  });
}
