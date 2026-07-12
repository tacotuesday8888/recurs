import { NATIVE_AUTHORITY_PROTOCOL_VERSION } from "@recurs/contracts";

export const NATIVE_FRAME_MAGIC = 0x52_43_55_52;
export const NATIVE_FRAME_HEADER_BYTES = 16;
export const NATIVE_FRAME_MAX_PAYLOAD_BYTES = 64 * 1024;

export enum NativeMessageType {
  hello = 1,
  helloResult = 2,
  health = 3,
  healthResult = 4,
  cancel = 5,
  safeFailure = 255,
}
Object.freeze(NativeMessageType);

export type NativeCodecErrorCode =
  | "invalid_frame"
  | "truncated_frame"
  | "decoder_finished"
  | "decoder_failed"
  | "invalid_field_table"
  | "invalid_field"
  | "invalid_message";

const nativeCodecErrorMessages: Readonly<Record<NativeCodecErrorCode, string>> =
  Object.freeze({
    invalid_frame: "Invalid native authority frame.",
    truncated_frame: "Truncated native authority frame.",
    decoder_finished: "Native authority decoder is finished.",
    decoder_failed: "Native authority decoder has failed.",
    invalid_field_table: "Invalid native authority field table.",
    invalid_field: "Invalid native authority field.",
    invalid_message: "Invalid native authority message.",
  });

export class NativeCodecError extends Error {
  readonly code: NativeCodecErrorCode;

  constructor(code: NativeCodecErrorCode) {
    super(nativeCodecErrorMessages[code]);
    this.name = "NativeCodecError";
    this.code = code;
  }
}

export function failNativeCodec(code: NativeCodecErrorCode): never {
  throw new NativeCodecError(code);
}

export interface NativeFrame {
  readonly type: NativeMessageType;
  readonly requestId: number;
  readonly payload: Uint8Array;
}

function isNativeMessageType(value: number): value is NativeMessageType {
  switch (value) {
    case NativeMessageType.hello:
    case NativeMessageType.helloResult:
    case NativeMessageType.health:
    case NativeMessageType.healthResult:
    case NativeMessageType.cancel:
    case NativeMessageType.safeFailure:
      return true;
    default:
      return false;
  }
}

function isU32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function validateFrameParts(
  type: number,
  requestId: number,
  payloadLength: number,
): asserts type is NativeMessageType {
  if (
    !isNativeMessageType(type) ||
    !isU32(requestId) ||
    requestId === 0 ||
    !Number.isInteger(payloadLength) ||
    payloadLength < 0 ||
    payloadLength > NATIVE_FRAME_MAX_PAYLOAD_BYTES
  ) {
    failNativeCodec("invalid_frame");
  }
}

function createNativeFrame(
  type: NativeMessageType,
  requestId: number,
  payload: Uint8Array,
): NativeFrame {
  const storedPayload = new Uint8Array(payload);
  return Object.freeze({
    type,
    requestId,
    get payload(): Uint8Array {
      return new Uint8Array(storedPayload);
    },
  });
}

export function encodeNativeFrame(frame: NativeFrame): Uint8Array {
  const payload = frame.payload;
  if (!(payload instanceof Uint8Array)) {
    failNativeCodec("invalid_frame");
  }
  validateFrameParts(frame.type, frame.requestId, payload.byteLength);

  const encoded = new Uint8Array(NATIVE_FRAME_HEADER_BYTES + payload.byteLength);
  const view = new DataView(encoded.buffer);
  view.setUint32(0, NATIVE_FRAME_MAGIC, false);
  view.setUint16(4, NATIVE_AUTHORITY_PROTOCOL_VERSION, false);
  view.setUint16(6, frame.type, false);
  view.setUint32(8, payload.byteLength, false);
  view.setUint32(12, frame.requestId, false);
  encoded.set(payload, NATIVE_FRAME_HEADER_BYTES);
  return encoded;
}

interface ParsedHeader {
  readonly type: NativeMessageType;
  readonly requestId: number;
  readonly payloadLength: number;
  readonly frameLength: number;
}

