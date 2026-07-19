import { describe, expect, it } from "vitest";

import {
  collectProviderEvents,
  ProviderError,
  safeProviderErrorMessage,
  type ProviderEvent,
} from "../src/index.js";

describe("provider protocol", () => {
  it("collects streamed text, tool calls, usage, and the stop reason", async () => {
    const providerStateHandle = {
      kind: "direct" as const,
      id: "continuation-1",
      storageClass: "persistent_broker" as const,
      recursSessionId: "session-1",
      connectionId: "connection-1",
      adapterId: "openai-responses",
      modelId: "gpt-5.6-sol",
      backendFingerprint: `sha256:${"a".repeat(64)}`,
      stateVersion: 1,
      originTurnId: "turn-1",
      continuationSequence: 1,
      status: "committed" as const,
    };
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
      yield { type: "provider_state", handle: providerStateHandle };
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
      providerStateHandle,
    });
  });

  it("accepts at most one committed direct provider-state handle", async () => {
    const handle = {
      kind: "direct" as const,
      id: "continuation-1",
      storageClass: "persistent_broker" as const,
      recursSessionId: "session-1",
      connectionId: "connection-1",
      adapterId: "openai-responses",
      modelId: "gpt-5.6-sol",
      backendFingerprint: `sha256:${"a".repeat(64)}`,
      stateVersion: 1,
      originTurnId: "turn-1",
      continuationSequence: 1,
      status: "committed" as const,
    };
    async function* duplicate(): AsyncIterable<ProviderEvent> {
      yield { type: "provider_state", handle };
      yield { type: "provider_state", handle };
      yield { type: "done", stopReason: "complete" };
    }
    async function* uncertain(): AsyncIterable<ProviderEvent> {
      yield {
        type: "provider_state",
        handle: { ...handle, status: "uncertain" },
      };
      yield { type: "done", stopReason: "complete" };
    }

    await expect(collectProviderEvents(duplicate())).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(collectProviderEvents(uncertain())).rejects.toMatchObject({
      code: "invalid_response",
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

  it("normalizes malformed runtime events as invalid responses", async () => {
    async function* unknownEvent(): AsyncIterable<ProviderEvent> {
      yield { type: "unknown" } as unknown as ProviderEvent;
      yield { type: "done", stopReason: "complete" };
    }
    async function* invalidText(): AsyncIterable<ProviderEvent> {
      yield { type: "text_delta", text: 42 } as unknown as ProviderEvent;
    }
    async function* invalidStopReason(): AsyncIterable<ProviderEvent> {
      yield {
        type: "done",
        stopReason: "not-real",
      } as unknown as ProviderEvent;
    }
    async function* invalidUsageType(): AsyncIterable<ProviderEvent> {
      yield {
        type: "usage",
        inputTokens: 1n,
        outputTokens: 0,
      } as unknown as ProviderEvent;
    }

    await expect(collectProviderEvents(unknownEvent())).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(collectProviderEvents(invalidText())).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(collectProviderEvents(invalidStopReason())).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(collectProviderEvents(invalidUsageType())).rejects.toMatchObject({
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

  it.each([
    ["authentication", "Provider authentication failed"],
    ["rate_limit", "Provider rate limit reached"],
    ["context_overflow", "Provider context limit exceeded"],
    ["transport", "Provider request failed"],
    ["cancelled", "Provider request cancelled"],
    ["invalid_response", "Provider returned an invalid response"],
  ] as const)("maps %s failures without exposing provider details", (code, expected) => {
    const error = new ProviderError(
      code,
      "RECURS_PROVIDER_ERROR_CANARY",
      false,
      { cause: new Error("RECURS_PROVIDER_CAUSE_CANARY") },
    );

    expect(safeProviderErrorMessage(error)).toBe(expected);
    expect(safeProviderErrorMessage(code)).toBe(expected);
  });
});
