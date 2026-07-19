import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import {
  NATIVE_FRAME_HEADER_BYTES,
  NATIVE_FRAME_MAGIC,
  NATIVE_FRAME_MAX_PAYLOAD_BYTES,
  NATIVE_TEXT_MAX_UTF8_BYTES,
  NativeCodecError,
  NativeFrameDecoder,
  NativeKeychainStatusCode,
  NativeMessageType,
  NativeSafeFailureCode,
  decodeBoolean,
  decodeFieldTable,
  decodeHealthResult,
  decodeHelloResult,
  decodeNonce,
  decodeSafeFailure,
  decodeU16,
  decodeU32,
  decodeU64,
  decodeVersionText,
  encodeBoolean,
  encodeCancel,
  encodeFieldTable,
  encodeHealth,
  encodeHello,
  encodeNativeFrame,
  encodeNonce,
  encodeU16,
  encodeU32,
  encodeU64,
  encodeVersionText,
} from "../src/index.js";
import type {
  NativeCodecErrorCode,
  NativeField,
  NativeFrame,
} from "../src/index.js";

interface GoldenFixture {
  readonly schemaVersion: 1;
  readonly frames: readonly {
    readonly name:
      | "hello"
      | "helloResult"
      | "health"
      | "healthResult"
      | "safeFailure";
    readonly requestId: number;
    readonly hex: string;
  }[];
}

const nonce = Uint8Array.from({ length: 32 }, (_, index) => index);
const messageTypesByFixtureName = {
  hello: NativeMessageType.hello,
  helloResult: NativeMessageType.helloResult,
  health: NativeMessageType.health,
  healthResult: NativeMessageType.healthResult,
  safeFailure: NativeMessageType.safeFailure,
} as const;

class HostileByteSubclass extends Uint8Array {
  override subarray(): Uint8Array {
    return new Uint8Array();
  }

  override slice(): Uint8Array {
    return new Uint8Array();
  }
}

function addHostileByteAccessors<T extends Uint8Array>(value: T): T {
  Object.defineProperties(value, {
    buffer: {
      configurable: true,
      get() {
        throw new Error("HOSTILE_BUFFER_ACCESSOR");
      },
    },
    byteLength: {
      configurable: true,
      get() {
        return 0;
      },
    },
    byteOffset: {
      configurable: true,
      get() {
        throw new Error("HOSTILE_OFFSET_ACCESSOR");
      },
    },
  });
  return value;
}

function fromHex(hex: string): Uint8Array {
  expect(hex).toMatch(/^(?:[0-9a-f]{2})+$/u);
  return Uint8Array.from(
    hex.match(/../gu)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}

function toHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function testU16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, false);
  return bytes;
}

function testU32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function rawFieldTable(
  fields: readonly { readonly tag: number; readonly value: Uint8Array }[],
  declaredCount = fields.length,
): Uint8Array {
  return concatBytes(
    testU16(declaredCount),
    ...fields.flatMap(({ tag, value }) => [
      testU16(tag),
      testU32(value.byteLength),
      value,
    ]),
  );
}

function rawFrame(
  type: number,
  requestId: number,
  payload: Uint8Array,
  options: {
    readonly magic?: number;
    readonly protocolVersion?: number;
    readonly advertisedPayloadLength?: number;
  } = {},
): Uint8Array {
  const header = new Uint8Array(NATIVE_FRAME_HEADER_BYTES);
  const view = new DataView(header.buffer);
  view.setUint32(0, options.magic ?? NATIVE_FRAME_MAGIC, false);
  view.setUint16(4, options.protocolVersion ?? 1, false);
  view.setUint16(6, type, false);
  view.setUint32(
    8,
    options.advertisedPayloadLength ?? payload.byteLength,
    false,
  );
  view.setUint32(12, requestId, false);
  return concatBytes(header, payload);
}

function nativeFrame(
  type: NativeMessageType,
  requestId: number,
  payload: Uint8Array,
): NativeFrame {
  const decoder = new NativeFrameDecoder();
  const frames = decoder.push(rawFrame(type, requestId, payload));
  decoder.finish();
  expect(frames).toHaveLength(1);
  const frame = frames[0];
  if (frame === undefined) {
    throw new Error("test setup failed");
  }
  return frame;
}

function captureCodecError(
  operation: () => unknown,
  code: NativeCodecErrorCode,
): NativeCodecError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(NativeCodecError);
    const codecError = error as NativeCodecError;
    expect(codecError.code).toBe(code);
    expect(codecError.message).not.toMatch(
      /canary|credential|authorization|token|secret|keychain|native text/iu,
    );
    return codecError;
  }
  throw new Error(`expected NativeCodecError ${code}`);
}

function mutatedCodecError(
  code: NativeCodecErrorCode,
  message: string,
): NativeCodecError {
  const error = new NativeCodecError(code);
  error.message = message;
  return error;
}

async function loadGoldenFixture(): Promise<{
  readonly fixture: GoldenFixture;
  readonly source: string;
}> {
  const source = await readFile(
    new URL("../../../tests/fixtures/native-authority/frames.json", import.meta.url),
    "utf8",
  );
  return {
    fixture: JSON.parse(source) as GoldenFixture,
    source,
  };
}

