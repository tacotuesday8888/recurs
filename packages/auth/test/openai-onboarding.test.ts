import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  NativeFrameDecoder,
  NativeCodecError,
  NativeMessageType,
  NativeOpenAIOnboardingFailureCode,
  OPENAI_ONBOARDING_MAX_CATALOG_REQUEST_ID_UTF8_BYTES,
  OPENAI_ONBOARDING_MAX_MODEL_COUNT,
  OPENAI_ONBOARDING_MAX_MODEL_ID_UTF8_BYTES,
  OPENAI_ONBOARDING_MAX_MODEL_IDS_PER_PAGE,
  decodeOpenAIOnboardingAborted,
  decodeOpenAIOnboardingBegun,
  decodeOpenAIOnboardingCatalogPage,
  decodeOpenAIOnboardingCommitted,
  decodeOpenAIOnboardingFailure,
  decodeOpenAIOnboardingReconciliation,
  decodeOpenAIOnboardingRequest,
  encodeOpenAIOnboardingAborted,
  encodeOpenAIOnboardingBegun,
  encodeOpenAIOnboardingCatalogPage,
  encodeOpenAIOnboardingCommitted,
  encodeOpenAIOnboardingFailure,
  encodeOpenAIOnboardingReconciliation,
  encodeOpenAIOnboardingRequest,
  encodeFieldTable,
  encodeNativeFrame,
  encodeU16,
  encodeU32,
} from "../src/index.js";
import type {
  NativeFrame,
  NativeOpenAIOnboardingCatalogPage,
  NativeOpenAIOnboardingRequest,
} from "../src/index.js";

function frame(
  type: NativeMessageType,
  fields: readonly { readonly tag: number; readonly value: Uint8Array }[],
): NativeFrame {
  const decoder = new NativeFrameDecoder();
  const [decoded] = decoder.push(encodeNativeFrame({
    type,
    requestId: 1,
    payload: encodeFieldTable(fields),
  }));
  decoder.finish();
  if (decoded === undefined) {
    throw new Error("test setup failed");
  }
  return decoded;
}

function framePayload(type: NativeMessageType, payload: Uint8Array): NativeFrame {
  const decoder = new NativeFrameDecoder();
  const [decoded] = decoder.push(encodeNativeFrame({ type, requestId: 1, payload }));
  decoder.finish();
  if (decoded === undefined) {
    throw new Error("test setup failed");
  }
  return decoded;
}

function decodeWireFrame(bytes: Uint8Array): NativeFrame {
  const decoder = new NativeFrameDecoder();
  const [decoded] = decoder.push(bytes);
  decoder.finish();
  if (decoded === undefined) {
    throw new Error("test setup failed");
  }
  return decoded;
}

function concatBytes(...values: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    values.reduce((total, value) => total + value.byteLength, 0),
  );
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function captureInvalid(operation: () => unknown): NativeCodecError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(NativeCodecError);
    const codecError = error as NativeCodecError;
    expect(codecError.code).toBe("invalid_message");
    expect(codecError.message).toBe("Invalid native authority message.");
    return codecError;
  }
  throw new Error("expected invalid_message");
}

interface OnboardingGoldenFixture {
  readonly schemaVersion: 1;
  readonly frames: readonly {
    readonly name: string;
    readonly requestId: number;
    readonly hex: string;
  }[];
}

function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/u.test(hex)) {
    throw new Error("invalid test fixture");
  }
  return Uint8Array.from(
    hex.match(/../gu)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}

function toHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function loadFixture(): Promise<{
  readonly fixture: OnboardingGoldenFixture;
  readonly source: string;
}> {
  const source = await readFile(
    new URL(
      "../../../tests/fixtures/native-authority/openai-onboarding.json",
      import.meta.url,
    ),
    "utf8",
  );
  return {
    fixture: JSON.parse(source) as OnboardingGoldenFixture,
    source,
  };
}

