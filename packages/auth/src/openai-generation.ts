import type {
  DirectContinuationHandle,
  JsonValue,
  ProviderBackedMessage,
  ProviderRequest,
} from "@recurs/contracts";

import {
  NATIVE_FRAME_MAX_PAYLOAD_BYTES,
  NativeMessageType,
  encodeNativeFrame,
  failNativeCodec,
} from "./frame.js";
import type { NativeFrame } from "./frame.js";
import { decodeFieldTable, encodeFieldTable } from "./fields.js";

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
