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

function isBoundedInteger(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= maximum;
}

function requireExactBytes(value: Uint8Array, length: number): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    failNativeCodec("invalid_field");
  }
}

export function encodeU16(value: number): Uint8Array {
  if (!isBoundedInteger(value, 0xffff)) {
    failNativeCodec("invalid_field");
  }
  const encoded = new Uint8Array(2);
  new DataView(encoded.buffer).setUint16(0, value, false);
  return encoded;
}

export function decodeU16(value: Uint8Array): number {
  requireExactBytes(value, 2);
  return new DataView(value.buffer, value.byteOffset, 2).getUint16(0, false);
}

export function encodeU32(value: number): Uint8Array {
  if (!isBoundedInteger(value, 0xffff_ffff)) {
    failNativeCodec("invalid_field");
  }
  const encoded = new Uint8Array(4);
  new DataView(encoded.buffer).setUint32(0, value, false);
  return encoded;
}

export function decodeU32(value: Uint8Array): number {
  requireExactBytes(value, 4);
  return new DataView(value.buffer, value.byteOffset, 4).getUint32(0, false);
}

export function encodeU64(value: bigint): Uint8Array {
  if (typeof value !== "bigint" || value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    failNativeCodec("invalid_field");
  }
  const encoded = new Uint8Array(8);
  new DataView(encoded.buffer).setBigUint64(0, value, false);
  return encoded;
}

export function decodeU64(value: Uint8Array): bigint {
  requireExactBytes(value, 8);
  return new DataView(value.buffer, value.byteOffset, 8).getBigUint64(0, false);
}

export function encodeBoolean(value: boolean): Uint8Array {
  if (typeof value !== "boolean") {
    failNativeCodec("invalid_field");
  }
  return Uint8Array.of(value ? 1 : 0);
}

export function decodeBoolean(value: Uint8Array): boolean {
  requireExactBytes(value, 1);
  if (value[0] === 0) {
    return false;
  }
  if (value[0] === 1) {
    return true;
  }
  failNativeCodec("invalid_field");
}

export function encodeNonce(value: Uint8Array): Uint8Array {
  requireExactBytes(value, NATIVE_NONCE_BYTES);
  return new Uint8Array(value);
}

export function decodeNonce(value: Uint8Array): Uint8Array {
  requireExactBytes(value, NATIVE_NONCE_BYTES);
  return new Uint8Array(value);
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
  if (typeof value !== "string" || value.length === 0 || hasLoneSurrogate(value)) {
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
}

export function decodeVersionText(value: Uint8Array): string {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength > NATIVE_TEXT_MAX_UTF8_BYTES
  ) {
    failNativeCodec("invalid_field");
  }
  try {
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(value);
    if (decoded.length === 0) {
      failNativeCodec("invalid_field");
    }
    return decoded;
  } catch (error) {
    if (error instanceof NativeCodecError) {
      throw error;
    }
    failNativeCodec("invalid_field");
  }
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
  if (!Array.isArray(fields) || fields.length > NATIVE_FIELD_MAX_COUNT) {
    failNativeCodec("invalid_field_table");
  }

  let encodedLength = 2;
  let previousTag = 0;
  const values: Uint8Array[] = [];
  for (const field of fields) {
    validateTag(field.tag, previousTag);
    const value = field.value;
    if (!(value instanceof Uint8Array)) {
      failNativeCodec("invalid_field_table");
    }
    encodedLength += 6 + value.byteLength;
    if (encodedLength > NATIVE_FRAME_MAX_PAYLOAD_BYTES) {
      failNativeCodec("invalid_field_table");
    }
    values.push(new Uint8Array(value));
    previousTag = field.tag;
  }

  const encoded = new Uint8Array(encodedLength);
  const view = new DataView(encoded.buffer);
  view.setUint16(0, fields.length, false);
  let offset = 2;
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const value = values[index];
    if (field === undefined || value === undefined) {
      failNativeCodec("invalid_field_table");
    }
    view.setUint16(offset, field.tag, false);
    view.setUint32(offset + 2, value.byteLength, false);
    encoded.set(value, offset + 6);
    offset += 6 + value.byteLength;
  }
  return encoded;
}

export function decodeFieldTable(payload: Uint8Array): readonly NativeField[] {
  if (
    !(payload instanceof Uint8Array) ||
    payload.byteLength < 2 ||
    payload.byteLength > NATIVE_FRAME_MAX_PAYLOAD_BYTES
  ) {
    failNativeCodec("invalid_field_table");
  }

  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength,
  );
  const fieldCount = view.getUint16(0, false);
  if (fieldCount > NATIVE_FIELD_MAX_COUNT) {
    failNativeCodec("invalid_field_table");
  }

  const fields: NativeField[] = [];
  let offset = 2;
  let previousTag = 0;
  for (let index = 0; index < fieldCount; index += 1) {
    if (payload.byteLength - offset < 6) {
      failNativeCodec("invalid_field_table");
    }
    const tag = view.getUint16(offset, false);
    const length = view.getUint32(offset + 2, false);
    validateTag(tag, previousTag);
    offset += 6;
    if (length > payload.byteLength - offset) {
      failNativeCodec("invalid_field_table");
    }
    fields.push(createNativeField(tag, payload.subarray(offset, offset + length)));
    offset += length;
    previousTag = tag;
  }
  if (offset !== payload.byteLength) {
    failNativeCodec("invalid_field_table");
  }
  return Object.freeze(fields);
}