describe("native authority golden frames", () => {
  it("declares exactly the single contract dependency", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly dependencies?: unknown };

    expect(manifest.dependencies).toStrictEqual({
      "@recurs/contracts": "0.0.0",
    });
  });

  it("keeps the cross-language fixture canonical and explicit", async () => {
    const { fixture, source } = await loadGoldenFixture();

    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.frames.map(({ name, requestId }) => ({ name, requestId })))
      .toStrictEqual([
        { name: "hello", requestId: 1 },
        { name: "helloResult", requestId: 2 },
        { name: "health", requestId: 3 },
        { name: "healthResult", requestId: 4 },
        { name: "safeFailure", requestId: 5 },
      ]);
    expect(source).toBe(`${JSON.stringify(fixture, null, 2)}\n`);
    expect(fixture.frames.every(({ hex }) => /^(?:[0-9a-f]{2})+$/u.test(hex)))
      .toBe(true);
    expect(fixture.frames.find(({ name }) => name === "health")?.hex.endsWith("0000"))
      .toBe(true);
  });

  it("keeps the Swift fixture copy byte-identical to the canonical fixture", async () => {
    const [canonical, swiftCopy] = await Promise.all([
      readFile(
        new URL(
          "../../../tests/fixtures/native-authority/frames.json",
          import.meta.url,
        ),
      ),
      readFile(
        new URL(
          "../../../native/macos/Tests/Fixtures/frames.json",
          import.meta.url,
        ),
      ),
    ]);

    expect(Buffer.compare(swiftCopy, canonical)).toBe(0);
  });

  it("decodes and re-encodes every fixture at every split point", async () => {
    const { fixture } = await loadGoldenFixture();

    for (const golden of fixture.frames) {
      const bytes = fromHex(golden.hex);
      for (let split = 0; split <= bytes.byteLength; split += 1) {
        const decoder = new NativeFrameDecoder();
        const frames = [
          ...decoder.push(bytes.subarray(0, split)),
          ...decoder.push(bytes.subarray(split)),
        ];
        decoder.finish();

        expect(frames).toHaveLength(1);
        const frame = frames[0];
        expect(frame?.type).toBe(messageTypesByFixtureName[golden.name]);
        expect(frame?.requestId).toBe(golden.requestId);
        expect(frame === undefined ? "" : toHex(encodeNativeFrame(frame)))
          .toBe(golden.hex);
      }
    }
  });

  it("matches the exact semantic fixture values", async () => {
    const { fixture } = await loadGoldenFixture();
    const decoded = new Map<string, NativeFrame>();
    for (const golden of fixture.frames) {
      const decoder = new NativeFrameDecoder();
      const frame = decoder.push(fromHex(golden.hex))[0];
      decoder.finish();
      if (frame === undefined) {
        throw new Error("test setup failed");
      }
      decoded.set(golden.name, frame);
    }

    expect(decodeFieldTable(decoded.get("hello")?.payload ?? new Uint8Array()))
      .toEqual([
        { tag: 1, value: new TextEncoder().encode("0.1.0") },
        { tag: 2, value: nonce },
      ]);
    expect(decodeHelloResult(decoded.get("helloResult") as NativeFrame))
      .toEqual({
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        echoedNonce: nonce,
        productionSigned: true,
        persistentCredentials: true,
        minimumMacosVersion: "14.4",
      });
    expect(decodeFieldTable(decoded.get("health")?.payload ?? new Uint8Array()))
      .toEqual([]);
    expect(decodeHealthResult(decoded.get("healthResult") as NativeFrame))
      .toEqual({ keychain: "available", peerVerified: true });
    expect(decodeSafeFailure(decoded.get("safeFailure") as NativeFrame))
      .toBe("protocol_mismatch");
  });

  it("produces the byte-identical fixtures from semantic encoders", async () => {
    const { fixture } = await loadGoldenFixture();
    const byName = new Map(fixture.frames.map((frame) => [frame.name, frame.hex]));

    expect(toHex(encodeHello(1, { engineVersion: "0.1.0", nonce })))
      .toBe(byName.get("hello"));
    expect(toHex(encodeHealth(3))).toBe(byName.get("health"));
    expect(toHex(encodeCancel(9, 7))).toBe(
      "52435552000100050000000c00000009000100010000000400000007",
    );
  });
});