function parseHeader(bytes: Uint8Array, offset: number): ParsedHeader {
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + offset,
    NATIVE_FRAME_HEADER_BYTES,
  );
  const magic = view.getUint32(0, false);
  const protocolVersion = view.getUint16(4, false);
  const type = view.getUint16(6, false);
  const payloadLength = view.getUint32(8, false);
  const requestId = view.getUint32(12, false);

  if (
    magic !== NATIVE_FRAME_MAGIC ||
    protocolVersion !== NATIVE_AUTHORITY_PROTOCOL_VERSION
  ) {
    failNativeCodec("invalid_frame");
  }
  validateFrameParts(type, requestId, payloadLength);
  return Object.freeze({
    type,
    requestId,
    payloadLength,
    frameLength: NATIVE_FRAME_HEADER_BYTES + payloadLength,
  });
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

type DecoderState = "open" | "finished" | "failed";

export class NativeFrameDecoder {
  #state: DecoderState = "open";
  #buffer: Uint8Array = new Uint8Array();

  push(chunk: Uint8Array): readonly NativeFrame[] {
    this.#ensureOpen();
    if (!(chunk instanceof Uint8Array)) {
      this.#poison();
      failNativeCodec("invalid_frame");
    }

    const frames: NativeFrame[] = [];
    let offset = 0;
    try {
      while (offset < chunk.byteLength || this.#buffer.byteLength > 0) {
        if (this.#buffer.byteLength > 0) {
          if (this.#buffer.byteLength < NATIVE_FRAME_HEADER_BYTES) {
            const take = Math.min(
              NATIVE_FRAME_HEADER_BYTES - this.#buffer.byteLength,
              chunk.byteLength - offset,
            );
            if (take > 0) {
              this.#buffer = appendBytes(
                this.#buffer,
                chunk.subarray(offset, offset + take),
              );
              offset += take;
            }
            if (this.#buffer.byteLength < NATIVE_FRAME_HEADER_BYTES) {
              break;
            }
          }

          const header = parseHeader(this.#buffer, 0);
          const take = Math.min(
            header.frameLength - this.#buffer.byteLength,
            chunk.byteLength - offset,
          );
          if (take > 0) {
            this.#buffer = appendBytes(
              this.#buffer,
              chunk.subarray(offset, offset + take),
            );
            offset += take;
          }
          if (this.#buffer.byteLength < header.frameLength) {
            break;
          }
          frames.push(createNativeFrame(
            header.type,
            header.requestId,
            this.#buffer.subarray(NATIVE_FRAME_HEADER_BYTES, header.frameLength),
          ));
          this.#buffer = new Uint8Array();
          continue;
        }

        const remaining = chunk.byteLength - offset;
        if (remaining < NATIVE_FRAME_HEADER_BYTES) {
          this.#buffer = chunk.slice(offset);
          offset = chunk.byteLength;
          break;
        }

        const header = parseHeader(chunk, offset);
        if (remaining < header.frameLength) {
          this.#buffer = chunk.slice(offset);
          offset = chunk.byteLength;
          break;
        }
        frames.push(createNativeFrame(
          header.type,
          header.requestId,
          chunk.subarray(
            offset + NATIVE_FRAME_HEADER_BYTES,
            offset + header.frameLength,
          ),
        ));
        offset += header.frameLength;
      }
    } catch (error) {
      this.#poison();
      if (error instanceof NativeCodecError) {
        throw error;
      }
      failNativeCodec("invalid_frame");
    }

    return Object.freeze(frames);
  }

  finish(): void {
    this.#ensureOpen();
    if (this.#buffer.byteLength !== 0) {
      this.#poison();
      failNativeCodec("truncated_frame");
    }
    this.#state = "finished";
  }

  #ensureOpen(): void {
    if (this.#state === "finished") {
      failNativeCodec("decoder_finished");
    }
    if (this.#state === "failed") {
      failNativeCodec("decoder_failed");
    }
  }

  #poison(): void {
    this.#buffer = new Uint8Array();
    this.#state = "failed";
  }
}
