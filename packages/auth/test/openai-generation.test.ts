import { describe, expect, it } from "vitest";

import type { ProviderRequest } from "@recurs/contracts";

import {
  NativeFrameDecoder,
  NativeMessageType,
  decodeOpenAIGenerationRequestBody,
  encodeOpenAIGenerationRequest,
} from "../src/index.js";

function request(): ProviderRequest {
  return {
    model: "gpt-5.6-sol",
    messages: [
      { id: "system-1", role: "system", content: "Be precise." },
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
      },
      { id: "tool-1", role: "tool", content: "contents", toolCallId: "call-1" },
      {
        id: "assistant-2",
        role: "assistant",
        content: "prior text is replaced by provider state",
        providerStateHandle: {
          kind: "direct",
          id: "81000000-0000-4000-8000-000000000001",
          storageClass: "persistent_broker",
          recursSessionId: "session-1",
          connectionId: "71000000-0000-4000-8000-000000000001",
          adapterId: "openai-responses",
          modelId: "gpt-5.6-sol",
          backendFingerprint: `sha256:${"a".repeat(64)}`,
          stateVersion: 1,
          originTurnId: "turn-1",
          continuationSequence: 1,
          status: "committed",
        },
      },
      { id: "user-1", role: "user", content: "continue" },
    ],
    tools: [{
      name: "read_file",
      description: "Read one file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    }],
    signal: new AbortController().signal,
    directContext: {
      authorization: {
        kind: "run",
        id: "authorization-2",
        operation: "run",
        sessionId: "session-1",
        operationId: "operation-2",
        turnId: "turn-2",
        connectionId: "71000000-0000-4000-8000-000000000001",
        modelId: "gpt-5.6-sol",
        backendFingerprint: `sha256:${"a".repeat(64)}`,
        connectionRevision: 2,
        policyRevision: "openai-api-2026-07-11",
        billingMode: "strict_primary_only",
        billingSelectionDigest: `sha256:${"b".repeat(64)}`,
        contextDigest: `sha256:${"c".repeat(64)}`,
        maxRequests: 40,
        expiresAt: "2026-07-15T00:00:00.000Z",
      },
      expectedSessionRecordSequence: 4,
    },
  };
}

describe("native OpenAI generation wire request", () => {
  it("encodes the reviewed Anthropic adapter on the shared wire", () => {
    const decoder = new NativeFrameDecoder();
    const [frame] = decoder.push(
      encodeOpenAIGenerationRequest(42, request(), "anthropic-messages"),
    );
    decoder.finish();
    expect(frame).toBeDefined();
    expect(decodeOpenAIGenerationRequestBody(frame!).adapterId).toBe(
      "anthropic-messages",
    );
  });

  it("encodes an exact bounded request without signals or duplicate provider output", () => {
    const encoded = encodeOpenAIGenerationRequest(41, request());
    const decoder = new NativeFrameDecoder();
    const frames = decoder.push(encoded);
    decoder.finish();
    const frame = frames[0]!;

    expect(frame.type).toBe(NativeMessageType.openAIGenerationRequest);
    expect(frame.requestId).toBe(41);
    const body = decodeOpenAIGenerationRequestBody(frame);
    expect(body).toMatchObject({
      format: 1,
      authorizationId: "authorization-2",
      sessionId: "session-1",
      turnId: "turn-2",
      expectedSessionRecordSequence: 4,
      maxOutputTokens: 8_192,
    });
    expect(body.input).toEqual([
      { kind: "message", role: "system", text: "Be precise." },
      { kind: "function_call", callId: "call-1", name: "read_file", arguments: { path: "a.ts" } },
      { kind: "function_call_output", callId: "call-1", output: "contents" },
      { kind: "continuation", handle: expect.objectContaining({ continuationSequence: 1 }) },
      { kind: "message", role: "user", text: "continue" },
    ]);
    expect(JSON.stringify(body)).not.toContain("AbortSignal");
    expect(JSON.stringify(body)).not.toContain("prior text is replaced");
  });

  it("rejects missing direct authorization and non-JSON tool arguments", () => {
    expect(() => encodeOpenAIGenerationRequest(41, {
      ...request(),
      directContext: undefined,
    })).toThrow();
    expect(() => encodeOpenAIGenerationRequest(41, {
      ...request(),
      messages: [{
        id: "assistant-1",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "bad", arguments: { value: BigInt(1) } }],
      }],
    })).toThrow();
  });
});