describe("bounded native frame decoder", () => {
  it("uses the exact header constants and fixed wire message values", () => {
    expect(NATIVE_FRAME_MAGIC).toBe(0x52_43_55_52);
    expect(NATIVE_FRAME_HEADER_BYTES).toBe(16);
    expect(NATIVE_FRAME_MAX_PAYLOAD_BYTES).toBe(8 * 1024 * 1024);
    expect(NativeMessageType).toMatchObject({
      hello: 1,
      helloResult: 2,
      health: 3,
      healthResult: 4,
      cancel: 5,
      safeFailure: 255,
    });
    expect(NativeKeychainStatusCode).toMatchObject({
      available: 1,
      locked: 2,
      unavailable: 3,
    });
    expect(NativeSafeFailureCode).toMatchObject({
      unsupportedPlatform: 1,
      unsupportedOsVersion: 2,
      launcherUnavailable: 3,
      brokerUnavailable: 4,
      protocolMismatch: 5,
      peerIdentityUnverified: 6,
      productionSigningRequired: 7,
      keychainUnavailable: 8,
      unsupportedOperation: 9,
    });
    expect(Object.isFrozen(NativeMessageType)).toBe(true);
    expect(Object.isFrozen(NativeKeychainStatusCode)).toBe(true);
    expect(Object.isFrozen(NativeSafeFailureCode)).toBe(true);
  });

  it.each([
    ["wrong magic", rawFrame(NativeMessageType.health, 1, testU16(0), {
      magic: 0x52_43_55_53,
    })],
    ["wrong protocol", rawFrame(NativeMessageType.health, 1, testU16(0), {
      protocolVersion: 2,
    })],
    ["zero request ID", rawFrame(NativeMessageType.health, 0, testU16(0))],
    ["unknown message type", rawFrame(16, 1, testU16(0))],
    ["zero message type", rawFrame(0, 1, testU16(0))],
    ["oversized body", rawFrame(NativeMessageType.health, 1, new Uint8Array(), {
      advertisedPayloadLength: NATIVE_FRAME_MAX_PAYLOAD_BYTES + 1,
    })],
  ] as const)("rejects and poisons a frame with %s", (_name, bytes) => {
    const decoder = new NativeFrameDecoder();

    captureCodecError(() => decoder.push(bytes), "invalid_frame");
    captureCodecError(() => decoder.push(new Uint8Array()), "decoder_failed");
    captureCodecError(() => decoder.finish(), "decoder_failed");
  });

  it("poisons on a malformed header completed across pushes", () => {
    const bytes = rawFrame(NativeMessageType.health, 1, testU16(0), {
      protocolVersion: 2,
    });
    const decoder = new NativeFrameDecoder();

    expect(decoder.push(bytes.subarray(0, 5))).toEqual([]);
    captureCodecError(() => decoder.push(bytes.subarray(5)), "invalid_frame");
    bytes.fill(0);
    captureCodecError(() => decoder.push(new Uint8Array()), "decoder_failed");
  });

  it("seals successfully only when no incomplete bytes remain", () => {
    const decoder = new NativeFrameDecoder();

    expect(decoder.push(new Uint8Array())).toEqual([]);
    expect(decoder.push(new Uint8Array())).toEqual([]);
    expect(decoder.finish()).toBeUndefined();
    captureCodecError(() => decoder.finish(), "decoder_finished");
    captureCodecError(() => decoder.push(new Uint8Array()), "decoder_finished");
    captureCodecError(() => decoder.push(Uint8Array.of(1)), "decoder_finished");
  });

  it.each([1, NATIVE_FRAME_HEADER_BYTES - 1, NATIVE_FRAME_HEADER_BYTES + 1])(
    "fails closed on a %i-byte truncated stream",
    (length) => {
      const bytes = rawFrame(NativeMessageType.health, 1, testU16(0));
      const decoder = new NativeFrameDecoder();
      expect(decoder.push(bytes.subarray(0, length))).toEqual([]);

      captureCodecError(() => decoder.finish(), "truncated_frame");
      captureCodecError(() => decoder.finish(), "decoder_failed");
      captureCodecError(() => decoder.push(new Uint8Array()), "decoder_failed");
    },
  );

  it("treats trailing bytes as a truncated next frame at end of stream", () => {
    const complete = rawFrame(NativeMessageType.health, 1, testU16(0));
    const decoder = new NativeFrameDecoder();

    expect(decoder.push(concatBytes(complete, Uint8Array.of(0xca)))).toHaveLength(1);
    captureCodecError(() => decoder.finish(), "truncated_frame");
  });

  it("returns multiple complete frames from one push without tracking terminal IDs", () => {
    const first = rawFrame(NativeMessageType.healthResult, 8, rawFieldTable([
      { tag: 1, value: testU16(1) },
      { tag: 2, value: Uint8Array.of(1) },
    ]));
    const repeatedTerminal = new Uint8Array(first);
    const decoder = new NativeFrameDecoder();

    const frames = decoder.push(concatBytes(first, repeatedTerminal));
    decoder.finish();

    expect(Object.isFrozen(frames)).toBe(true);
    expect(frames.map(({ requestId, type }) => ({ requestId, type }))).toEqual([
      { requestId: 8, type: NativeMessageType.healthResult },
      { requestId: 8, type: NativeMessageType.healthResult },
    ]);
  });

  it("copies caller-owned incomplete and complete byte arrays", () => {
    const bytes = rawFrame(NativeMessageType.health, 11, testU16(0));
    const prefix = bytes.slice(0, 8);
    const suffix = bytes.slice(8);
    const decoder = new NativeFrameDecoder();

    expect(decoder.push(prefix)).toEqual([]);
    prefix.fill(0);
    const frames = decoder.push(suffix);
    suffix.fill(0);
    decoder.finish();

    expect(frames).toHaveLength(1);
    expect(frames[0]?.requestId).toBe(11);
    expect(frames[0]?.payload).toEqual(testU16(0));
  });

  it("copies retained bytes from Node Buffers instead of retaining aliases", () => {
    const bytes = rawFrame(NativeMessageType.health, 13, testU16(0));
    const prefix = Buffer.from(bytes.subarray(0, 8));
    const decoder = new NativeFrameDecoder();

    expect(decoder.push(prefix)).toEqual([]);
    prefix.fill(0);
    const frames = decoder.push(bytes.subarray(8));
    decoder.finish();

    expect(frames).toHaveLength(1);
    expect(frames[0]?.requestId).toBe(13);
  });

  it("uses intrinsic views for complete hostile typed-array subclasses", () => {
    const wire = encodeHealth(18);
    const decoder = new NativeFrameDecoder();

    const frames = decoder.push(new HostileByteSubclass(wire));
    decoder.finish();

    expect(frames).toHaveLength(1);
    expect(frames[0]?.requestId).toBe(18);
    expect(frames[0]?.payload).toEqual(testU16(0));
  });

  it("uses intrinsic copies for fragmented hostile typed-array subclasses", () => {
    const wire = encodeHealth(19);
    const decoder = new NativeFrameDecoder();

    expect(decoder.push(new HostileByteSubclass(wire.subarray(0, 8))))
      .toEqual([]);
    const frames = decoder.push(new HostileByteSubclass(wire.subarray(8)));
    decoder.finish();

    expect(frames).toHaveLength(1);
    expect(frames[0]?.requestId).toBe(19);
    expect(frames[0]?.payload).toEqual(testU16(0));
  });

  it("bypasses deceptive typed-array accessors with captured intrinsics", () => {
    const wire = addHostileByteAccessors(
      new HostileByteSubclass(encodeHealth(20)),
    );
    const decoder = new NativeFrameDecoder();

    const frames = decoder.push(wire);
    decoder.finish();

    expect(frames).toHaveLength(1);
    expect(frames[0]?.requestId).toBe(20);
    expect(frames[0]?.payload).toEqual(testU16(0));
  });

  it("rejects SharedArrayBuffer-backed chunks and poisons the decoder", () => {
    const bytes = rawFrame(NativeMessageType.health, 14, testU16(0));
    const shared = new SharedArrayBuffer(bytes.byteLength);
    const sharedBytes = new Uint8Array(shared);
    sharedBytes.set(bytes);
    const decoder = new NativeFrameDecoder();

    captureCodecError(() => decoder.push(sharedBytes), "invalid_frame");
    captureCodecError(() => decoder.push(new Uint8Array()), "decoder_failed");
    captureCodecError(() => decoder.finish(), "decoder_failed");
  });

  it("keeps maximum-frame one-byte fragmentation linearly bounded", async () => {
    const payload = new Uint8Array(NATIVE_FRAME_MAX_PAYLOAD_BYTES);
    const bytes = rawFrame(NativeMessageType.health, 15, payload);
    const NativeUint8Array = Uint8Array;
    let allocatedBytes = 0;
    const TrackingUint8Array = new Proxy(NativeUint8Array, {
      construct(target, argumentsList, newTarget) {
        const [source] = argumentsList;
        if (typeof source === "number") {
          allocatedBytes += source;
        }
        return Reflect.construct(target, argumentsList, newTarget) as Uint8Array;
      },
    });

    vi.stubGlobal("Uint8Array", TrackingUint8Array);
    try {
      vi.resetModules();
      const { NativeFrameDecoder: IsolatedNativeFrameDecoder } = await import(
        "../src/frame.js"
      );
      const decoder = new IsolatedNativeFrameDecoder();
      let decoded: readonly NativeFrame[] = [];
      for (let offset = 0; offset < bytes.byteLength; offset += 1) {
        const frames = decoder.push(bytes.subarray(offset, offset + 1));
        if (frames.length !== 0) {
          decoded = frames;
        }
      }
      decoder.finish();
      expect(decoded).toHaveLength(1);
      expect(decoded[0]?.payload.byteLength).toBe(NATIVE_FRAME_MAX_PAYLOAD_BYTES);
      expect(allocatedBytes).toBeGreaterThanOrEqual(
        NATIVE_FRAME_HEADER_BYTES + NATIVE_FRAME_MAX_PAYLOAD_BYTES,
      );
      expect(allocatedBytes).toBeLessThan(
        4 * (NATIVE_FRAME_HEADER_BYTES + NATIVE_FRAME_MAX_PAYLOAD_BYTES),
      );
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  }, 30_000);

  it("poisons on hostile input branding without leaking caller prose", () => {
    const hostile = new Proxy(new Uint8Array(), {
      getPrototypeOf() {
        throw new Error("CALLER_PROSE_CANARY");
      },
    });
    const decoder = new NativeFrameDecoder();

    const error = captureCodecError(() => decoder.push(hostile), "invalid_frame");
    expect(error.message).not.toContain("CALLER_PROSE_CANARY");
    captureCodecError(() => decoder.push(new Uint8Array()), "decoder_failed");
    captureCodecError(() => decoder.finish(), "decoder_failed");
  });

  it("replaces caller-owned matching decoder errors before poisoning", () => {
    const callerError = mutatedCodecError(
      "invalid_frame",
      "DECODER_NATIVE_ERROR_CANARY",
    );
    const hostile = new Proxy(new Uint8Array(), {
      getPrototypeOf() {
        throw callerError;
      },
    });
    const decoder = new NativeFrameDecoder();

    const error = captureCodecError(() => decoder.push(hostile), "invalid_frame");
    expect(error).not.toBe(callerError);
    expect(error.message).not.toContain("DECODER_NATIVE_ERROR_CANARY");
    captureCodecError(() => decoder.finish(), "decoder_failed");
  });

  it("accepts the exact maximum payload length", () => {
    const payload = new Uint8Array(NATIVE_FRAME_MAX_PAYLOAD_BYTES);
    payload[0] = 0xa5;
    payload[payload.byteLength - 1] = 0x5a;
    const bytes = encodeNativeFrame({
      type: NativeMessageType.health,
      requestId: 16,
      payload,
    });
    const decoder = new NativeFrameDecoder();
    const frames = decoder.push(bytes);
    decoder.finish();

    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload.byteLength).toBe(NATIVE_FRAME_MAX_PAYLOAD_BYTES);
    expect(frames[0]?.payload[0]).toBe(0xa5);
    expect(frames[0]?.payload[NATIVE_FRAME_MAX_PAYLOAD_BYTES - 1]).toBe(0x5a);
  });

  it("snapshots frame getters once before validation and encoding", () => {
    let typeReads = 0;
    let requestIdReads = 0;
    let payloadReads = 0;
    const encoded = encodeNativeFrame({
      get type(): NativeMessageType {
        typeReads += 1;
        return typeReads === 1
          ? NativeMessageType.health
          : 13 as NativeMessageType;
      },
      get requestId(): number {
        requestIdReads += 1;
        return requestIdReads === 1 ? 17 : 0;
      },
      get payload(): Uint8Array {
        payloadReads += 1;
        return testU16(0);
      },
    });
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength);

    expect(view.getUint16(6, false)).toBe(NativeMessageType.health);
    expect(view.getUint32(12, false)).toBe(17);
    expect(typeReads).toBe(1);
    expect(requestIdReads).toBe(1);
    expect(payloadReads).toBe(1);
  });

  it("maps malformed and throwing frame encoder inputs to fixed errors", () => {
    captureCodecError(
      () => encodeNativeFrame(null as never),
      "invalid_frame",
    );
    const error = captureCodecError(
      () => encodeNativeFrame({
        get type(): NativeMessageType {
          throw new Error("FRAME_GETTER_CANARY");
        },
        requestId: 1,
        payload: testU16(0),
      }),
      "invalid_frame",
    );
    expect(error.message).not.toContain("FRAME_GETTER_CANARY");

    const callerError = mutatedCodecError(
      "invalid_frame",
      "FRAME_NATIVE_ERROR_CANARY",
    );
    const replaced = captureCodecError(
      () => encodeNativeFrame({
        get type(): NativeMessageType {
          throw callerError;
        },
        requestId: 1,
        payload: testU16(0),
      }),
      "invalid_frame",
    );
    expect(replaced).not.toBe(callerError);
    expect(replaced.message).not.toContain("FRAME_NATIVE_ERROR_CANARY");
  });

  it("returns frozen frame containers whose payload getter always copies", () => {
    const bytes = rawFrame(NativeMessageType.health, 12, testU16(0));
    const decoder = new NativeFrameDecoder();
    const frames = decoder.push(bytes);
    bytes.fill(0);
    decoder.finish();
    const frame = frames[0];
    if (frame === undefined) {
      throw new Error("test setup failed");
    }

    expect(Object.isFrozen(frame)).toBe(true);
    const firstRead = frame.payload;
    firstRead.fill(0xff);
    expect(frame.payload).toEqual(testU16(0));
    expect(frame.payload).not.toBe(firstRead);
  });

  it.each([
    [{ type: NativeMessageType.health, requestId: 0, payload: testU16(0) }, "invalid_frame"],
    [{ type: NativeMessageType.health, requestId: -1, payload: testU16(0) }, "invalid_frame"],
    [{ type: NativeMessageType.health, requestId: 1.5, payload: testU16(0) }, "invalid_frame"],
    [{
      type: NativeMessageType.health,
      requestId: 0x1_0000_0000,
      payload: testU16(0),
    }, "invalid_frame"],
    [{ type: 16 as NativeMessageType, requestId: 1, payload: testU16(0) }, "invalid_frame"],
    [{
      type: NativeMessageType.health,
      requestId: 1,
      payload: new Uint8Array(NATIVE_FRAME_MAX_PAYLOAD_BYTES + 1),
    }, "invalid_frame"],
  ] as const)("rejects an invalid frame during encoding", (frame, code) => {
    captureCodecError(() => encodeNativeFrame(frame), code);
  });
});

