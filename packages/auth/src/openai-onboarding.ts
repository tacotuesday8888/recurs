import {
  NativeMessageType,
  allocateNativeBytes,
  encodeNativeFrame,
  failNativeCodec,
} from "./frame.js";
import type { NativeFrame } from "./frame.js";
import {
  decodeFieldTable,
  decodeU16,
  encodeFieldTable,
  encodeU16,
} from "./fields.js";
import type { NativeField } from "./fields.js";

export const OPENAI_ONBOARDING_MAX_MODEL_IDS_PER_PAGE = 128;
export const OPENAI_ONBOARDING_MAX_MODEL_COUNT = 4_096;
export const OPENAI_ONBOARDING_MAX_MODEL_ID_UTF8_BYTES = 256;
export const OPENAI_ONBOARDING_MAX_CATALOG_REQUEST_ID_UTF8_BYTES = 256;

export type NativeOpenAIOnboardingRequest =
  | { readonly kind: "begin" }
  | { readonly kind: "begin_anthropic" }
  | { readonly kind: "verify" }
  | { readonly kind: "catalog_page"; readonly cursor: number }
  | { readonly kind: "finalize"; readonly exactModelId: string }
  | { readonly kind: "abort" }
  | {
    readonly kind: "reconcile";
    readonly connectionId: string;
    readonly credentialIdentityFingerprint: string;
  };

export interface NativeOpenAIOnboardingBegun {
  readonly connectionId: string;
  readonly credentialIdentityFingerprint: string;
}

export interface NativeOpenAIOnboardingCatalogPage {
  readonly cursor: number;
  readonly totalModelCount: number;
  readonly nextCursor: number | null;
  readonly catalogRequestId: string | null;
  readonly modelIds: readonly string[];
}

export interface NativeOpenAIOnboardingCommitted {
  readonly connectionId: string;
  readonly selectedModelId: string;
  readonly verifiedModelCount: number;
  readonly catalogRequestId: string | null;
}

export type NativeOpenAIOnboardingReconciliationStatus =
  | "ready_openai"
  | "absent"
  | "unresolved";

export interface NativeOpenAIOnboardingReconciliation {
  readonly status: NativeOpenAIOnboardingReconciliationStatus;
}

export enum NativeOpenAIOnboardingFailureCode {
  invalidRequest = 1,
  sessionNotReady = 2,
  busy = 3,
  cancelled = 4,
  expired = 5,
  verificationFailed = 6,
  invalidModel = 7,
  noCompatibleModels = 8,
  commitFailed = 9,
  credentialStoreUnavailable = 10,
  cleanupFailed = 11,
  reconciliationRequired = 12,
  authorityUnavailable = 13,
  operationUnavailable = 14,
}
Object.freeze(NativeOpenAIOnboardingFailureCode);

export interface NativeOpenAIOnboardingFailure {
  readonly code: NativeOpenAIOnboardingFailureCode;
}

export function encodeOpenAIOnboardingRequest(
  requestId: number,
  request: NativeOpenAIOnboardingRequest,
): Uint8Array {
  return withInvalidMessage(() => {
    let fields: readonly NativeField[];
    const kind = request.kind;
    switch (kind) {
      case "begin":
        fields = [kindField(1)];
        break;
      case "begin_anthropic":
        fields = [kindField(7)];
        break;
      case "verify":
        fields = [kindField(2)];
        break;
      case "catalog_page": {
        const cursor = request.cursor;
        validateCatalogCursor(cursor);
        fields = [kindField(3), { tag: 2, value: encodeU16(cursor) }];
        break;
      }
      case "finalize": {
        const exactModelId = request.exactModelId;
        fields = [kindField(4), { tag: 2, value: encodeModelId(exactModelId) }];
        break;
      }
      case "abort":
        fields = [kindField(5)];
        break;
      case "reconcile": {
        const connectionId = request.connectionId;
        const credentialIdentityFingerprint =
          request.credentialIdentityFingerprint;
        fields = [
          kindField(6),
          { tag: 2, value: encodeUuid(connectionId) },
          {
            tag: 3,
            value: encodeFingerprint(credentialIdentityFingerprint),
          },
        ];
        break;
      }
      default:
        failNativeCodec("invalid_message");
    }
    return encodeNativeFrame({
      type: NativeMessageType.openAIOnboardingRequest,
      requestId,
      payload: encodeFieldTable(fields),
    });
  });
}

