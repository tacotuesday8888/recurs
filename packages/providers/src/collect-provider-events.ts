import {
  ProviderError,
  type CollectProviderEventsOptions,
  type CollectedProviderEvents,
  type DirectContinuationHandle,
  type ProviderEvent,
  type StopReason,
  type ToolCall,
} from "./types.js";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_CALLS = 128;
const textEncoder = new TextEncoder();
const stopReasons = new Set<StopReason>([
  "complete",
  "tool_calls",
  "length",
  "cancelled",
  "error",
]);

function invalid(message: string): ProviderError {
  return new ProviderError("invalid_response", message, false);
}

function validTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isToolCall(value: unknown): value is ToolCall {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "arguments" in value
  );
}

function isCommittedDirectHandle(
  value: unknown,
): value is DirectContinuationHandle {
  if (typeof value !== "object" || value === null) return false;
  const handle = value as Partial<DirectContinuationHandle>;
  return handle.kind === "direct" &&
    handle.status === "committed" &&
    (handle.storageClass === "persistent_broker" ||
      handle.storageClass === "process_scoped") &&
    typeof handle.id === "string" && handle.id.length > 0 &&
    typeof handle.recursSessionId === "string" &&
    typeof handle.connectionId === "string" &&
    typeof handle.adapterId === "string" &&
    typeof handle.modelId === "string" &&
    typeof handle.backendFingerprint === "string" &&
    Number.isSafeInteger(handle.stateVersion) &&
    Number(handle.stateVersion) >= 0 &&
    typeof handle.originTurnId === "string" &&
    Number.isSafeInteger(handle.continuationSequence) &&
    Number(handle.continuationSequence) > 0;
}

export async function collectProviderEvents(
  events: AsyncIterable<ProviderEvent>,
  options: CollectProviderEventsOptions = {},
): Promise<CollectedProviderEvents> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  const toolCallIds = new Set<string>();
  const usage = { inputTokens: 0, outputTokens: 0 };
  let usageReported = false;
  let stopReason: StopReason | undefined;
  let providerStateHandle: DirectContinuationHandle | undefined;
  let outputBytes = 0;

  for await (const event of events) {
    if (typeof event !== "object" || event === null || !("type" in event)) {
      throw invalid("Provider emitted a malformed event");
    }
    if (stopReason !== undefined) {
      throw invalid("Provider stream emitted data after its completion event");
    }
    switch (event.type) {
      case "text_delta": {
        if (typeof event.text !== "string") {
          throw invalid("Provider emitted an invalid text delta");
        }
        outputBytes += textEncoder.encode(event.text).byteLength;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          throw invalid(`Provider output exceeded ${MAX_OUTPUT_BYTES} bytes`);
        }
        text += event.text;
        break;
      }
      case "reasoning_delta": {
        if (typeof event.text !== "string") {
          throw invalid("Provider emitted an invalid reasoning delta");
        }
        outputBytes += textEncoder.encode(event.text).byteLength;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          throw invalid(`Provider output exceeded ${MAX_OUTPUT_BYTES} bytes`);
        }
        break;
      }
      case "tool_call": {
        if (!isToolCall(event.call)) {
          throw invalid("Provider emitted a malformed tool call");
        }
        if (event.call.id.trim().length === 0) {
          throw invalid("Provider emitted a tool call without an id");
        }
        if (event.call.name.trim().length === 0) {
          throw invalid("Provider emitted a tool call without a name");
        }
        if (toolCallIds.has(event.call.id)) {
          throw invalid(`Provider emitted duplicate tool id: ${event.call.id}`);
        }
        if (toolCalls.length >= MAX_TOOL_CALLS) {
          throw invalid(`Provider emitted more than ${MAX_TOOL_CALLS} tool calls`);
        }
        toolCallIds.add(event.call.id);
        toolCalls.push(event.call);
        break;
      }
      case "provider_state": {
        if (
          providerStateHandle !== undefined ||
          !isCommittedDirectHandle(event.handle)
        ) {
          throw invalid("Provider emitted invalid continuation state");
        }
        providerStateHandle = event.handle;
        break;
      }
      case "usage": {
        if (
          !validTokenCount(event.inputTokens) ||
          !validTokenCount(event.outputTokens)
        ) {
          throw invalid("Provider emitted invalid token usage");
        }
        const inputTokens = usage.inputTokens + event.inputTokens;
        const outputTokens = usage.outputTokens + event.outputTokens;
        if (
          !validTokenCount(inputTokens) ||
          !validTokenCount(outputTokens)
        ) {
          throw invalid("Provider emitted invalid token usage");
        }
        usage.inputTokens = inputTokens;
        usage.outputTokens = outputTokens;
        usageReported = true;
        break;
      }
      case "done":
        if (!stopReasons.has(event.stopReason)) {
          throw invalid("Provider emitted an invalid stop reason");
        }
        stopReason = event.stopReason;
        break;
      default:
        throw invalid("Provider emitted an unknown event type");
    }
    await options.onEvent?.(event);
  }

  if (stopReason === undefined) {
    throw invalid("Provider stream ended without a completion event");
  }

  return {
    text,
    toolCalls,
    usage,
    usageReported,
    stopReason,
    ...(providerStateHandle === undefined ? {} : { providerStateHandle }),
  };
}
