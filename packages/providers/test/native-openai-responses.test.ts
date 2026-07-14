import { describe, expect, it } from "vitest";

import type {
  NativeOpenAIResponsesPort,
  ProviderEvent,
  ProviderRequest,
} from "@recurs/contracts";
import { NativeOpenAIResponsesError } from "@recurs/contracts";

import {
  NativeOpenAIResponsesProvider,
  ProviderError,
} from "../src/index.js";

function request(): ProviderRequest {
  return {
    model: "gpt-5.6-sol",
    messages: [{ id: "user-1", role: "user", content: "inspect" }],
    tools: [],
    signal: new AbortController().signal,
    directContext: {
      authorization: {
        kind: "run",
        id: "authorization-1",
        operation: "run",
        sessionId: "session-1",
        operationId: "operation-1",
        turnId: "turn-1",
        connectionId: "connection-1",
        modelId: "gpt-5.6-sol",
        backendFingerprint: `sha256:${"a".repeat(64)}`,
        connectionRevision: 1,
        policyRevision: "openai-api-2026-07-11",
        billingMode: "strict_primary_only",
        billingSelectionDigest: `sha256:${"b".repeat(64)}`,
        contextDigest: `sha256:${"c".repeat(64)}`,
        maxRequests: 40,
        expiresAt: "2026-07-15T00:00:00.000Z",
      },
      expectedSessionRecordSequence: 1,
    },
  };
}

describe("native OpenAI Responses provider", () => {
  it("forwards one authorized exact-model stream to the native authority", async () => {
    let received: ProviderRequest | undefined;
    const port: NativeOpenAIResponsesPort = {
      async *streamOpenAIResponses(input) {
        received = input;
        yield { type: "text_delta", text: "done" };
        yield { type: "done", stopReason: "complete" };
      },
    };
    const provider = new NativeOpenAIResponsesProvider({
      connectionId: "connection-1",
      modelId: "gpt-5.6-sol",
      port,
    });

    const input = request();
    const events: ProviderEvent[] = [];
    for await (const event of provider.stream(input)) events.push(event);

    expect(received).toBe(input);
    expect(events).toEqual([
      { type: "text_delta", text: "done" },
      { type: "done", stopReason: "complete" },
    ]);
    expect(provider).toMatchObject({
      id: "openai-api",
      adapterId: "openai-responses",
      connectionId: "connection-1",
    });
  });

  it("rejects missing or mismatched run authority before native work", async () => {
    let calls = 0;
    const port: NativeOpenAIResponsesPort = {
      async *streamOpenAIResponses() {
        calls += 1;
        yield { type: "done", stopReason: "complete" };
      },
    };
    const provider = new NativeOpenAIResponsesProvider({
      connectionId: "connection-1",
      modelId: "gpt-5.6-sol",
      port,
    });

    for (const invalid of [
      { ...request(), directContext: undefined },
      { ...request(), model: "gpt-5.6" },
      {
        ...request(),
        directContext: {
          ...request().directContext!,
          authorization: {
            ...request().directContext!.authorization,
            connectionId: "connection-2",
          },
        },
      },
    ]) {
      const error = await collectError(provider.stream(invalid));
      expect(error).toMatchObject({ code: "authentication" });
    }
    expect(calls).toBe(0);
  });

  it("maps native failures to stable provider failures", async () => {
    const port: NativeOpenAIResponsesPort = {
      streamOpenAIResponses() {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<ProviderEvent>> {
                throw new Error("RECURS_NATIVE_OPENAI_CANARY");
              },
            };
          },
        };
      },
    };
    const provider = new NativeOpenAIResponsesProvider({
      connectionId: "connection-1",
      modelId: "gpt-5.6-sol",
      port,
    });

    const error = await collectError(provider.stream(request()));
    expect(error).toEqual(expect.objectContaining({
      code: "transport",
      retryable: false,
    }));
    expect((error as Error).message).not.toContain("CANARY");
  });

  it.each([
    ["invalid_credential", "authentication", false],
    ["authentication_rejected", "authentication", false],
    ["rate_limited", "rate_limit", true],
    ["request_too_large", "context_overflow", false],
    ["invalid_response", "invalid_response", false],
    ["provider_unavailable", "transport", true],
    ["delivery_uncertain", "transport", false],
    ["cancelled", "cancelled", false],
  ] as const)("maps native %s without leaking details", async (
    nativeCode,
    providerCode,
    retryable,
  ) => {
    const port: NativeOpenAIResponsesPort = {
      streamOpenAIResponses() {
        return failingStream(new NativeOpenAIResponsesError(nativeCode));
      },
    };
    const provider = new NativeOpenAIResponsesProvider({
      connectionId: "connection-1",
      modelId: "gpt-5.6-sol",
      port,
    });

    await expect(collectError(provider.stream(request()))).resolves
      .toMatchObject({ code: providerCode, retryable });
  });
});

function failingStream(error: Error): AsyncIterable<ProviderEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<ProviderEvent>> {
          throw error;
        },
      };
    },
  };
}

async function collectError(events: AsyncIterable<ProviderEvent>): Promise<unknown> {
  try {
    for await (const event of events) {
      void event;
    }
  } catch (error) {
    return error;
  }
  throw new ProviderError("invalid_response", "Expected failure", false);
}
