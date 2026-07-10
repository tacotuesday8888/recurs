import { describe, expect, it } from "vitest";

import {
  collectProviderEvents,
  ProviderError,
  type ProviderEvent,
} from "../src/index.js";

describe("provider protocol", () => {
  it("collects streamed text, tool calls, usage, and the stop reason", async () => {
    async function* events(): AsyncIterable<ProviderEvent> {
      yield { type: "text_delta", text: "hel" };
      yield { type: "text_delta", text: "lo" };
      yield {
        type: "tool_call",
        call: {
          id: "call-1",
          name: "read_file",
          arguments: { path: "a.ts" },
        },
      };
      yield { type: "usage", inputTokens: 10, outputTokens: 4 };
      yield { type: "done", stopReason: "tool_calls" };
    }

    await expect(collectProviderEvents(events())).resolves.toEqual({
      text: "hello",
      toolCalls: [
        {
          id: "call-1",
          name: "read_file",
          arguments: { path: "a.ts" },
        },
      ],
      usage: { inputTokens: 10, outputTokens: 4 },
      stopReason: "tool_calls",
    });
  });

  it("marks normalized provider failures as retryable or terminal", () => {
    expect(new ProviderError("rate_limit", "slow down", true).retryable).toBe(
      true,
    );
    expect(
      new ProviderError("authentication", "bad key", false).retryable,
    ).toBe(false);
  });
});
