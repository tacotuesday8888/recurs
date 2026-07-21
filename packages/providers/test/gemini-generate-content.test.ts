import { describe, expect, it } from "vitest";

import type {
  ProviderEvent,
  ProviderRequest,
  RunAuthorization,
} from "@recurs/contracts";
import {
  ProviderError,
  RemoteGeminiGenerateContentProvider,
} from "../src/index.js";

function authorization(
  turnId: string,
  overrides: Partial<RunAuthorization> = {},
): RunAuthorization {
  return {
    kind: "run",
    id: `authorization-${turnId}`,
    operation: "run",
    sessionId: "session-1",
    operationId: `operation-${turnId}`,
    turnId,
    connectionId: "gemini-env",
    modelId: "gemini-test",
    backendFingerprint: `sha256:${"a".repeat(64)}`,
    connectionRevision: 1,
    policyRevision: "policy-1",
    billingMode: "strict_primary_only",
    billingSelectionDigest: `sha256:${"b".repeat(64)}`,
    contextDigest: `sha256:${"c".repeat(64)}`,
    maxRequests: 16,
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function request(
  messages: ProviderRequest["messages"],
  turnId = "turn-1",
): ProviderRequest {
  return {
    model: "gemini-test",
    messages,
    tools: [{
      name: "read_file",
      description: "Read one workspace file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    }],
    signal: new AbortController().signal,
    directContext: {
      authorization: authorization(turnId),
      expectedSessionRecordSequence: 1,
    },
  };
}

function response(...values: readonly Record<string, unknown>[]): Response {
  return new Response(
    values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  );
}

function textResponse(text = "done"): Response {
  return response(
    {
      candidates: [{
        index: 0,
        content: {
          role: "model",
          parts: [{ text: "checking", thought: true }, { text }],
        },
        finishReason: "STOP",
      }],
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 4,
        cachedContentTokenCount: 3,
        thoughtsTokenCount: 2,
      },
      responseId: "response-1",
      modelVersion: "gemini-test-001",
    },
  );
}

async function collect(iterable: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("remote Gemini GenerateContent provider", () => {
  it("uses the fixed origin, secure headers, native tools, images, and normalized usage", async () => {
    const key = "gemini-key-canary";
    let url = "";
    let headers = new Headers();
    let body: Record<string, unknown> = {};
    const provider = new RemoteGeminiGenerateContentProvider({
      providerId: "google-gemini-api",
      connectionId: "gemini-env",
      apiKey: key,
      fetch: async (input, init) => {
        url = String(input);
        headers = new Headers(init?.headers);
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return textResponse();
      },
    });

    const events = await collect(provider.stream(request([
      { id: "system", role: "system", content: "Use workspace tools." },
      {
        id: "user",
        role: "user",
        content: "Inspect this image.",
        images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }],
      },
    ])));

    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
    );
    expect(url).not.toContain(key);
    expect(headers.get("x-goog-api-key")).toBe(key);
    expect(headers.get("x-goog-api-client")).toMatch(/^recurs\//u);
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(JSON.stringify(body)).not.toContain(key);
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: "Use workspace tools." }] },
      contents: [{
        role: "user",
        parts: [
          { text: "Inspect this image." },
          { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } },
        ],
      }],
      tools: [{
        functionDeclarations: [{
          name: "read_file",
          description: "Read one workspace file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        }],
      }],
    });
    expect(events).toEqual([
      { type: "reasoning_delta", text: "checking" },
      { type: "text_delta", text: "done" },
      {
        type: "usage",
        inputTokens: 12,
        outputTokens: 4,
        cachedInputTokens: 3,
        reasoningTokens: 2,
      },
      { type: "done", stopReason: "complete" },
    ]);
    expect(provider.inputModalities).toEqual(["text", "image"]);
    expect(provider.harnessProfile.id).toBe("native_tool_use_v2");
  });

  it("accepts non-blocking prompt feedback before the model candidate", async () => {
    const provider = new RemoteGeminiGenerateContentProvider({
      providerId: "google-gemini-api",
      connectionId: "gemini-env",
      apiKey: "private-key",
      fetch: async () => response(
        { promptFeedback: { safetyRatings: [] } },
        {
          candidates: [{
            index: 0,
            content: { role: "model", parts: [{ text: "accepted" }] },
            finishReason: "STOP",
          }],
        },
      ),
    });

    await expect(collect(provider.stream(request([
      { id: "user", role: "user", content: "Inspect." },
    ])))).resolves.toContainEqual({ type: "text_delta", text: "accepted" });
  });

  it("preserves exact thought signatures and function identities across a tool round", async () => {
    const bodies: Record<string, unknown>[] = [];
    const signature = `opaque-${"s".repeat(4_096)}`;
    let calls = 0;
    const provider = new RemoteGeminiGenerateContentProvider({
      providerId: "google-gemini-api",
      connectionId: "gemini-env",
      apiKey: "private-key",
      fetch: async (_input, init) => {
        calls += 1;
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (calls === 1) {
          return response({
            candidates: [{
              index: 0,
              content: {
                role: "model",
                parts: [{
                  functionCall: {
                    id: "provider-call-1",
                    name: "read_file",
                    args: { path: "README.md" },
                  },
                  thoughtSignature: signature,
                }],
              },
              finishReason: "STOP",
            }],
            usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2 },
          });
        }
        return textResponse("finished");
      },
    });

    const first = await collect(provider.stream(request([
      { id: "system", role: "system", content: "Use tools." },
      { id: "user", role: "user", content: "Read the README." },
    ])));
    const call = first.find((event) => event.type === "tool_call");
    const state = first.find((event) => event.type === "provider_state");
    expect(call).toEqual({
      type: "tool_call",
      call: {
        id: "provider-call-1",
        name: "read_file",
        arguments: { path: "README.md" },
      },
    });
    expect(state).toMatchObject({
      type: "provider_state",
      handle: {
        kind: "direct",
        storageClass: "process_scoped",
        connectionId: "gemini-env",
        adapterId: "gemini-generate-content",
        originTurnId: "turn-1",
        continuationSequence: 1,
      },
    });
    if (call?.type !== "tool_call" || state?.type !== "provider_state") {
      throw new Error("missing tool continuation events");
    }

    const second = await collect(provider.stream(request([
      { id: "system", role: "system", content: "Use tools." },
      { id: "user", role: "user", content: "Read the README." },
      {
        id: "assistant",
        role: "assistant",
        content: "",
        toolCalls: [call.call],
        providerStateHandle: state.handle,
      },
      {
        id: "tool-result",
        role: "tool",
        content: "README contents",
        toolCallId: call.call.id,
      },
    ])));

    expect((bodies[1]?.contents as unknown[]).slice(1)).toEqual([
      {
        role: "model",
        parts: [{
          functionCall: {
            id: "provider-call-1",
            name: "read_file",
            args: { path: "README.md" },
          },
          thoughtSignature: signature,
        }],
      },
      {
        role: "user",
        parts: [{
          functionResponse: {
            id: "provider-call-1",
            name: "read_file",
            response: { output: "README contents" },
          },
        }],
      },
    ]);
    expect(second).toContainEqual({ type: "text_delta", text: "finished" });
    expect(calls).toBe(2);
  });

  it("fails closed when an in-progress signed tool continuation belongs to another process", async () => {
    const firstProvider = new RemoteGeminiGenerateContentProvider({
      providerId: "google-gemini-api",
      connectionId: "gemini-env",
      apiKey: "private-key",
      fetch: async () => response({
        candidates: [{
          content: {
            role: "model",
            parts: [{
              functionCall: { name: "read_file", args: { path: "README.md" } },
              thoughtSignature: "opaque-signature",
            }],
          },
          finishReason: "STOP",
        }],
      }),
    });
    const first = await collect(firstProvider.stream(request([
      { id: "user", role: "user", content: "Read the README." },
    ])));
    const call = first.find((event) => event.type === "tool_call");
    const state = first.find((event) => event.type === "provider_state");
    if (call?.type !== "tool_call" || state?.type !== "provider_state") {
      throw new Error("missing tool continuation events");
    }
    let fetched = false;
    const restarted = new RemoteGeminiGenerateContentProvider({
      providerId: "google-gemini-api",
      connectionId: "gemini-env",
      apiKey: "private-key",
      fetch: async () => {
        fetched = true;
        return textResponse();
      },
    });
    await expect(collect(restarted.stream(request([
      { id: "user", role: "user", content: "Read the README." },
      {
        id: "assistant",
        role: "assistant",
        content: "",
        toolCalls: [call.call],
        providerStateHandle: state.handle,
      },
      {
        id: "tool-result",
        role: "tool",
        content: "README contents",
        toolCallId: call.call.id,
      },
    ])))).rejects.toMatchObject({ code: "invalid_response", retryable: false });
    expect(fetched).toBe(false);
  });

  it("maps safe failures and rejects malformed, blocked, or credential-bearing streams", async () => {
    const key = "credential-echo-canary";
    for (const [providerResponse, code, retryable] of [
      [new Response("private", { status: 401 }), "authentication", false],
      [new Response("private", { status: 429 }), "rate_limit", true],
      [new Response("private", { status: 302 }), "transport", false],
      [response({ promptFeedback: { blockReason: "SAFETY" } }), "invalid_response", false],
      [response({
        candidates: [{
          content: { role: "model", parts: [{ text: "blocked" }] },
          finishReason: "SAFETY",
        }],
      }), "invalid_response", false],
      [response({
        candidates: [{
          content: { role: "model", parts: [{ executableCode: { code: "bad" } }] },
          finishReason: "STOP",
        }],
      }), "invalid_response", false],
    ] as const) {
      const provider = new RemoteGeminiGenerateContentProvider({
        providerId: "google-gemini-api",
        connectionId: "gemini-env",
        apiKey: key,
        fetch: async () => providerResponse,
      });
      let thrown: unknown;
      try {
        await collect(provider.stream(request([
          { id: "user", role: "user", content: "Inspect." },
        ])));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProviderError);
      expect(thrown).toMatchObject({ code, retryable });
      expect(String(thrown)).not.toContain(key);
    }

    const echoing = new RemoteGeminiGenerateContentProvider({
      providerId: "google-gemini-api",
      connectionId: "gemini-env",
      apiKey: key,
      fetch: async () => new Response(`data: {"note":"${key}"}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
    });
    await expect(collect(echoing.stream(request([
      { id: "user", role: "user", content: "Inspect." },
    ])))).rejects.toMatchObject({ code: "invalid_response", retryable: false });
  });
});
