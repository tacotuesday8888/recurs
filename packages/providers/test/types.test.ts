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

  it("rejects events after the terminal event", async () => {
    async function* events(): AsyncIterable<ProviderEvent> {
      yield { type: "done", stopReason: "complete" };
      yield { type: "text_delta", text: "late" };
    }

    await expect(collectProviderEvents(events())).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("rejects invalid tool calls and usage", async () => {
    async function* duplicateTools(): AsyncIterable<ProviderEvent> {
      yield {
        type: "tool_call",
        call: { id: "same", name: "read_file", arguments: {} },
      };
      yield {
        type: "tool_call",
        call: { id: "same", name: "read_file", arguments: {} },
      };
      yield { type: "done", stopReason: "tool_calls" };
    }
    async function* emptyToolName(): AsyncIterable<ProviderEvent> {
      yield {
        type: "tool_call",
        call: { id: "call-1", name: " ", arguments: {} },
      };
      yield { type: "done", stopReason: "tool_calls" };
    }
    async function* invalidUsage(): AsyncIterable<ProviderEvent> {
      yield { type: "usage", inputTokens: -1, outputTokens: 0 };
      yield { type: "done", stopReason: "complete" };
    }

    await expect(collectProviderEvents(duplicateTools())).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(collectProviderEvents(emptyToolName())).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(collectProviderEvents(invalidUsage())).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("bounds provider-controlled output and tool counts", async () => {
    async function* tooMuchText(): AsyncIterable<ProviderEvent> {
      yield { type: "text_delta", text: "x".repeat(4 * 1024 * 1024 + 1) };
      yield { type: "done", stopReason: "complete" };
    }
    async function* tooManyTools(): AsyncIterable<ProviderEvent> {
      for (let index = 0; index < 129; index += 1) {
        yield {
          type: "tool_call",
          call: { id: `call-${index}`, name: "read_file", arguments: {} },
        };
      }
      yield { type: "done", stopReason: "tool_calls" };
    }

    await expect(collectProviderEvents(tooMuchText())).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(collectProviderEvents(tooManyTools())).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("observes validated events while preserving the collected result", async () => {
    const observed: string[] = [];
    async function* events(): AsyncIterable<ProviderEvent> {
      yield { type: "text_delta", text: "ok" };
      yield { type: "done", stopReason: "complete" };
    }

    const result = await collectProviderEvents(events(), {
      onEvent(event) {
        observed.push(event.type);
      },
    });

    expect(observed).toEqual(["text_delta", "done"]);
    expect(result.text).toBe("ok");
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
