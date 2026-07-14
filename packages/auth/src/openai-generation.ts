import type {
  DirectContinuationHandle,
  JsonValue,
  NativeOpenAIResponsesFailureCode,
  ProviderBackedMessage,
  ProviderEvent,
  ProviderRequest,
} from "@recurs/contracts";

import {
  NATIVE_FRAME_MAX_PAYLOAD_BYTES,
  NativeMessageType,
  encodeNativeFrame,
  failNativeCodec,
} from "./frame.js";
import type { NativeFrame } from "./frame.js";
import { decodeFieldTable, decodeU16, encodeFieldTable } from "./fields.js";

export type NativeOpenAIGenerationInput =
  | { readonly kind: "message"; readonly role: "system" | "user" | "assistant"; readonly text: string }
  | { readonly kind: "function_call"; readonly callId: string; readonly name: string; readonly arguments: JsonValue }
  | { readonly kind: "function_call_output"; readonly callId: string; readonly output: string }
  | { readonly kind: "continuation"; readonly handle: DirectContinuationHandle };

export interface NativeOpenAIGenerationRequestBody {
  readonly format: 1;
  readonly connectionId: string;
  readonly authorizationId: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly adapterId: "openai-responses";
  readonly modelId: string;
  readonly backendFingerprint: string;
  readonly expectedSessionRecordSequence: number;
  readonly authorizationExpiresAt: string;
  readonly input: readonly NativeOpenAIGenerationInput[];
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, JsonValue>>;
  }[];
  readonly maxOutputTokens: 8_192;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const maximumBodyBytes = NATIVE_FRAME_MAX_PAYLOAD_BYTES - 8;

export function encodeOpenAIGenerationRequest(
  requestId: number,
  request: ProviderRequest,
): Uint8Array {
  return invalidMessage(() => {
    const context = request.directContext;
    const authorization = context?.authorization;
    if (
      context === undefined ||
      authorization === undefined ||
      authorization.operation !== "run" ||
      authorization.turnId === null ||
      authorization.connectionId.length === 0 ||
      authorization.modelId !== request.model ||
      !Number.isSafeInteger(context.expectedSessionRecordSequence) ||
      context.expectedSessionRecordSequence < 0
    ) {
      failNativeCodec("invalid_message");
    }
    const input = encodeInput(request.messages as readonly ProviderBackedMessage[]);
    const tools = request.tools.map((tool) => {
      if (!isJsonObject(tool.inputSchema)) failNativeCodec("invalid_message");
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      };
    });
    const body: NativeOpenAIGenerationRequestBody = {
      format: 1,
      connectionId: authorization.connectionId,
      authorizationId: authorization.id,
      sessionId: authorization.sessionId,
      turnId: authorization.turnId,
      adapterId: "openai-responses",
      modelId: authorization.modelId,
      backendFingerprint: authorization.backendFingerprint,
      expectedSessionRecordSequence: context.expectedSessionRecordSequence,
      authorizationExpiresAt: authorization.expiresAt,
      input,
      tools,
      maxOutputTokens: 8_192,
    };
    const json = JSON.stringify(body);
    const bytes = textEncoder.encode(json);
    if (bytes.length === 0 || bytes.length > maximumBodyBytes) {
      failNativeCodec("invalid_message");
    }
    return encodeNativeFrame({
      type: NativeMessageType.openAIGenerationRequest,
      requestId,
      payload: encodeFieldTable([{ tag: 1, value: bytes }]),
    });
  });
}

export function decodeOpenAIGenerationRequestBody(
  frame: NativeFrame,
): NativeOpenAIGenerationRequestBody {
  return invalidMessage(() => {
    if (frame.type !== NativeMessageType.openAIGenerationRequest) {
      failNativeCodec("invalid_message");
    }
    const fields = decodeFieldTable(frame.payload);
    if (fields.length !== 1 || fields[0]?.tag !== 1) {
      failNativeCodec("invalid_message");
    }
    const value: unknown = JSON.parse(textDecoder.decode(fields[0].value));
    if (!isJsonObject(value) || value.format !== 1 || !Array.isArray(value.input)) {
      failNativeCodec("invalid_message");
    }
    return value as unknown as NativeOpenAIGenerationRequestBody;
  });
}

export function decodeOpenAIGenerationEvent(frame: NativeFrame): ProviderEvent {
  return invalidMessage(() => {
    const value = decodeGenerationJson(frame, NativeMessageType.openAIGenerationEvent);
    if (!isJsonObject(value) || typeof value.type !== "string") {
      failNativeCodec("invalid_message");
    }
    switch (value.type) {
      case "text_delta":
      case "reasoning_delta":
        requireExactKeys(value, ["type", "text"]);
        if (typeof value.text !== "string") failNativeCodec("invalid_message");
        return { type: value.type, text: value.text };
      case "tool_call": {
        requireExactKeys(value, ["type", "call"]);
        const call = value.call;
        if (!isJsonObject(call)) failNativeCodec("invalid_message");
        requireExactKeys(call, ["id", "name", "arguments"]);
        if (typeof call.id !== "string" || typeof call.name !== "string") {
          failNativeCodec("invalid_message");
        }
        return { type: "tool_call", call: { id: call.id, name: call.name, arguments: call.arguments } };
      }
      case "usage":
        requireExactKeys(value, ["type", "inputTokens", "outputTokens"]);
        if (!isNonNegativeSafeInteger(value.inputTokens) || !isNonNegativeSafeInteger(value.outputTokens)) {
          failNativeCodec("invalid_message");
        }
        return { type: "usage", inputTokens: value.inputTokens, outputTokens: value.outputTokens };
      case "provider_state": {
        requireExactKeys(value, ["type", "handle"]);
        return { type: "provider_state", handle: decodeContinuationHandle(value.handle) };
      }
      case "done":
        requireExactKeys(value, ["type", "stopReason"]);
        if (value.stopReason !== "complete" && value.stopReason !== "tool_calls" && value.stopReason !== "length") {
          failNativeCodec("invalid_message");
        }
        return { type: "done", stopReason: value.stopReason };
      default:
        failNativeCodec("invalid_message");
    }
  });
}