describe("native OpenAI onboarding protocol", () => {
  it("round-trips every closed request variant", () => {
    const fingerprint =
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const requests: readonly NativeOpenAIOnboardingRequest[] = [
      { kind: "begin" },
      { kind: "begin_anthropic" },
      { kind: "verify" },
      { kind: "catalog_page", cursor: 128 },
      { kind: "finalize", exactModelId: "gpt-5" },
      { kind: "abort" },
      {
        kind: "reconcile",
        connectionId: "11111111-2222-4333-8444-555555555555",
        credentialIdentityFingerprint: fingerprint,
      },
    ];

    for (const [offset, request] of requests.entries()) {
      const requestId = offset + 1;
      const decoder = new NativeFrameDecoder();
      let encoded: Uint8Array;
      try {
        encoded = encodeOpenAIOnboardingRequest(requestId, request);
      } catch (error) {
        throw new Error(`failed ${request.kind}`, { cause: error });
      }
      const [frame] = decoder.push(encoded);
      decoder.finish();
      expect(frame?.requestId).toBe(requestId);
      expect(frame === undefined ? undefined : decodeOpenAIOnboardingRequest(frame))
        .toEqual(request);
    }
  });

  it("snapshots a request cursor once before validation and encoding", () => {
    let kindReads = 0;
    let cursorReads = 0;
    const request = {
      get kind(): "catalog_page" {
        kindReads += 1;
        return "catalog_page";
      },
      get cursor(): number {
        cursorReads += 1;
        return cursorReads === 1 ? 1 : 0;
      },
    } satisfies NativeOpenAIOnboardingRequest;

    const wire = encodeOpenAIOnboardingRequest(1, request);

    expect(kindReads).toBe(1);
    expect(cursorReads).toBe(1);
    expect(decodeOpenAIOnboardingRequest(decodeWireFrame(wire)))
      .toEqual({ kind: "catalog_page", cursor: 1 });
  });

  it("snapshots every catalog-page property and model element once", () => {
    const propertyReads = {
      cursor: 0,
      totalModelCount: 0,
      nextCursor: 0,
      catalogRequestId: 0,
      modelIds: 0,
    };
    const elementReads = [0, 0];
    const modelIds: string[] = [];
    Object.defineProperties(modelIds, {
      0: {
        configurable: true,
        enumerable: true,
        get(): string {
          elementReads[0] = (elementReads[0] ?? 0) + 1;
          return elementReads[0] === 1 ? "gpt-4.1" : "gpt-5";
        },
      },
      1: {
        configurable: true,
        enumerable: true,
        get(): string {
          elementReads[1] = (elementReads[1] ?? 0) + 1;
          return elementReads[1] === 1 ? "gpt-5" : "gpt-4.1";
        },
      },
    });
    const page = {
      get cursor(): number {
        propertyReads.cursor += 1;
        return 0;
      },
      get totalModelCount(): number {
        propertyReads.totalModelCount += 1;
        return 2;
      },
      get nextCursor(): null {
        propertyReads.nextCursor += 1;
        return null;
      },
      get catalogRequestId(): null {
        propertyReads.catalogRequestId += 1;
        return null;
      },
      get modelIds(): readonly string[] {
        propertyReads.modelIds += 1;
        return modelIds;
      },
    } satisfies NativeOpenAIOnboardingCatalogPage;

    const wire = encodeOpenAIOnboardingCatalogPage(2, page);

    expect(propertyReads).toEqual({
      cursor: 1,
      totalModelCount: 1,
      nextCursor: 1,
      catalogRequestId: 1,
      modelIds: 1,
    });
    expect(elementReads).toEqual([1, 1]);
    expect(decodeOpenAIOnboardingCatalogPage(decodeWireFrame(wire))).toEqual({
      cursor: 0,
      totalModelCount: 2,
      nextCursor: null,
      catalogRequestId: null,
      modelIds: ["gpt-4.1", "gpt-5"],
    });
  });

  it("rejects a hostile catalog model list with a fractional length", () => {
    const modelIds = new Proxy(["gpt-4.1", "gpt-5"], {
      get(target, property, receiver): unknown {
        if (property === "length") {
          return 1.5;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    captureInvalid(() => encodeOpenAIOnboardingCatalogPage(2, {
      cursor: 0,
      totalModelCount: 2,
      nextCursor: null,
      catalogRequestId: null,
      modelIds,
    }));
  });

  it("snapshots every committed property once", () => {
    const propertyReads = {
      connectionId: 0,
      selectedModelId: 0,
      verifiedModelCount: 0,
      catalogRequestId: 0,
    };
    const committed = {
      get connectionId(): string {
        propertyReads.connectionId += 1;
        return "11111111-2222-4333-8444-555555555555";
      },
      get selectedModelId(): string {
        propertyReads.selectedModelId += 1;
        return "gpt-5";
      },
      get verifiedModelCount(): number {
        propertyReads.verifiedModelCount += 1;
        return propertyReads.verifiedModelCount === 1 ? 3 : 0;
      },
      get catalogRequestId(): string {
        propertyReads.catalogRequestId += 1;
        return "req_catalog_1";
      },
    };

    const wire = encodeOpenAIOnboardingCommitted(3, committed);

    expect(propertyReads).toEqual({
      connectionId: 1,
      selectedModelId: 1,
      verifiedModelCount: 1,
      catalogRequestId: 1,
    });
    expect(decodeOpenAIOnboardingCommitted(decodeWireFrame(wire))).toEqual({
      connectionId: "11111111-2222-4333-8444-555555555555",
      selectedModelId: "gpt-5",
      verifiedModelCount: 3,
      catalogRequestId: "req_catalog_1",
    });
  });

  it("round-trips every fixed result and safe failure", () => {
    const connectionId = "11111111-2222-4333-8444-555555555555";
    const credentialIdentityFingerprint =
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const cases = [
      {
        encode: () => encodeOpenAIOnboardingBegun(10, {
          connectionId,
          credentialIdentityFingerprint,
        }),
        decode: decodeOpenAIOnboardingBegun,
        expected: { connectionId, credentialIdentityFingerprint },
      },
      {
        encode: () => encodeOpenAIOnboardingCatalogPage(11, {
          cursor: 0,
          totalModelCount: 3,
          nextCursor: 2,
          catalogRequestId: "req_catalog_1",
          modelIds: ["gpt-4.1", "gpt-5"],
        }),
        decode: decodeOpenAIOnboardingCatalogPage,
        expected: {
          cursor: 0,
          totalModelCount: 3,
          nextCursor: 2,
          catalogRequestId: "req_catalog_1",
          modelIds: ["gpt-4.1", "gpt-5"],
        },
      },
      {
        encode: () => encodeOpenAIOnboardingCommitted(12, {
          connectionId,
          selectedModelId: "gpt-5",
          verifiedModelCount: 3,
          catalogRequestId: "req_catalog_1",
        }),
        decode: decodeOpenAIOnboardingCommitted,
        expected: {
          connectionId,
          selectedModelId: "gpt-5",
          verifiedModelCount: 3,
          catalogRequestId: "req_catalog_1",
        },
      },
      {
        encode: () => encodeOpenAIOnboardingAborted(13),
        decode: decodeOpenAIOnboardingAborted,
        expected: {},
      },
      {
        encode: () => encodeOpenAIOnboardingReconciliation(14, "ready_openai"),
        decode: decodeOpenAIOnboardingReconciliation,
        expected: { status: "ready_openai" },
      },
    ] as const;

    for (const value of cases) {
      const decoder = new NativeFrameDecoder();
      const [frame] = decoder.push(value.encode());
      decoder.finish();
      expect(frame === undefined ? undefined : value.decode(frame as never))
        .toEqual(value.expected);
    }

    for (const code of Object.values(NativeOpenAIOnboardingFailureCode).filter(
      (value): value is NativeOpenAIOnboardingFailureCode => typeof value === "number",
    )) {
      const decoder = new NativeFrameDecoder();
      const [frame] = decoder.push(encodeOpenAIOnboardingFailure(20 + code, code));
      decoder.finish();
      expect(frame === undefined ? undefined : decodeOpenAIOnboardingFailure(frame))
        .toEqual({ code });
    }
  });

  it("freezes the wire enums and broker-aligned bounds", () => {
    expect(NativeMessageType).toMatchObject({
      openAIOnboardingRequest: 6,
      openAIOnboardingBegun: 7,
      openAIOnboardingCatalogPage: 8,
      openAIOnboardingCommitted: 9,
      openAIOnboardingAborted: 10,
      openAIOnboardingReconciliation: 11,
      openAIOnboardingFailure: 12,
    });
    expect(OPENAI_ONBOARDING_MAX_MODEL_IDS_PER_PAGE).toBe(128);
    expect(OPENAI_ONBOARDING_MAX_MODEL_COUNT).toBe(4_096);
    expect(OPENAI_ONBOARDING_MAX_MODEL_ID_UTF8_BYTES).toBe(256);
    expect(OPENAI_ONBOARDING_MAX_CATALOG_REQUEST_ID_UTF8_BYTES).toBe(256);
    expect(Object.values(NativeOpenAIOnboardingFailureCode).filter(
      (value) => typeof value === "number",
    )).toEqual(Array.from({ length: 14 }, (_, index) => index + 1));
  });

  it("accepts the exact page, catalog, model, and frame bounds", () => {
    const modelIds = Array.from({ length: 128 }, (_, index) =>
      `m${index.toString().padStart(3, "0")}${"x".repeat(252)}`
    );
    const page = {
      cursor: 3_968,
      totalModelCount: 4_096,
      nextCursor: null,
      catalogRequestId: "r".repeat(256),
      modelIds,
    } satisfies NativeOpenAIOnboardingCatalogPage;
    const wire = encodeOpenAIOnboardingCatalogPage(0xffff_ffff, page);
    expect(wire.byteLength).toBeLessThanOrEqual(16 + 64 * 1_024);
    const decoder = new NativeFrameDecoder();
    const [decodedFrame] = decoder.push(wire);
    decoder.finish();
    const decoded = decodeOpenAIOnboardingCatalogPage(decodedFrame as NativeFrame);
    expect(decoded).toEqual(page);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded.modelIds)).toBe(true);

    const exactUtf8 = "é".repeat(128);
    const finalize = encodeOpenAIOnboardingRequest(1, {
      kind: "finalize",
      exactModelId: exactUtf8,
    });
    const finalizeDecoder = new NativeFrameDecoder();
    const [finalizeFrame] = finalizeDecoder.push(finalize);
    finalizeDecoder.finish();
    expect(decodeOpenAIOnboardingRequest(finalizeFrame as NativeFrame))
      .toEqual({ kind: "finalize", exactModelId: exactUtf8 });
    expect(() => encodeOpenAIOnboardingRequest(2, {
      kind: "catalog_page",
      cursor: 4_095,
    })).not.toThrow();
  });

  it("rejects every noncanonical constructor bound and sequence", () => {
    const invalidPages: readonly NativeOpenAIOnboardingCatalogPage[] = [
      { cursor: 0, totalModelCount: 0, nextCursor: null, catalogRequestId: null, modelIds: [] },
      { cursor: 0, totalModelCount: 1, nextCursor: null, catalogRequestId: null, modelIds: [] },
      {
        cursor: 0,
        totalModelCount: 129,
        nextCursor: null,
        catalogRequestId: null,
        modelIds: Array.from({ length: 129 }, (_, index) => `m${index.toString().padStart(3, "0")}`),
      },
      { cursor: 0, totalModelCount: 4_097, nextCursor: null, catalogRequestId: null, modelIds: ["gpt-5"] },
      { cursor: 1, totalModelCount: 1, nextCursor: null, catalogRequestId: null, modelIds: ["gpt-5"] },
      { cursor: 0, totalModelCount: 3, nextCursor: 1, catalogRequestId: null, modelIds: ["gpt-4.1", "gpt-5"] },
      { cursor: 0, totalModelCount: 3, nextCursor: null, catalogRequestId: null, modelIds: ["gpt-4.1", "gpt-5"] },
      { cursor: 0, totalModelCount: 2, nextCursor: null, catalogRequestId: null, modelIds: ["gpt-5", "gpt-4.1"] },
      { cursor: 0, totalModelCount: 2, nextCursor: null, catalogRequestId: null, modelIds: ["gpt-5", "gpt-5"] },
      { cursor: 0, totalModelCount: 1, nextCursor: null, catalogRequestId: "request id", modelIds: ["gpt-5"] },
      { cursor: 0, totalModelCount: 1, nextCursor: null, catalogRequestId: "r".repeat(257), modelIds: ["gpt-5"] },
    ];
    for (const page of invalidPages) {
      captureInvalid(() => encodeOpenAIOnboardingCatalogPage(1, page));
    }
    for (const exactModelId of [
      "",
      "bad\nmodel",
      "bad\u007fmodel",
      "x".repeat(257),
      "\ud800",
    ]) {
      captureInvalid(() => encodeOpenAIOnboardingRequest(1, {
        kind: "finalize",
        exactModelId,
      }));
    }
    for (const cursor of [0, 4_096, 0xffff]) {
      captureInvalid(() => encodeOpenAIOnboardingRequest(1, {
        kind: "catalog_page",
        cursor,
      }));
    }
    for (const credentialIdentityFingerprint of [
      "",
      `sha256:${"0".repeat(63)}`,
      `sha256:${"A".repeat(64)}`,
      `sha256:${"g".repeat(64)}`,
    ]) {
      captureInvalid(() => encodeOpenAIOnboardingBegun(1, {
        connectionId: "11111111-2222-4333-8444-555555555555",
        credentialIdentityFingerprint,
      }));
    }
    captureInvalid(() => encodeOpenAIOnboardingBegun(1, {
      connectionId: "00000000-0000-0000-0000-000000000000",
      credentialIdentityFingerprint:
        `sha256:${"0".repeat(64)}`,
    }));
    for (const verifiedModelCount of [0, 4_097]) {
      captureInvalid(() => encodeOpenAIOnboardingCommitted(1, {
        connectionId: "11111111-2222-4333-8444-555555555555",
        selectedModelId: "gpt-5",
        verifiedModelCount,
        catalogRequestId: null,
      }));
    }
  });

  it("rejects wrong types, unknown fields, invalid UTF-8, and unknown enums", () => {
    const malformedRequests = [
      frame(NativeMessageType.health, [{ tag: 1, value: encodeU16(1) }]),
      frame(NativeMessageType.openAIOnboardingRequest, []),
      frame(NativeMessageType.openAIOnboardingRequest, [{ tag: 1, value: encodeU16(99) }]),
      frame(NativeMessageType.openAIOnboardingRequest, [
        { tag: 1, value: encodeU16(1) },
        { tag: 2, value: new Uint8Array() },
      ]),
      frame(NativeMessageType.openAIOnboardingRequest, [{ tag: 1, value: new Uint8Array([1]) }]),
      frame(NativeMessageType.openAIOnboardingRequest, [
        { tag: 1, value: encodeU16(4) },
        { tag: 2, value: new Uint8Array([0xc0, 0xaf]) },
      ]),
    ];
    for (const malformed of malformedRequests) {
      captureInvalid(() => decodeOpenAIOnboardingRequest(malformed));
    }
    captureInvalid(() => decodeOpenAIOnboardingAborted(frame(
      NativeMessageType.openAIOnboardingAborted,
      [{ tag: 1, value: new Uint8Array() }],
    )));
    captureInvalid(() => decodeOpenAIOnboardingReconciliation(frame(
      NativeMessageType.openAIOnboardingReconciliation,
      [{ tag: 1, value: encodeU16(4) }],
    )));
    captureInvalid(() => decodeOpenAIOnboardingFailure(frame(
      NativeMessageType.openAIOnboardingFailure,
      [{ tag: 1, value: encodeU16(15) }],
    )));
  });

  it("rejects duplicate fields, trailing tables, and malformed result payloads", () => {
    const duplicate = concatBytes(
      encodeU16(2),
      encodeU16(1), encodeU32(2), encodeU16(1),
      encodeU16(1), encodeU32(2), encodeU16(1),
    );
    const trailing = concatBytes(
      encodeFieldTable([{ tag: 1, value: encodeU16(1) }]),
      new Uint8Array([0]),
    );
    for (const payload of [duplicate, trailing]) {
      captureInvalid(() => decodeOpenAIOnboardingRequest(framePayload(
        NativeMessageType.openAIOnboardingRequest,
        payload,
      )));
    }

    const nestedTrailing = concatBytes(
      encodeU16(1),
      encodeU16(5),
      new TextEncoder().encode("gpt-5"),
      new Uint8Array([0]),
    );
    captureInvalid(() => decodeOpenAIOnboardingCatalogPage(frame(
      NativeMessageType.openAIOnboardingCatalogPage,
      [
        { tag: 1, value: encodeU16(0) },
        { tag: 2, value: encodeU16(1) },
        { tag: 3, value: encodeU16(0xffff) },
        { tag: 4, value: new Uint8Array() },
        { tag: 5, value: nestedTrailing },
      ],
    )));

    const encodedModelId = new TextEncoder().encode("gpt-5");
    const malformedModelLists = [
      concatBytes(encodeU16(1), encodeU16(6), encodedModelId),
      concatBytes(encodeU16(2), encodeU16(5), encodedModelId),
      concatBytes(encodeU16(1), encodeU16(2), new Uint8Array([0xc0, 0xaf])),
    ];
    for (const modelIds of malformedModelLists) {
      captureInvalid(() => decodeOpenAIOnboardingCatalogPage(frame(
        NativeMessageType.openAIOnboardingCatalogPage,
        [
          { tag: 1, value: encodeU16(0) },
          { tag: 2, value: encodeU16(1) },
          { tag: 3, value: encodeU16(0xffff) },
          { tag: 4, value: new Uint8Array() },
          { tag: 5, value: modelIds },
        ],
      )));
    }

    const validModelList = concatBytes(
      encodeU16(1),
      encodeU16(encodedModelId.byteLength),
      encodedModelId,
    );
    captureInvalid(() => decodeOpenAIOnboardingCatalogPage(frame(
      NativeMessageType.openAIOnboardingCatalogPage,
      [
        { tag: 1, value: encodeU16(0) },
        { tag: 2, value: encodeU16(1) },
        { tag: 3, value: encodeU16(0xffff) },
        { tag: 4, value: new TextEncoder().encode("r".repeat(257)) },
        { tag: 5, value: validModelList },
      ],
    )));

    for (const verifiedModelCount of [0, 4_097]) {
      captureInvalid(() => decodeOpenAIOnboardingCommitted(frame(
        NativeMessageType.openAIOnboardingCommitted,
        [
          { tag: 1, value: new Uint8Array(16).fill(1) },
          { tag: 2, value: encodedModelId },
          { tag: 3, value: encodeU16(verifiedModelCount) },
          { tag: 4, value: new Uint8Array() },
        ],
      )));
    }
  });

  it("keeps failures numeric and never serializes prose", () => {
    const wire = encodeOpenAIOnboardingFailure(
      1,
      NativeOpenAIOnboardingFailureCode.verificationFailed,
    );
    const rendered = new TextDecoder().decode(wire);
    expect(rendered).not.toMatch(/verification|failed|credential|secret/iu);
  });

  it("shares one canonical fixture and round-trips every split point", async () => {
    const { fixture, source } = await loadFixture();
    const expectedNames = [
      "begin", "verify", "catalogPageRequest", "finalize", "abort",
      "reconcile", "begun", "catalogPage", "committed", "aborted",
      "reconciliation", "failure",
    ];
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.frames.map(({ name }) => name)).toEqual(expectedNames);
    expect(fixture.frames.map(({ requestId }) => requestId))
      .toEqual(Array.from({ length: 12 }, (_, index) => index + 101));
    expect(fixture.frames.every((value, index) =>
      index === 0 || value.requestId > (fixture.frames[index - 1]?.requestId ?? 0)
    )).toBe(true);
    expect(source).toBe(`${JSON.stringify(fixture, null, 2)}\n`);
    expect(source).not.toMatch(/recovery|attempt|fence|generation/iu);

    const swiftCopy = await readFile(new URL(
      "../../../native/macos/Tests/Fixtures/openai-onboarding.json",
      import.meta.url,
    ));
    expect(Buffer.compare(swiftCopy, Buffer.from(source))).toBe(0);

    const types: Readonly<Record<string, NativeMessageType>> = {
      begin: NativeMessageType.openAIOnboardingRequest,
      verify: NativeMessageType.openAIOnboardingRequest,
      catalogPageRequest: NativeMessageType.openAIOnboardingRequest,
      finalize: NativeMessageType.openAIOnboardingRequest,
      abort: NativeMessageType.openAIOnboardingRequest,
      reconcile: NativeMessageType.openAIOnboardingRequest,
      begun: NativeMessageType.openAIOnboardingBegun,
      catalogPage: NativeMessageType.openAIOnboardingCatalogPage,
      committed: NativeMessageType.openAIOnboardingCommitted,
      aborted: NativeMessageType.openAIOnboardingAborted,
      reconciliation: NativeMessageType.openAIOnboardingReconciliation,
      failure: NativeMessageType.openAIOnboardingFailure,
    };
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
        const decoded = frames[0];
        expect(decoded?.type).toBe(types[golden.name]);
        expect(decoded?.requestId).toBe(golden.requestId);
        expect(decoded === undefined ? "" : toHex(encodeNativeFrame(decoded)))
          .toBe(golden.hex);
      }

      const decoder = new NativeFrameDecoder();
      const [decoded] = decoder.push(bytes);
      decoder.finish();
      if (decoded === undefined) {
        throw new Error("test setup failed");
      }
      let reencoded: Uint8Array;
      switch (golden.name) {
        case "begin":
        case "verify":
        case "catalogPageRequest":
        case "finalize":
        case "abort":
        case "reconcile":
          reencoded = encodeOpenAIOnboardingRequest(
            golden.requestId,
            decodeOpenAIOnboardingRequest(decoded),
          );
          break;
        case "begun":
          reencoded = encodeOpenAIOnboardingBegun(
            golden.requestId,
            decodeOpenAIOnboardingBegun(decoded),
          );
          break;
        case "catalogPage":
          reencoded = encodeOpenAIOnboardingCatalogPage(
            golden.requestId,
            decodeOpenAIOnboardingCatalogPage(decoded),
          );
          break;
        case "committed":
          reencoded = encodeOpenAIOnboardingCommitted(
            golden.requestId,
            decodeOpenAIOnboardingCommitted(decoded),
          );
          break;
        case "aborted":
          decodeOpenAIOnboardingAborted(decoded);
          reencoded = encodeOpenAIOnboardingAborted(golden.requestId);
          break;
        case "reconciliation":
          reencoded = encodeOpenAIOnboardingReconciliation(
            golden.requestId,
            decodeOpenAIOnboardingReconciliation(decoded).status,
          );
          break;
        case "failure":
          reencoded = encodeOpenAIOnboardingFailure(
            golden.requestId,
            decodeOpenAIOnboardingFailure(decoded).code,
          );
          break;
        default:
          throw new Error("unknown fixture frame");
      }
      expect(toHex(reencoded)).toBe(golden.hex);
    }
  });
});
