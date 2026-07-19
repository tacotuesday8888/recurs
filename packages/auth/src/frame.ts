import { NATIVE_AUTHORITY_PROTOCOL_VERSION } from "@recurs/contracts";

export const NATIVE_FRAME_MAGIC = 0x52_43_55_52;
export const NATIVE_FRAME_HEADER_BYTES = 16;
export const NATIVE_FRAME_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const NATIVE_FRAME_MAX_BYTES =
  NATIVE_FRAME_HEADER_BYTES + NATIVE_FRAME_MAX_PAYLOAD_BYTES;
const NativeUint8Array = Uint8Array;
const nativeTypedArrayPrototype = Object.getPrototypeOf(
  NativeUint8Array.prototype,
) as object;
const nativeBufferGetter = Object.getOwnPropertyDescriptor(
  nativeTypedArrayPrototype,
  "buffer",
)?.get as (this: Uint8Array) => ArrayBufferLike;
const nativeByteLengthGetter = Object.getOwnPropertyDescriptor(
  nativeTypedArrayPrototype,
  "byteLength",
)?.get as (this: Uint8Array) => number;
const nativeByteOffsetGetter = Object.getOwnPropertyDescriptor(
  nativeTypedArrayPrototype,
  "byteOffset",
)?.get as (this: Uint8Array) => number;
const nativeSet = NativeUint8Array.prototype.set;
const nativeFill = NativeUint8Array.prototype.fill;

export enum NativeMessageType {
  hello = 1,
  helloResult = 2,
  health = 3,
  healthResult = 4,
  cancel = 5,
  openAIOnboardingRequest = 6,
  openAIOnboardingBegun = 7,
  openAIOnboardingCatalogPage = 8,
  openAIOnboardingCommitted = 9,
  openAIOnboardingAborted = 10,
  openAIOnboardingReconciliation = 11,
  openAIOnboardingFailure = 12,
  openAIGenerationRequest = 13,
  openAIGenerationEvent = 14,
  openAIGenerationFailure = 15,
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

export function isNativeByteArray(value: unknown): value is Uint8Array {
  return value instanceof NativeUint8Array;
}

export function nativeByteStorage(value: Uint8Array): ArrayBufferLike {
  return Reflect.apply(nativeBufferGetter, value, []) as ArrayBufferLike;
}

export function nativeByteLength(value: Uint8Array): number {
  return Reflect.apply(nativeByteLengthGetter, value, []) as number;
}

export function nativeByteOffset(value: Uint8Array): number {
  return Reflect.apply(nativeByteOffsetGetter, value, []) as number;
}

export function nativeByteView(
  value: Uint8Array,
  begin = 0,
  end = nativeByteLength(value),
): Uint8Array {
  const length = nativeByteLength(value);
  if (
    !Number.isInteger(begin) ||
    !Number.isInteger(end) ||
    begin < 0 ||
    end < begin ||
    end > length
  ) {
    throw new RangeError("Invalid native byte view.");
  }
  return new NativeUint8Array(
    nativeByteStorage(value),
    nativeByteOffset(value) + begin,
    end - begin,
  );
}

export function copyNativeBytes(
  value: Uint8Array,
  begin = 0,
  end = nativeByteLength(value),
): Uint8Array {
  return new NativeUint8Array(nativeByteView(value, begin, end));
}

export function allocateNativeBytes(length: number): Uint8Array {
  return new NativeUint8Array(length);
}

export function writeNativeBytes(
  target: Uint8Array,
  source: Uint8Array,
  offset = 0,
): void {
  Reflect.apply(nativeSet, target, [source, offset]);
}

function zeroNativeBytes(
  target: Uint8Array,
  begin: number,
  end: number,
): void {
  Reflect.apply(nativeFill, target, [0, begin, end]);
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
    case NativeMessageType.openAIOnboardingRequest:
    case NativeMessageType.openAIOnboardingBegun:
    case NativeMessageType.openAIOnboardingCatalogPage:
    case NativeMessageType.openAIOnboardingCommitted:
    case NativeMessageType.openAIOnboardingAborted:
    case NativeMessageType.openAIOnboardingReconciliation:
    case NativeMessageType.openAIOnboardingFailure:
    case NativeMessageType.openAIGenerationRequest:
    case NativeMessageType.openAIGenerationEvent:
    case NativeMessageType.openAIGenerationFailure:
    case NativeMessageType.safeFailure:
      return true;
    default:
      return false;
  }
}