export function decodeOpenAIOnboardingRequest(
  frame: NativeFrame,
): NativeOpenAIOnboardingRequest {
  return withInvalidMessage(() => {
    const fields = requireFields(frame, NativeMessageType.openAIOnboardingRequest);
    const kind = decodeU16(fields[0]?.value ?? allocateNativeBytes(0));
    switch (kind) {
      case 1:
        requireTags(fields, [1]);
        return Object.freeze({ kind: "begin" });
      case 7:
        requireTags(fields, [1]);
        return Object.freeze({ kind: "begin_anthropic" });
      case 2:
        requireTags(fields, [1]);
        return Object.freeze({ kind: "verify" });
      case 3: {
        requireTags(fields, [1, 2]);
        const cursor = decodeU16(fields[1]?.value ?? allocateNativeBytes(0));
        validateCatalogCursor(cursor);
        return Object.freeze({ kind: "catalog_page", cursor });
      }
      case 4:
        requireTags(fields, [1, 2]);
        return Object.freeze({
          kind: "finalize",
          exactModelId: decodeModelId(fields[1]?.value ?? allocateNativeBytes(0)),
        });
      case 5:
        requireTags(fields, [1]);
        return Object.freeze({ kind: "abort" });
      case 6:
        requireTags(fields, [1, 2, 3]);
        return Object.freeze({
          kind: "reconcile",
          connectionId: decodeUuid(fields[1]?.value ?? allocateNativeBytes(0)),
          credentialIdentityFingerprint: decodeFingerprint(
            fields[2]?.value ?? allocateNativeBytes(0),
          ),
        });
      default:
        failNativeCodec("invalid_message");
    }
  });
}

export function encodeOpenAIOnboardingBegun(
  requestId: number,
  begun: NativeOpenAIOnboardingBegun,
): Uint8Array {
  return withInvalidMessage(() => encodeMessage(
    NativeMessageType.openAIOnboardingBegun,
    requestId,
    [
      { tag: 1, value: encodeUuid(begun.connectionId) },
      {
        tag: 2,
        value: encodeFingerprint(begun.credentialIdentityFingerprint),
      },
    ],
  ));
}

export function decodeOpenAIOnboardingBegun(
  frame: NativeFrame,
): NativeOpenAIOnboardingBegun {
  return withInvalidMessage(() => {
    const fields = requireExactFields(
      frame,
      NativeMessageType.openAIOnboardingBegun,
      [1, 2],
    );
    return Object.freeze({
      connectionId: decodeUuid(fields[0]?.value ?? allocateNativeBytes(0)),
      credentialIdentityFingerprint: decodeFingerprint(
        fields[1]?.value ?? allocateNativeBytes(0),
      ),
    });
  });
}

export function encodeOpenAIOnboardingCatalogPage(
  requestId: number,
  page: NativeOpenAIOnboardingCatalogPage,
): Uint8Array {
  return withInvalidMessage(() => {
    const snapshot = snapshotCatalogPage(page);
    validateCatalogPage(snapshot);
    return encodeMessage(
      NativeMessageType.openAIOnboardingCatalogPage,
      requestId,
      [
        { tag: 1, value: encodeU16(snapshot.cursor) },
        { tag: 2, value: encodeU16(snapshot.totalModelCount) },
        { tag: 3, value: encodeU16(snapshot.nextCursor ?? 0xffff) },
        { tag: 4, value: encodeCatalogRequestId(snapshot.catalogRequestId) },
        { tag: 5, value: encodeModelIds(snapshot.modelIds) },
      ],
    );
  });
}

export function decodeOpenAIOnboardingCatalogPage(
  frame: NativeFrame,
): NativeOpenAIOnboardingCatalogPage {
  return withInvalidMessage(() => {
    const fields = requireExactFields(
      frame,
      NativeMessageType.openAIOnboardingCatalogPage,
      [1, 2, 3, 4, 5],
    );
    const rawNextCursor = decodeU16(
      fields[2]?.value ?? allocateNativeBytes(0),
    );
    const modelIds = decodeModelIds(
      fields[4]?.value ?? allocateNativeBytes(0),
    );
    const page = {
      cursor: decodeU16(fields[0]?.value ?? allocateNativeBytes(0)),
      totalModelCount: decodeU16(
        fields[1]?.value ?? allocateNativeBytes(0),
      ),
      nextCursor: rawNextCursor === 0xffff ? null : rawNextCursor,
      catalogRequestId: decodeCatalogRequestId(
        fields[3]?.value ?? allocateNativeBytes(0),
      ),
      modelIds,
    };
    validateCatalogPage(page);
    return Object.freeze({ ...page, modelIds: Object.freeze([...modelIds]) });
  });
}