export function decodeOpenAIGenerationFailure(
  frame: NativeFrame,
): NativeOpenAIResponsesFailureCode {
  return invalidMessage(() => {
    if (frame.type !== NativeMessageType.openAIGenerationFailure) failNativeCodec("invalid_message");
    const fields = decodeFieldTable(frame.payload);
    if (fields.length !== 1 || fields[0]?.tag !== 1) failNativeCodec("invalid_message");
    const code = GENERATION_FAILURE_CODES[decodeU16(fields[0].value)];
    if (code === undefined) failNativeCodec("invalid_message");
    return code;
  });
}

const GENERATION_FAILURE_CODES: Readonly<Record<number, NativeOpenAIResponsesFailureCode>> = Object.freeze({
  1: "cancelled", 2: "invalid_request", 3: "request_too_large", 4: "invalid_credential",
  5: "route_unavailable", 6: "delivery_uncertain", 7: "invalid_response", 8: "response_too_large",
  9: "authentication_rejected", 10: "rate_limited", 11: "provider_unavailable",
  12: "request_rejected", 13: "content_filtered", 14: "provider_failure", 15: "credential_echo_detected",
});

function decodeGenerationJson(frame: NativeFrame, type: NativeMessageType): unknown {
  if (frame.type !== type) failNativeCodec("invalid_message");
  const fields = decodeFieldTable(frame.payload);
  if (fields.length !== 1 || fields[0]?.tag !== 1) failNativeCodec("invalid_message");
  return JSON.parse(textDecoder.decode(fields[0].value)) as unknown;
}

function decodeContinuationHandle(value: unknown): DirectContinuationHandle {
  if (!isJsonObject(value)) failNativeCodec("invalid_message");
  requireExactKeys(value, [
    "kind", "id", "storageClass", "recursSessionId", "connectionId", "adapterId", "modelId",
    "backendFingerprint", "stateVersion", "originTurnId", "continuationSequence", "status",
  ]);
  if (value.kind !== "direct" || value.storageClass !== "persistent_broker" || value.status !== "committed" ||
    typeof value.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id) ||
    typeof value.recursSessionId !== "string" || typeof value.connectionId !== "string" ||
    typeof value.adapterId !== "string" || typeof value.modelId !== "string" ||
    typeof value.backendFingerprint !== "string" || typeof value.originTurnId !== "string" ||
    !isNonNegativeSafeInteger(value.stateVersion) || value.stateVersion !== 1 ||
    !isNonNegativeSafeInteger(value.continuationSequence) || value.continuationSequence === 0) {
    failNativeCodec("invalid_message");
  }
  return {
    kind: "direct", id: value.id, storageClass: "persistent_broker",
    recursSessionId: value.recursSessionId, connectionId: value.connectionId,
    adapterId: value.adapterId, modelId: value.modelId, backendFingerprint: value.backendFingerprint,
    stateVersion: value.stateVersion, originTurnId: value.originTurnId,
    continuationSequence: value.continuationSequence, status: "committed",
  };
}

function requireExactKeys(value: Record<string, JsonValue>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    failNativeCodec("invalid_message");
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function encodeInput(
  messages: readonly ProviderBackedMessage[],
): readonly NativeOpenAIGenerationInput[] {
  const input: NativeOpenAIGenerationInput[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
      case "user":
        input.push({ kind: "message", role: message.role, text: message.content });
        break;
      case "assistant":
        if (message.providerStateHandle !== undefined) {
          input.push({ kind: "continuation", handle: message.providerStateHandle });
          break;
        }
        if (message.content.length > 0 || (message.toolCalls?.length ?? 0) === 0) {
          input.push({ kind: "message", role: "assistant", text: message.content });
        }
        for (const call of message.toolCalls ?? []) {
          if (!isJsonValue(call.arguments)) failNativeCodec("invalid_message");
          input.push({
            kind: "function_call",
            callId: call.id,
            name: call.name,
            arguments: call.arguments,
          });
        }
        break;
      case "tool":
        if (message.toolCallId === undefined) failNativeCodec("invalid_message");
        input.push({
          kind: "function_call_output",
          callId: message.toolCallId,
          output: message.content,
        });
        break;
    }
  }
  if (input.length === 0) failNativeCodec("invalid_message");
  return input;
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return isJsonValue(value) && !Array.isArray(value) && value !== null;
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.keys(value).every((key) => isJsonValue(Reflect.get(value, key), seen));
}

function invalidMessage<Value>(body: () => Value): Value {
  try {
    return body();
  } catch {
    failNativeCodec("invalid_message");
  }
}
