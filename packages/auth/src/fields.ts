import {
  NATIVE_FRAME_MAX_PAYLOAD_BYTES,
  NativeCodecError,
  failNativeCodec,
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
  } catch (error) {
    if (error instanceof NativeCodecError && error.code === code) {
      throw error;
    }
    failNativeCodec(code);
  }
}

function isBoundedInteger(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= maximum;
}

function requireExactBytes(value: Uint8Array, length: number): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    failNativeCodec("invalid_field");
  }
  rejectSharedByteStorage(value, "invalid_field");
}

function rejectSharedByteStorage(
  value: Uint8Array,
  code: "invalid_field" | "invalid_field_table",
): void {
  const storage = value.buffer;
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
    const encoded = new Uint8Array(2);
    new DataView(encoded.buffer).setUint16(0, value, false);
    return encoded;
  });
}

export function decodeU16(value: Uint8Array): number {
  return withFixedCodecError("invalid_field", () => {
    requireExactBytes(value, 2);
    return new DataView(value.buffer, value.byteOffset, 2).getUint16(0, false);
  });
}

export function encodeU32(value: number): Uint8Array {
  return withFixedCodecError("invalid_field", () => {
    if (!isBoundedInteger(value, 0xffff_ffff)) {
      failNativeCodec("invalid_field");
    }
    const encoded = new Uint8Array(4);
    new DataView(encoded.buffer).setUint32(0, value, false);
    return encoded;
  });
}

export function decodeU32(value: Uint8Array): number {
  return withFixedCodecError("invalid_field", () => {
    requireExactBytes(value, 4);
    return new DataView(value.buffer, value.byteOffset, 4).getUint32(0, false);
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
    const encoded = new Uint8Array(8);
    new DataView(encoded.buffer).setBigUint64(0, value, false);
    return encoded;
  });
}

export function decodeU64(value: Uint8Array): bigint {
  return withFixedCodecError("invalid_field", () => {
    requireExactBytes(value, 8);
    return new DataView(value.buffer, value.byteOffset, 8).getBigUint64(0, false);
  });
}

export function encodeBoolean(value: boolean): Uint8Array {
  return withFixedCodecError("invalid_field", () => {
    if (typeof value !== "boolean") {
      failNativeCodec("invalid_field");
    }
    return Uint8Array.of(value ? 1 : 0);
  });
}

export function decodeBoolean(value: Uint8Array): boolean {
  return withFixedCodecError("invalid_field", () => {
    requireExactBytes(value, 1);
    if (value[0] === 0) {
      return false;
    }
    if (value[0] === 1) {
      return true;
    }
    failNativeCodec("invalid_field");
  });
}

export function encodeNonce(value: Uint8Array): Uint8Array {
  return withFixedCodecError("invalid_field", () => {
    requireExactBytes(value, NATIVE_NONCE_BYTES);
    return new Uint8Array(value);
  });
}

export function decodeNonce(value: Uint8Array): Uint8Array {
  return withFixedCodecError("invalid_field", () => {
    requireExactBytes(value, NATIVE_NONCE_BYTES);
    return new Uint8Array(value);
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
      encoded.byteLength === 0 ||
      encoded.byteLength > NATIVE_TEXT_MAX_UTF8_BYTES
    ) {
      failNativeCodec("invalid_field");
    }
    return encoded;
  });
}

export function decodeVersionText(value: Uint8Array): string {
  return withFixedCodecError("invalid_field", () => {
    if (
      !(value instanceof Uint8Array) ||
      value.byteLength === 0 ||
      value.byteLength > NATIVE_TEXT_MAX_UTF8_BYTES
    ) {
      failNativeCodec("invalid_field");
    }
    rejectSharedByteStorage(value, "invalid_field");
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(value);
    if (decoded.length === 0) {
      failNativeCodec("invalid_field");
    }
    return decoded;
  });
}

function createNativeField(tag: number, value: Uint8Array): NativeField {
  const storedValue = new Uint8Array(value);
  return Object.freeze({
    tag,
    get value(): Uint8Array {
      return new Uint8Array(storedValue);
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
      if (!(inputValue instanceof Uint8Array)) {
        failNativeCodec("invalid_field_table");
      }
      rejectSharedByteStorage(inputValue, "invalid_field_table");
      const value = new Uint8Array(inputValue);
      encodedLength += 6 + value.byteLength;
      if (encodedLength > NATIVE_FRAME_MAX_PAYLOAD_BYTES) {
        failNativeCodec("invalid_field_table");
      }
      snapshots.push(Object.freeze({ tag, value }));
      previousTag = tag;
    }

    const encoded = new Uint8Array(encodedLength);
    const view = new DataView(encoded.buffer);
    view.setUint16(0, fieldCount, false);
    let offset = 2;
    for (const snapshot of snapshots) {
      view.setUint16(offset, snapshot.tag, false);
      view.setUint32(offset + 2, snapshot.value.byteLength, false);
      encoded.set(snapshot.value, offset + 6);
      offset += 6 + snapshot.value.byteLength;
    }
    return encoded;
  } catch (error) {
    if (
      error instanceof NativeCodecError &&
      error.code === "invalid_field_table"
    ) {
      throw error;
    }
    failNativeCodec("invalid_field_table");
  }
}

export function decodeFieldTable(payload: Uint8Array): readonly NativeField[] {
  return withFixedCodecError("invalid_field_table", () => {
    if (
      !(payload instanceof Uint8Array) ||
      payload.byteLength < 2 ||
      payload.byteLength > NATIVE_FRAME_MAX_PAYLOAD_BYTES
    ) {
      failNativeCodec("invalid_field_table");
    }
    rejectSharedByteStorage(payload, "invalid_field_table");

    const payloadLength = payload.byteLength;
    const view = new DataView(
      payload.buffer,
      payload.byteOffset,
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
        createNativeField(tag, payload.subarray(offset, offset + length)),
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