function isU32(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

function hasSharedByteStorage(value: Uint8Array): boolean {
  const storage = nativeByteStorage(value);
  return (
    typeof SharedArrayBuffer !== "undefined" &&
    storage instanceof SharedArrayBuffer
  );
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
  const storedPayload = copyNativeBytes(payload);
  return Object.freeze({
    type,
    requestId,
    get payload(): Uint8Array {
      return copyNativeBytes(storedPayload);
    },
  });
}

export function encodeNativeFrame(frame: NativeFrame): Uint8Array {
  try {
    const type = frame.type;
    const requestId = frame.requestId;
    const inputPayload = frame.payload;
    if (
      !isNativeByteArray(inputPayload) ||
      hasSharedByteStorage(inputPayload)
    ) {
      failNativeCodec("invalid_frame");
    }
    const payload = copyNativeBytes(inputPayload);
    const payloadLength = nativeByteLength(payload);
    validateFrameParts(type, requestId, payloadLength);

    const encoded = allocateNativeBytes(
      NATIVE_FRAME_HEADER_BYTES + payloadLength,
    );
    const view = new DataView(nativeByteStorage(encoded));
    view.setUint32(0, NATIVE_FRAME_MAGIC, false);
    view.setUint16(4, NATIVE_AUTHORITY_PROTOCOL_VERSION, false);
    view.setUint16(6, type, false);
    view.setUint32(8, payloadLength, false);
    view.setUint32(12, requestId, false);
    writeNativeBytes(encoded, payload, NATIVE_FRAME_HEADER_BYTES);
    return encoded;
  } catch {
    failNativeCodec("invalid_frame");
  }
}

interface ParsedHeader {
  readonly type: NativeMessageType;
  readonly requestId: number;
  readonly payloadLength: number;
  readonly frameLength: number;
}

function parseHeader(bytes: Uint8Array, offset: number): ParsedHeader {
  const view = new DataView(
    nativeByteStorage(bytes),
    nativeByteOffset(bytes) + offset,
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

type DecoderState = "open" | "finished" | "failed";

export class NativeFrameDecoder {
  #state: DecoderState = "open";
  #buffer: Uint8Array | undefined;
  #bufferedLength = 0;

  push(chunk: Uint8Array): readonly NativeFrame[] {
    this.#ensureOpen();
    const frames: NativeFrame[] = [];
    try {
      if (
        !isNativeByteArray(chunk) ||
        hasSharedByteStorage(chunk)
      ) {
        failNativeCodec("invalid_frame");
      }
      const inputLength = nativeByteLength(chunk);
      let offset = 0;
      while (offset < inputLength || this.#bufferedLength > 0) {
        if (this.#bufferedLength > 0) {
          if (this.#bufferedLength < NATIVE_FRAME_HEADER_BYTES) {
            const take = Math.min(
              NATIVE_FRAME_HEADER_BYTES - this.#bufferedLength,
              inputLength - offset,
            );
            if (take > 0) {
              this.#appendBuffered(chunk, offset, take);
              offset += take;
            }
            if (this.#bufferedLength < NATIVE_FRAME_HEADER_BYTES) {
              break;
            }
          }

          const buffer = this.#buffer;
          if (buffer === undefined) {
            failNativeCodec("invalid_frame");
          }
          const header = parseHeader(buffer, 0);
          const take = Math.min(
            header.frameLength - this.#bufferedLength,
            inputLength - offset,
          );
          if (take > 0) {
            this.#appendBuffered(chunk, offset, take);
            offset += take;
          }
          if (this.#bufferedLength < header.frameLength) {
            break;
          }
          frames.push(createNativeFrame(
            header.type,
            header.requestId,
            nativeByteView(
              buffer,
              NATIVE_FRAME_HEADER_BYTES,
              header.frameLength,
            ),
          ));
          this.#clearBuffered(false);
          continue;
        }

        const remaining = inputLength - offset;
        if (remaining < NATIVE_FRAME_HEADER_BYTES) {
          this.#appendBuffered(chunk, offset, remaining);
          offset = inputLength;
          break;
        }

        const header = parseHeader(chunk, offset);
        if (remaining < header.frameLength) {
          this.#appendBuffered(chunk, offset, remaining);
          offset = inputLength;
          break;
        }
        frames.push(createNativeFrame(
          header.type,
          header.requestId,
          nativeByteView(
            chunk,
            offset + NATIVE_FRAME_HEADER_BYTES,
            offset + header.frameLength,
          ),
        ));
        offset += header.frameLength;
      }
    } catch {
      this.#poison();
      failNativeCodec("invalid_frame");
    }

    return Object.freeze(frames);
  }

  finish(): void {
    this.#ensureOpen();
    if (this.#bufferedLength !== 0) {
      this.#poison();
      failNativeCodec("truncated_frame");
    }
    this.#clearBuffered(true);
    this.#state = "finished";
  }

  #appendBuffered(source: Uint8Array, offset: number, length: number): void {
    if (
      !Number.isInteger(offset) ||
      !Number.isInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > nativeByteLength(source) ||
      this.#bufferedLength + length > NATIVE_FRAME_MAX_BYTES
    ) {
      failNativeCodec("invalid_frame");
    }
    if (length === 0) {
      return;
    }
    const buffer = this.#buffer ?? allocateNativeBytes(NATIVE_FRAME_MAX_BYTES);
    this.#buffer = buffer;
    writeNativeBytes(
      buffer,
      nativeByteView(source, offset, offset + length),
      this.#bufferedLength,
    );
    this.#bufferedLength += length;
  }

  #clearBuffered(release: boolean): void {
    if (this.#buffer !== undefined && this.#bufferedLength > 0) {
      zeroNativeBytes(this.#buffer, 0, this.#bufferedLength);
    }
    this.#bufferedLength = 0;
    if (release) {
      this.#buffer = undefined;
    }
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
    this.#clearBuffered(true);
    this.#state = "failed";
  }
}