export function encodeOpenAIOnboardingCommitted(
  requestId: number,
  committed: NativeOpenAIOnboardingCommitted,
): Uint8Array {
  return withInvalidMessage(() => {
    const connectionId = committed.connectionId;
    const selectedModelId = committed.selectedModelId;
    const verifiedModelCount = committed.verifiedModelCount;
    const catalogRequestId = committed.catalogRequestId;
    validateVerifiedModelCount(verifiedModelCount);
    return encodeMessage(
      NativeMessageType.openAIOnboardingCommitted,
      requestId,
      [
        { tag: 1, value: encodeUuid(connectionId) },
        { tag: 2, value: encodeModelId(selectedModelId) },
        { tag: 3, value: encodeU16(verifiedModelCount) },
        {
          tag: 4,
          value: encodeCatalogRequestId(catalogRequestId),
        },
      ],
    );
  });
}

export function decodeOpenAIOnboardingCommitted(
  frame: NativeFrame,
): NativeOpenAIOnboardingCommitted {
  return withInvalidMessage(() => {
    const fields = requireExactFields(
      frame,
      NativeMessageType.openAIOnboardingCommitted,
      [1, 2, 3, 4],
    );
    const verifiedModelCount = decodeU16(
      fields[2]?.value ?? allocateNativeBytes(0),
    );
    validateVerifiedModelCount(verifiedModelCount);
    return Object.freeze({
      connectionId: decodeUuid(fields[0]?.value ?? allocateNativeBytes(0)),
      selectedModelId: decodeModelId(
        fields[1]?.value ?? allocateNativeBytes(0),
      ),
      verifiedModelCount,
      catalogRequestId: decodeCatalogRequestId(
        fields[3]?.value ?? allocateNativeBytes(0),
      ),
    });
  });
}

export function encodeOpenAIOnboardingAborted(requestId: number): Uint8Array {
  return encodeMessage(
    NativeMessageType.openAIOnboardingAborted,
    requestId,
    [],
  );
}

export function decodeOpenAIOnboardingAborted(
  frame: NativeFrame,
): Readonly<Record<never, never>> {
  return withInvalidMessage(() => {
    requireExactFields(frame, NativeMessageType.openAIOnboardingAborted, []);
    return Object.freeze({});
  });
}

const reconciliationStatuses = Object.freeze({
  ready_openai: 1,
  absent: 2,
  unresolved: 3,
} as const);
const reconciliationStatusValues: Readonly<Record<number, NativeOpenAIOnboardingReconciliationStatus>> =
  Object.freeze({
    1: "ready_openai",
    2: "absent",
    3: "unresolved",
  });

export function encodeOpenAIOnboardingReconciliation(
  requestId: number,
  status: NativeOpenAIOnboardingReconciliationStatus,
): Uint8Array {
  return withInvalidMessage(() => {
    const code = reconciliationStatuses[status];
    if (code === undefined) {
      failNativeCodec("invalid_message");
    }
    return encodeMessage(
      NativeMessageType.openAIOnboardingReconciliation,
      requestId,
      [{ tag: 1, value: encodeU16(code) }],
    );
  });
}

export function decodeOpenAIOnboardingReconciliation(
  frame: NativeFrame,
): NativeOpenAIOnboardingReconciliation {
  return withInvalidMessage(() => {
    const fields = requireExactFields(
      frame,
      NativeMessageType.openAIOnboardingReconciliation,
      [1],
    );
    const status = reconciliationStatusValues[
      decodeU16(fields[0]?.value ?? allocateNativeBytes(0))
    ];
    if (status === undefined) {
      failNativeCodec("invalid_message");
    }
    return Object.freeze({ status });
  });
}

export function encodeOpenAIOnboardingFailure(
  requestId: number,
  code: NativeOpenAIOnboardingFailureCode,
): Uint8Array {
  return withInvalidMessage(() => {
    validateFailureCode(code);
    return encodeMessage(
      NativeMessageType.openAIOnboardingFailure,
      requestId,
      [{ tag: 1, value: encodeU16(code) }],
    );
  });
}

export function decodeOpenAIOnboardingFailure(
  frame: NativeFrame,
): NativeOpenAIOnboardingFailure {
  return withInvalidMessage(() => {
    const fields = requireExactFields(
      frame,
      NativeMessageType.openAIOnboardingFailure,
      [1],
    );
    const code = decodeU16(fields[0]?.value ?? allocateNativeBytes(0));
    validateFailureCode(code);
    return Object.freeze({ code });
  });
}

