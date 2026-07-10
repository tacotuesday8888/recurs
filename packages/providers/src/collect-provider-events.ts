import {
  ProviderError,
  type CollectedProviderEvents,
  type ProviderEvent,
  type StopReason,
  type ToolCall,
} from "./types.js";

export async function collectProviderEvents(
  events: AsyncIterable<ProviderEvent>,
): Promise<CollectedProviderEvents> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason | undefined;

  for await (const event of events) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        break;
      case "reasoning_delta":
        break;
      case "tool_call":
        toolCalls.push(event.call);
        break;
      case "usage":
        usage.inputTokens += event.inputTokens;
        usage.outputTokens += event.outputTokens;
        break;
      case "done":
        stopReason = event.stopReason;
        break;
    }
  }

  if (stopReason === undefined) {
    throw new ProviderError(
      "invalid_response",
      "Provider stream ended without a completion event",
      false,
    );
  }

  return { text, toolCalls, usage, stopReason };
}
