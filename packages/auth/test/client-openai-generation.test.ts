import { Duplex } from "node:stream";

import { describe, expect, it } from "vitest";

import type { ProviderRequest } from "@recurs/contracts";
import {
  NativeFrameDecoder,
  NativeMessageType,
  connectNativeAuthorityClient,
  encodeBoolean,
  encodeFieldTable,
  encodeNativeFrame,
  encodeNonce,
  encodeU16,
  encodeVersionText,
} from "../src/index.js";
import type { NativeFrame } from "../src/index.js";

const nonce = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

class ScriptedDuplex extends Duplex {
  readonly #decoder = new NativeFrameDecoder();
  constructor(readonly onFrame: (frame: NativeFrame, peer: ScriptedDuplex) => void) { super(); }
  override _read(): void {}
  override _write(chunk: Buffer, _: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      for (const frame of this.#decoder.push(chunk)) this.onFrame(frame, this);
      callback();
    } catch (error) { callback(error as Error); }
  }
  respond(frame: Uint8Array): void { this.push(Buffer.from(frame)); }
}

function hello(frame: NativeFrame): Uint8Array {
  return encodeNativeFrame({
    type: NativeMessageType.helloResult,
    requestId: frame.requestId,
    payload: encodeFieldTable([
      { tag: 1, value: encodeVersionText("0.1.0") },
      { tag: 2, value: encodeVersionText("0.1.0") },
      { tag: 3, value: encodeNonce(nonce) },
      { tag: 4, value: encodeBoolean(true) },
      { tag: 5, value: encodeBoolean(true) },
      { tag: 6, value: encodeVersionText("14.4") },
    ]),
  });
}

function health(frame: NativeFrame): Uint8Array {
  return encodeNativeFrame({
    type: NativeMessageType.healthResult,
    requestId: frame.requestId,
    payload: encodeFieldTable([
      { tag: 1, value: encodeU16(1) },
      { tag: 2, value: encodeBoolean(true) },
    ]),
  });
}

function generation(frame: NativeFrame, value: unknown, type = NativeMessageType.openAIGenerationEvent): Uint8Array {
  return encodeNativeFrame({
    type,
    requestId: frame.requestId,
    payload: encodeFieldTable([{ tag: 1, value: new TextEncoder().encode(JSON.stringify(value)) }]),
  });
}

function request(signal = new AbortController().signal): ProviderRequest {
  return {
    model: "gpt-5.6-sol",
    messages: [{ id: "user-1", role: "user", content: "hello" }],
    tools: [],
    signal,
    directContext: {
      authorization: {
        kind: "run", id: "auth-1", operation: "run", sessionId: "session-1",
        operationId: "operation-1", turnId: "turn-1",
        connectionId: "71000000-0000-4000-8000-000000000001",
        modelId: "gpt-5.6-sol", backendFingerprint: `sha256:${"a".repeat(64)}`,
        connectionRevision: 1, policyRevision: "openai-api-2026-07-11",
        billingMode: "strict_primary_only", billingSelectionDigest: `sha256:${"b".repeat(64)}`,
        contextDigest: `sha256:${"c".repeat(64)}`, maxRequests: 40,
        expiresAt: "2026-07-15T00:00:00.000Z",
      },
      expectedSessionRecordSequence: 0,
    },
  };
}

describe("native authority OpenAI generation stream", () => {
  it("delivers multiple validated events for one native request", async () => {
    const socket = new ScriptedDuplex((frame, peer) => {
      if (frame.type === NativeMessageType.hello) peer.respond(hello(frame));
      if (frame.type === NativeMessageType.health) peer.respond(health(frame));
      if (frame.type === NativeMessageType.openAIGenerationRequest) {
        peer.respond(generation(frame, { type: "text_delta", text: "hello" }));
        peer.respond(generation(frame, {
          type: "usage",
          inputTokens: 5,
          outputTokens: 3,
          cachedInputTokens: 2,
          cacheWriteInputTokens: 1,
          reasoningTokens: 2,
        }));
        peer.respond(generation(frame, { type: "done", stopReason: "complete" }));
      }
    });
    const client = await connectNativeAuthorityClient(socket, {
      engineVersion: "0.1.0",
      createNonce: () => nonce,
    });
    const events = [];
    for await (const event of client.streamOpenAIResponses(request())) events.push(event);
    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      {
        type: "usage",
        inputTokens: 5,
        outputTokens: 3,
        cachedInputTokens: 2,
        cacheWriteInputTokens: 1,
        reasoningTokens: 2,
      },
      { type: "done", stopReason: "complete" },
    ]);
    client.close();
  });

  it("rejects inconsistent native usage breakdowns", async () => {
    const socket = new ScriptedDuplex((frame, peer) => {
      if (frame.type === NativeMessageType.hello) peer.respond(hello(frame));
      if (frame.type === NativeMessageType.health) peer.respond(health(frame));
      if (frame.type === NativeMessageType.openAIGenerationRequest) {
        peer.respond(generation(frame, {
          type: "usage",
          inputTokens: 2,
          outputTokens: 1,
          cachedInputTokens: 2,
          cacheWriteInputTokens: 1,
        }));
      }
    });
    const client = await connectNativeAuthorityClient(socket, {
      engineVersion: "0.1.0",
      createNonce: () => nonce,
    });
    const consume = async () => {
      for await (const event of client.streamOpenAIResponses(request())) void event;
    };

    await expect(consume()).rejects.toThrow("Native authority is unavailable.");
  });

  it("rejects malformed event bodies without exposing transport details", async () => {
    const socket = new ScriptedDuplex((frame, peer) => {
      if (frame.type === NativeMessageType.hello) peer.respond(hello(frame));
      if (frame.type === NativeMessageType.health) peer.respond(health(frame));
      if (frame.type === NativeMessageType.openAIGenerationRequest) {
        peer.respond(generation(frame, { type: "done", stopReason: "unknown" }));
      }
    });
    const client = await connectNativeAuthorityClient(socket, {
      engineVersion: "0.1.0",
      createNonce: () => nonce,
    });
    const consume = async () => {
      for await (const event of client.streamOpenAIResponses(request())) void event;
    };
    await expect(consume()).rejects.toThrow("Native authority is unavailable.");
  });

  it("cancels one generation without poisoning the native client", async () => {
    let generationRequestId = 0;
    const controller = new AbortController();
    const socket = new ScriptedDuplex((frame, peer) => {
      if (frame.type === NativeMessageType.hello) peer.respond(hello(frame));
      if (frame.type === NativeMessageType.health) peer.respond(health(frame));
      if (frame.type === NativeMessageType.openAIGenerationRequest) {
        generationRequestId = frame.requestId;
        peer.respond(generation(frame, { type: "text_delta", text: "partial" }));
      }
      if (frame.type === NativeMessageType.cancel) {
        peer.respond(encodeNativeFrame({
          type: NativeMessageType.openAIGenerationFailure,
          requestId: generationRequestId,
          payload: encodeFieldTable([{ tag: 1, value: encodeU16(1) }]),
        }));
      }
    });
    const client = await connectNativeAuthorityClient(socket, {
      engineVersion: "0.1.0",
      createNonce: () => nonce,
    });
    const iterator = client.streamOpenAIResponses(request(controller.signal))[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: "text_delta" } });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: "cancelled" });
    expect(await client.status()).toMatchObject({ state: "ready" });
    client.close();
  });
});