function withInvalidMessage<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    failNativeCodec("invalid_message");
  }
}

function requireFields(
  frame: NativeFrame,
  type: NativeMessageType,
): readonly NativeField[] {
  if (frame.type !== type) {
    failNativeCodec("invalid_message");
  }
  return decodeFieldTable(frame.payload);
}

function requireExactFields(
  frame: NativeFrame,
  type: NativeMessageType,
  tags: readonly number[],
): readonly NativeField[] {
  const fields = requireFields(frame, type);
  requireTags(fields, tags);
  return fields;
}

function encodeMessage(
  type: NativeMessageType,
  requestId: number,
  fields: readonly NativeField[],
): Uint8Array {
  return withInvalidMessage(() => encodeNativeFrame({
    type,
    requestId,
    payload: encodeFieldTable(fields),
  }));
}

function requireTags(
  fields: readonly NativeField[],
  tags: readonly number[],
): void {
  if (
    fields.length !== tags.length ||
    fields.some((field, index) => field.tag !== tags[index])
  ) {
    failNativeCodec("invalid_message");
  }
}

function kindField(kind: number): NativeField {
  return { tag: 1, value: encodeU16(kind) };
}

function validateCatalogCursor(cursor: number): void {
  if (
    !Number.isInteger(cursor) ||
    cursor <= 0 ||
    cursor >= OPENAI_ONBOARDING_MAX_MODEL_COUNT
  ) {
    failNativeCodec("invalid_message");
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function encodeModelId(value: string): Uint8Array {
  if (typeof value !== "string") {
    failNativeCodec("invalid_message");
  }
  const bytes = textEncoder.encode(value);
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > OPENAI_ONBOARDING_MAX_MODEL_ID_UTF8_BYTES ||
    [...bytes].some((byte) => byte < 0x20 || byte === 0x7f) ||
    textDecoder.decode(bytes) !== value
  ) {
    failNativeCodec("invalid_message");
  }
  return bytes;
}

function decodeModelId(value: Uint8Array): string {
  const decoded = textDecoder.decode(value);
  encodeModelId(decoded);
  return decoded;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function encodeUuid(value: string): Uint8Array {
  if (
    typeof value !== "string" ||
    !uuidPattern.test(value) ||
    value === "00000000-0000-0000-0000-000000000000"
  ) {
    failNativeCodec("invalid_message");
  }
  return Uint8Array.from(
    value.replaceAll("-", "").match(/../gu)?.map((byte) => Number.parseInt(byte, 16)) ?? [],
  );
}

function decodeUuid(value: Uint8Array): string {
  if (value.byteLength !== 16) {
    failNativeCodec("invalid_message");
  }
  const hex = [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const decoded = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  encodeUuid(decoded);
  return decoded;
}

const fingerprintPattern = /^sha256:[0-9a-f]{64}$/u;

function encodeFingerprint(value: string): Uint8Array {
  if (typeof value !== "string" || !fingerprintPattern.test(value)) {
    failNativeCodec("invalid_message");
  }
  return textEncoder.encode(value);
}

function decodeFingerprint(value: Uint8Array): string {
  const decoded = textDecoder.decode(value);
  encodeFingerprint(decoded);
  return decoded;
}

function encodeCatalogRequestId(value: string | null): Uint8Array {
  if (value === null) {
    return allocateNativeBytes(0);
  }
  if (typeof value !== "string") {
    failNativeCodec("invalid_message");
  }
  const bytes = textEncoder.encode(value);
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > OPENAI_ONBOARDING_MAX_CATALOG_REQUEST_ID_UTF8_BYTES ||
    [...bytes].some((byte) => byte < 0x21 || byte > 0x7e) ||
    textDecoder.decode(bytes) !== value
  ) {
    failNativeCodec("invalid_message");
  }
  return bytes;
}

function decodeCatalogRequestId(value: Uint8Array): string | null {
  if (value.byteLength === 0) {
    return null;
  }
  const decoded = textDecoder.decode(value);
  encodeCatalogRequestId(decoded);
  return decoded;
}

function encodeModelIds(values: readonly string[]): Uint8Array {
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > OPENAI_ONBOARDING_MAX_MODEL_IDS_PER_PAGE
  ) {
    failNativeCodec("invalid_message");
  }
  const encodedValues = values.map(encodeModelId);
  const length = 2 + encodedValues.reduce(
    (sum, value) => sum + 2 + value.byteLength,
    0,
  );
  const encoded = new Uint8Array(length);
  const view = new DataView(encoded.buffer);
  view.setUint16(0, encodedValues.length, false);
  let offset = 2;
  for (const value of encodedValues) {
    view.setUint16(offset, value.byteLength, false);
    encoded.set(value, offset + 2);
    offset += 2 + value.byteLength;
  }
  return encoded;
}

function decodeModelIds(value: Uint8Array): readonly string[] {
  if (value.byteLength < 2) {
    failNativeCodec("invalid_message");
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const count = view.getUint16(0, false);
  if (count === 0 || count > OPENAI_ONBOARDING_MAX_MODEL_IDS_PER_PAGE) {
    failNativeCodec("invalid_message");
  }
  let offset = 2;
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    if (value.byteLength - offset < 2) {
      failNativeCodec("invalid_message");
    }
    const length = view.getUint16(offset, false);
    offset += 2;
    if (length > value.byteLength - offset) {
      failNativeCodec("invalid_message");
    }
    values.push(decodeModelId(value.slice(offset, offset + length)));
    offset += length;
  }
  if (offset !== value.byteLength) {
    failNativeCodec("invalid_message");
  }
  return Object.freeze(values);
}

function snapshotCatalogPage(
  page: NativeOpenAIOnboardingCatalogPage,
): NativeOpenAIOnboardingCatalogPage {
  const cursor = page.cursor;
  const totalModelCount = page.totalModelCount;
  const nextCursor = page.nextCursor;
  const catalogRequestId = page.catalogRequestId;
  const inputModelIds = page.modelIds;
  if (!Array.isArray(inputModelIds)) {
    failNativeCodec("invalid_message");
  }
  const modelIdCount = inputModelIds.length;
  if (
    !Number.isInteger(modelIdCount) ||
    modelIdCount < 1 ||
    modelIdCount > OPENAI_ONBOARDING_MAX_MODEL_IDS_PER_PAGE
  ) {
    failNativeCodec("invalid_message");
  }
  const modelIds: string[] = [];
  for (let index = 0; index < modelIdCount; index += 1) {
    modelIds[index] = inputModelIds[index] as string;
  }
  return {
    cursor,
    totalModelCount,
    nextCursor,
    catalogRequestId,
    modelIds,
  };
}

function validateCatalogPage(page: NativeOpenAIOnboardingCatalogPage): void {
  if (
    !Number.isInteger(page.cursor) ||
    page.cursor < 0 ||
    !Number.isInteger(page.totalModelCount) ||
    page.totalModelCount < 1 ||
    page.totalModelCount > OPENAI_ONBOARDING_MAX_MODEL_COUNT ||
    page.cursor >= page.totalModelCount ||
    !Array.isArray(page.modelIds) ||
    page.modelIds.length < 1 ||
    page.modelIds.length > OPENAI_ONBOARDING_MAX_MODEL_IDS_PER_PAGE
  ) {
    failNativeCodec("invalid_message");
  }
  const end = page.cursor + page.modelIds.length;
  if (
    end > page.totalModelCount ||
    (page.nextCursor === null
      ? end !== page.totalModelCount
      : !Number.isInteger(page.nextCursor) ||
        page.nextCursor !== end ||
        page.nextCursor >= page.totalModelCount)
  ) {
    failNativeCodec("invalid_message");
  }
  encodeCatalogRequestId(page.catalogRequestId);
  let previous: Uint8Array | undefined;
  for (const modelId of page.modelIds) {
    const current = encodeModelId(modelId);
    if (previous !== undefined && compareBytes(previous, current) >= 0) {
      failNativeCodec("invalid_message");
    }
    previous = current;
  }
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const count = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < count; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.byteLength - right.byteLength;
}

function validateVerifiedModelCount(value: number): void {
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > OPENAI_ONBOARDING_MAX_MODEL_COUNT
  ) {
    failNativeCodec("invalid_message");
  }
}

function validateFailureCode(
  value: number,
): asserts value is NativeOpenAIOnboardingFailureCode {
  if (
    !Number.isInteger(value) ||
    value < NativeOpenAIOnboardingFailureCode.invalidRequest ||
    value > NativeOpenAIOnboardingFailureCode.operationUnavailable
  ) {
    failNativeCodec("invalid_message");
  }
}
