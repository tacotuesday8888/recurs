import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ModelProvider,
  ProviderEvent,
  ProviderRequest,
} from "@recurs/contracts";
import {
  DEFAULT_PROVIDER_STREAM_IDLE_TIMEOUT_MS,
  ProviderError,
  streamProviderEvents,
} from "../src/index.js";

function request(signal: AbortSignal): ProviderRequest {
  return {
    model: "test-model",
    messages: [],
    tools: [],
    signal,
  };
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const collected: ProviderEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new ProviderError("cancelled", "underlying cancelled", false)),
      { once: true },
    );
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("streamProviderEvents", () => {
  it("fails a silent provider with a retryable bounded timeout", async () => {
    vi.useFakeTimers();
    let providerSignal: AbortSignal | undefined;
    const provider: ModelProvider = {
      id: "silent",
      async *stream(input) {
        yield* [] as ProviderEvent[];
        providerSignal = input.signal;
        await waitForAbort(input.signal);
      },
    };
    const pending = collect(streamProviderEvents(
      provider,
      request(new AbortController().signal),
    ));
    const assertion = expect(pending).rejects.toMatchObject({
      code: "transport",
      retryable: true,
      message: "Provider stream timed out",
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_PROVIDER_STREAM_IDLE_TIMEOUT_MS);

    await assertion;
    expect(providerSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts a fresh idle deadline after every normalized event", async () => {
    vi.useFakeTimers();
    const firstGate = deferred();
    const secondGate = deferred();
    const provider: ModelProvider = {
      id: "active",
      async *stream() {
        await firstGate.promise;
        yield { type: "text_delta", text: "working" };
        await secondGate.promise;
        yield { type: "done", stopReason: "complete" };
      },
    };
    const iterator = streamProviderEvents(
      provider,
      request(new AbortController().signal),
    )[Symbol.asyncIterator]();

    const first = iterator.next();
    await vi.advanceTimersByTimeAsync(200_000);
    firstGate.resolve();
    await expect(first).resolves.toMatchObject({
      done: false,
      value: { type: "text_delta", text: "working" },
    });
    const completion = iterator.next();
    await vi.advanceTimersByTimeAsync(200_000);
    secondGate.resolve();

    await expect(completion).resolves.toMatchObject({
      done: false,
      value: { type: "done", stopReason: "complete" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates user cancellation immediately and cancels the provider", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const provider: ModelProvider = {
      id: "cancelled",
      async *stream(input) {
        yield* [] as ProviderEvent[];
        providerSignal = input.signal;
        await waitForAbort(input.signal);
      },
    };
    const pending = collect(streamProviderEvents(provider, request(controller.signal)));
    const assertion = expect(pending).rejects.toMatchObject({
      code: "cancelled",
      retryable: false,
    });

    controller.abort();

    await assertion;
    expect(providerSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