describe("strict field tables and scalar codecs", () => {
  it("snapshots hostile typed-array subclasses before scalar decoding", () => {
    const encoded = addHostileByteAccessors(
      new HostileByteSubclass(Uint8Array.of(0x12, 0x34)),
    );

    expect(decodeU16(encoded)).toBe(0x1234);
  });

  it("uses owned base-array snapshots while decoding field tables", () => {
    const encoded = new HostileByteSubclass(rawFieldTable([
      { tag: 1, value: Uint8Array.of(0xa5) },
    ]));

    expect(decodeFieldTable(encoded)).toEqual([
      { tag: 1, value: Uint8Array.of(0xa5) },
    ]);
  });

  it.each([
    ["decodeU16", Uint8Array.of(0, 1), (value: Uint8Array) => decodeU16(value), "invalid_field"],
    [
      "encodeNonce",
      new Uint8Array(32),
      (value: Uint8Array) => encodeNonce(value),
      "invalid_field",
    ],
    [
      "decodeVersionText",
      Uint8Array.of(0x61),
      (value: Uint8Array) => decodeVersionText(value),
      "invalid_field",
    ],
    [
      "decodeFieldTable",
      Uint8Array.of(0, 0),
      (value: Uint8Array) => decodeFieldTable(value),
      "invalid_field_table",
    ],
  ] as const)("rejects SharedArrayBuffer-backed %s input", (
    _name,
    source,
    decode,
    code,
  ) => {
    const storage = new SharedArrayBuffer(source.byteLength);
    const shared = new Uint8Array(storage);
    shared.set(source);

    captureCodecError(() => decode(shared), code);
  });

  it.each([
    ["decodeU16", (value: Uint8Array) => decodeU16(value), "invalid_field"],
    ["encodeNonce", (value: Uint8Array) => encodeNonce(value), "invalid_field"],
    [
      "decodeFieldTable",
      (value: Uint8Array) => decodeFieldTable(value),
      "invalid_field_table",
    ],
    [
      "decodeVersionText",
      (value: Uint8Array) => decodeVersionText(value),
      "invalid_field",
    ],
  ] as const)("maps hostile %s branding to a fixed error", (_name, decode, code) => {
    const hostile = new Proxy(new Uint8Array(32), {
      getPrototypeOf() {
        throw new Error("DIRECT_BRAND_CANARY");
      },
    });

    const error = captureCodecError(() => decode(hostile), code);
    expect(error.message).not.toContain("DIRECT_BRAND_CANARY");
  });

  it.each([
    ["scalar", "invalid_field", (value: Uint8Array) => decodeU16(value)],
    [
      "table",
      "invalid_field_table",
      (value: Uint8Array) => decodeFieldTable(value),
    ],
  ] as const)("replaces caller-owned matching %s codec errors", (
    _name,
    code,
    decode,
  ) => {
    const callerError = mutatedCodecError(code, "FIELD_NATIVE_ERROR_CANARY");
    const hostile = new Proxy(new Uint8Array(32), {
      getPrototypeOf() {
        throw callerError;
      },
    });

    const error = captureCodecError(() => decode(hostile), code);
    expect(error).not.toBe(callerError);
    expect(error.message).not.toContain("FIELD_NATIVE_ERROR_CANARY");
  });

  it.each([
    ["decodeU32", (value: Uint8Array) => decodeU32(value), "invalid_field"],
    ["decodeNonce", (value: Uint8Array) => decodeNonce(value), "invalid_field"],
    [
      "decodeFieldTable",
      (value: Uint8Array) => decodeFieldTable(value),
      "invalid_field_table",
    ],
    [
      "decodeVersionText",
      (value: Uint8Array) => decodeVersionText(value),
      "invalid_field",
    ],
  ] as const)("maps hostile %s byte length access to a fixed error", (
    _name,
    decode,
    code,
  ) => {
    const hostile = new Proxy(new Uint8Array(32), {
      get(target, property) {
        if (property === "byteLength") {
          throw new Error("DIRECT_LENGTH_CANARY");
        }
        return Reflect.get(target, property, target) as unknown;
      },
    });

    const error = captureCodecError(() => decode(hostile), code);
    expect(error.message).not.toContain("DIRECT_LENGTH_CANARY");
  });

  it("round-trips exact big-endian unsigned integer boundaries", () => {
    expect(toHex(encodeU16(0xabcd))).toBe("abcd");
    expect(decodeU16(fromHex("abcd"))).toBe(0xabcd);
    expect(toHex(encodeU32(0x89abcdef))).toBe("89abcdef");
    expect(decodeU32(fromHex("89abcdef"))).toBe(0x89abcdef);
    expect(toHex(encodeU64(0x0123456789abcdefn))).toBe("0123456789abcdef");
    expect(decodeU64(fromHex("0123456789abcdef"))).toBe(0x0123456789abcdefn);
    expect(decodeU64(encodeU64(0xffffffffffffffffn))).toBe(0xffffffffffffffffn);
  });

  it.each([
    () => encodeU16(-1),
    () => encodeU16(0x1_0000),
    () => encodeU16(1.5),
    () => encodeU32(-1),
    () => encodeU32(0x1_0000_0000),
    () => encodeU32(Number.NaN),
    () => encodeU64(-1n),
    () => encodeU64(0x1_0000_0000_0000_0000n),
    () => decodeU16(Uint8Array.of(1)),
    () => decodeU32(new Uint8Array(5)),
    () => decodeU64(new Uint8Array(7)),
  ])("rejects out-of-range or wrong-width integer values", (operation) => {
    captureCodecError(operation, "invalid_field");
  });

  it("accepts only exact one-byte booleans", () => {
    expect(encodeBoolean(false)).toEqual(Uint8Array.of(0));
    expect(encodeBoolean(true)).toEqual(Uint8Array.of(1));
    expect(decodeBoolean(Uint8Array.of(0))).toBe(false);
    expect(decodeBoolean(Uint8Array.of(1))).toBe(true);
    captureCodecError(() => decodeBoolean(new Uint8Array()), "invalid_field");
    captureCodecError(() => decodeBoolean(Uint8Array.of(2)), "invalid_field");
    captureCodecError(() => decodeBoolean(Uint8Array.of(0, 1)), "invalid_field");
  });

  it("requires exact 32-byte nonces and copies both directions", () => {
    const source = new Uint8Array(nonce);
    const encoded = encodeNonce(source);
    source.fill(0xff);
    expect(encoded).toEqual(nonce);
    const decoded = decodeNonce(encoded);
    encoded.fill(0xff);
    expect(decoded).toEqual(nonce);
    expect(decoded).not.toBe(encoded);

    captureCodecError(() => encodeNonce(new Uint8Array(31)), "invalid_field");
    captureCodecError(() => encodeNonce(new Uint8Array(33)), "invalid_field");
    captureCodecError(() => decodeNonce(new Uint8Array(31)), "invalid_field");
  });

  it("uses fatal bounded UTF-8, preserves BOM, and rejects lone surrogates", () => {
    expect(NATIVE_TEXT_MAX_UTF8_BYTES).toBe(256);
    expect(decodeVersionText(encodeVersionText("0.1.0"))).toBe("0.1.0");
    expect(decodeVersionText(fromHex("efbbbf302e312e30"))).toBe("\ufeff0.1.0");
    expect(toHex(encodeVersionText("\ufeff0.1.0"))).toBe("efbbbf302e312e30");
    expect(decodeVersionText(encodeVersionText("release-🚀"))).toBe("release-🚀");
    expect(decodeVersionText(encodeVersionText("é".repeat(128))))
      .toBe("é".repeat(128));

    captureCodecError(() => encodeVersionText(""), "invalid_field");
    captureCodecError(() => encodeVersionText("a".repeat(257)), "invalid_field");
    captureCodecError(() => encodeVersionText("\ud800"), "invalid_field");
    captureCodecError(() => encodeVersionText("\udfff"), "invalid_field");
    captureCodecError(() => decodeVersionText(new Uint8Array()), "invalid_field");
    captureCodecError(() => decodeVersionText(fromHex("c0af")), "invalid_field");
    captureCodecError(
      () => decodeVersionText(new Uint8Array(NATIVE_TEXT_MAX_UTF8_BYTES + 1).fill(0x61)),
      "invalid_field",
    );
  });

  it("rejects overlong text before invoking TextEncoder", () => {
    const encode = vi.fn(() => {
      throw new Error("TEXT_ENCODER_CALLED");
    });
    vi.stubGlobal("TextEncoder", class {
      encode = encode;
    });
    try {
      captureCodecError(
        () => encodeVersionText("a".repeat(NATIVE_TEXT_MAX_UTF8_BYTES + 1)),
        "invalid_field",
      );
      expect(encode).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("encodes and decodes strictly ascending nonzero fields", () => {
    const firstValue = Uint8Array.of(1, 2, 3);
    const encoded = encodeFieldTable([
      { tag: 1, value: firstValue },
      { tag: 0xffff, value: new Uint8Array() },
    ]);
    firstValue.fill(0xff);
    expect(toHex(encoded)).toBe("0002000100000003010203ffff00000000");

    const decoded = decodeFieldTable(encoded);
    encoded.fill(0xff);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toEqual({ tag: 1, value: Uint8Array.of(1, 2, 3) });
    expect(Object.isFrozen(decoded[0])).toBe(true);
    const exposed = decoded[0]?.value;
    exposed?.fill(0);
    expect(decoded[0]?.value).toEqual(Uint8Array.of(1, 2, 3));
    expect(decoded[0]?.value).not.toBe(exposed);
  });

  it("snapshots each field tag and value once before encoding", () => {
    let tagReads = 0;
    let valueReads = 0;
    const encoded = encodeFieldTable([{
      get tag(): number {
        tagReads += 1;
        return tagReads === 1 ? 1 : 0;
      },
      get value(): Uint8Array {
        valueReads += 1;
        return Uint8Array.of(0xa5);
      },
    }]);

    expect(toHex(encoded)).toBe("0001000100000001a5");
    expect(tagReads).toBe(1);
    expect(valueReads).toBe(1);
  });

  it("maps malformed and throwing field encoder inputs to fixed errors", () => {
    captureCodecError(
      () => encodeFieldTable([null as never]),
      "invalid_field_table",
    );
    const error = captureCodecError(
      () => encodeFieldTable([{
        get tag(): number {
          throw new Error("FIELD_GETTER_CANARY");
        },
        value: new Uint8Array(),
      }]),
      "invalid_field_table",
    );
    expect(error.message).not.toContain("FIELD_GETTER_CANARY");
  });

  it("accepts exactly 64 ascending fields", () => {
    const fields = Array.from({ length: 64 }, (_, index) => ({
      tag: index + 1,
      value: new Uint8Array(),
    }));

    expect(decodeFieldTable(encodeFieldTable(fields))).toHaveLength(64);
  });

  it.each([
    ["zero tag", rawFieldTable([{ tag: 0, value: new Uint8Array() }])],
    ["duplicate tag", rawFieldTable([
      { tag: 1, value: new Uint8Array() },
      { tag: 1, value: new Uint8Array() },
    ])],
    ["descending tag", rawFieldTable([
      { tag: 2, value: new Uint8Array() },
      { tag: 1, value: new Uint8Array() },
    ])],
    ["more than 64 fields", testU16(65)],
    ["truncated count", Uint8Array.of(0)],
    ["truncated field header", concatBytes(testU16(1), testU16(1), Uint8Array.of(0))],
    ["truncated field value", concatBytes(
      testU16(1),
      testU16(1),
      testU32(2),
      Uint8Array.of(1),
    )],
    ["trailing data", concatBytes(testU16(0), Uint8Array.of(0))],
    ["oversized table", new Uint8Array(NATIVE_FRAME_MAX_PAYLOAD_BYTES + 1)],
  ] as const)("rejects a field table with %s", (_name, bytes) => {
    captureCodecError(() => decodeFieldTable(bytes), "invalid_field_table");
  });

  it.each([
    [{ tag: 0, value: new Uint8Array() }],
    [
      { tag: 1, value: new Uint8Array() },
      { tag: 1, value: new Uint8Array() },
    ],
    [
      { tag: 2, value: new Uint8Array() },
      { tag: 1, value: new Uint8Array() },
    ],
    Array.from({ length: 65 }, (_, index) => ({
      tag: index + 1,
      value: new Uint8Array(),
    })),
    [{ tag: 1, value: new Uint8Array(NATIVE_FRAME_MAX_PAYLOAD_BYTES) }],
  ])("rejects an invalid field table during encoding", (fields) => {
    captureCodecError(
      () => encodeFieldTable(fields as readonly NativeField[]),
      "invalid_field_table",
    );
  });
});

describe("strict semantic message codecs", () => {
  const helloResultFields = [
    { tag: 1, value: new TextEncoder().encode("0.1.0") },
    { tag: 2, value: new TextEncoder().encode("0.1.0") },
    { tag: 3, value: nonce },
    { tag: 4, value: Uint8Array.of(1) },
    { tag: 5, value: Uint8Array.of(1) },
    { tag: 6, value: new TextEncoder().encode("14.4") },
  ] as const;
  const healthResultFields = [
    { tag: 1, value: testU16(1) },
    { tag: 2, value: Uint8Array.of(1) },
  ] as const;
  const safeFailureFields = [{ tag: 1, value: testU16(5) }] as const;

  it("maps only the fixed keychain wire values", () => {
    const expected = ["available", "locked", "unavailable"] as const;
    for (let code = 1; code <= expected.length; code += 1) {
      const frame = nativeFrame(
        NativeMessageType.healthResult,
        code,
        rawFieldTable([
          { tag: 1, value: testU16(code) },
          { tag: 2, value: Uint8Array.of(code % 2) },
        ]),
      );
      expect(decodeHealthResult(frame)).toEqual({
        keychain: expected[code - 1],
        peerVerified: code % 2 === 1,
      });
    }

    const frame = nativeFrame(
      NativeMessageType.healthResult,
      1,
      rawFieldTable([
        { tag: 1, value: testU16(4) },
        { tag: 2, value: Uint8Array.of(1) },
      ]),
    );
    captureCodecError(() => decodeHealthResult(frame), "invalid_message");
  });

  it("maps only fixed safe failures to contract-owned snake_case reasons", () => {
    const expected = [
      "unsupported_platform",
      "unsupported_os_version",
      "launcher_unavailable",
      "broker_unavailable",
      "protocol_mismatch",
      "peer_identity_unverified",
      "production_signing_required",
      "keychain_unavailable",
      "unsupported_operation",
    ] as const;

    for (let code = 1; code <= expected.length; code += 1) {
      const frame = nativeFrame(
        NativeMessageType.safeFailure,
        code,
        rawFieldTable([{ tag: 1, value: testU16(code) }]),
      );
      expect(decodeSafeFailure(frame)).toBe(expected[code - 1]);
    }

    for (const code of [0, 10, 0xffff]) {
      const frame = nativeFrame(
        NativeMessageType.safeFailure,
        1,
        rawFieldTable([{ tag: 1, value: testU16(code) }]),
      );
      captureCodecError(() => decodeSafeFailure(frame), "invalid_message");
    }
  });

  it("requires hello result minimumMacosVersion to be exactly 14.4", () => {
    for (const version of ["", "14.3", "14.4.0", "15.0"]) {
      const frame = nativeFrame(
        NativeMessageType.helloResult,
        1,
        rawFieldTable(helloResultFields.map((field) =>
          field.tag === 6
            ? { tag: 6, value: new TextEncoder().encode(version) }
            : field)),
      );
      captureCodecError(() => decodeHelloResult(frame), "invalid_message");
    }
  });

  it.each([
    [
      "helloResult",
      NativeMessageType.helloResult,
      helloResultFields,
      (frame: NativeFrame) => decodeHelloResult(frame),
    ],
    [
      "healthResult",
      NativeMessageType.healthResult,
      healthResultFields,
      (frame: NativeFrame) => decodeHealthResult(frame),
    ],
    [
      "safeFailure",
      NativeMessageType.safeFailure,
      safeFailureFields,
      (frame: NativeFrame) => decodeSafeFailure(frame),
    ],
  ] as const)(
    "rejects unknown, missing, duplicate, and wrong-length %s fields",
    (_name, type, validFields, decode) => {
      const unknown = nativeFrame(
        type,
        1,
        rawFieldTable([
          ...validFields,
          { tag: 0xffff, value: new Uint8Array() },
        ]),
      );
      captureCodecError(() => decode(unknown), "invalid_message");

      const missing = nativeFrame(type, 1, rawFieldTable(validFields.slice(1)));
      captureCodecError(() => decode(missing), "invalid_message");

      const duplicatePayload = rawFieldTable([
        validFields[0],
        validFields[0],
        ...validFields.slice(1),
      ]);
      const duplicate = nativeFrame(type, 1, duplicatePayload);
      captureCodecError(() => decode(duplicate), "invalid_message");

      const wrongLength = nativeFrame(
        type,
        1,
        rawFieldTable([
          { tag: validFields[0].tag, value: new Uint8Array() },
          ...validFields.slice(1),
        ]),
      );
      captureCodecError(() => decode(wrongLength), "invalid_message");
    },
  );

  it("rejects semantic decoding with the wrong frame type", () => {
    const helloAsHealth = nativeFrame(
      NativeMessageType.healthResult,
      1,
      rawFieldTable(helloResultFields),
    );
    const healthAsFailure = nativeFrame(
      NativeMessageType.safeFailure,
      1,
      rawFieldTable(healthResultFields),
    );
    const failureAsHello = nativeFrame(
      NativeMessageType.helloResult,
      1,
      rawFieldTable(safeFailureFields),
    );

    captureCodecError(() => decodeHelloResult(helloAsHealth), "invalid_message");
    captureCodecError(() => decodeHealthResult(healthAsFailure), "invalid_message");
    captureCodecError(() => decodeSafeFailure(failureAsHello), "invalid_message");
  });

  it("rejects malformed semantic scalar fields with fixed safe errors", () => {
    for (const tag of [4, 5]) {
      const malformedBoolean = nativeFrame(
        NativeMessageType.helloResult,
        1,
        rawFieldTable(helloResultFields.map((field) =>
          field.tag === tag ? { tag, value: Uint8Array.of(2) } : field)),
      );
      captureCodecError(() => decodeHelloResult(malformedBoolean), "invalid_message");
    }

    const malformedNonce = nativeFrame(
      NativeMessageType.helloResult,
      1,
      rawFieldTable(helloResultFields.map((field) =>
        field.tag === 3 ? { tag: 3, value: new Uint8Array(31) } : field)),
    );
    captureCodecError(() => decodeHelloResult(malformedNonce), "invalid_message");

    const invalidUtf8 = nativeFrame(
      NativeMessageType.helloResult,
      1,
      rawFieldTable(helloResultFields.map((field) =>
        field.tag === 1 ? { tag: 1, value: fromHex("c0af") } : field)),
    );
    captureCodecError(() => decodeHelloResult(invalidUtf8), "invalid_message");

    const malformedPeer = nativeFrame(
      NativeMessageType.healthResult,
      1,
      rawFieldTable([
        healthResultFields[0],
        { tag: 2, value: Uint8Array.of(2) },
      ]),
    );
    captureCodecError(() => decodeHealthResult(malformedPeer), "invalid_message");
  });

  it("validates semantic encoder inputs and fixed field sets", () => {
    captureCodecError(
      () => encodeHello(0, { engineVersion: "0.1.0", nonce }),
      "invalid_frame",
    );
    captureCodecError(
      () => encodeHello(1, { engineVersion: "", nonce }),
      "invalid_field",
    );
    captureCodecError(
      () => encodeHello(1, { engineVersion: "0.1.0", nonce: new Uint8Array(31) }),
      "invalid_field",
    );
    captureCodecError(() => encodeHealth(0), "invalid_frame");
    captureCodecError(() => encodeCancel(1, 0), "invalid_message");
    captureCodecError(() => encodeCancel(1, 0x1_0000_0000), "invalid_message");
  });

  it("maps malformed and throwing hello inputs to fixed errors", () => {
    captureCodecError(() => encodeHello(1, null as never), "invalid_message");
    const error = captureCodecError(
      () => encodeHello(1, {
        get engineVersion(): string {
          throw new Error("HELLO_GETTER_CANARY");
        },
        nonce,
      }),
      "invalid_message",
    );
    expect(error.message).not.toContain("HELLO_GETTER_CANARY");

    const callerError = mutatedCodecError(
      "invalid_message",
      "HELLO_NATIVE_ERROR_CANARY",
    );
    const replaced = captureCodecError(
      () => encodeHello(1, {
        get engineVersion(): string {
          throw callerError;
        },
        nonce,
      }),
      "invalid_message",
    );
    expect(replaced).not.toBe(callerError);
    expect(replaced.message).not.toContain("HELLO_NATIVE_ERROR_CANARY");
  });

  it("replaces caller-owned matching semantic decoder errors", () => {
    const callerError = mutatedCodecError(
      "invalid_message",
      "SEMANTIC_NATIVE_ERROR_CANARY",
    );
    const frame = {
      get type(): NativeMessageType {
        throw callerError;
      },
      requestId: 1,
      payload: testU16(0),
    };

    const error = captureCodecError(
      () => decodeHealthResult(frame),
      "invalid_message",
    );
    expect(error).not.toBe(callerError);
    expect(error.message).not.toContain("SEMANTIC_NATIVE_ERROR_CANARY");
  });

  it("freezes semantic results and protects echoed nonce storage", () => {
    const frame = nativeFrame(
      NativeMessageType.helloResult,
      1,
      rawFieldTable(helloResultFields),
    );
    const result = decodeHelloResult(frame);
    expect(Object.isFrozen(result)).toBe(true);
    const exposed = result.echoedNonce;
    exposed.fill(0xff);
    expect(result.echoedNonce).toEqual(nonce);
    expect(result.echoedNonce).not.toBe(exposed);

    const health = decodeHealthResult(nativeFrame(
      NativeMessageType.healthResult,
      2,
      rawFieldTable(healthResultFields),
    ));
    expect(Object.isFrozen(health)).toBe(true);
  });

  it("uses captured intrinsic copies for semantic nonce storage", () => {
    const frame = nativeFrame(
      NativeMessageType.helloResult,
      3,
      rawFieldTable(helloResultFields),
    );
    const NativeUint8Array = Uint8Array;
    const HostileUint8Array = new Proxy(NativeUint8Array, {
      construct() {
        throw new Error("DYNAMIC_UINT8ARRAY_CANARY");
      },
    });

    vi.stubGlobal("Uint8Array", HostileUint8Array);
    try {
      const result = decodeHelloResult(frame);
      expect(result.echoedNonce).toEqual(nonce);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
