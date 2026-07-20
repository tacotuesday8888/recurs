import type {
  ModelProvider,
  ProviderEvent,
  ProviderRequest,
} from "./types.js";
import { ProviderError } from "./types.js";

export const DEFAULT_PROVIDER_STREAM_IDLE_TIMEOUT_MS = 300_000;

function cancelled(): ProviderError {
  return new ProviderError(
    "cancelled",
    "Provider stream was cancelled",
    false,
  );
}

async function nextEvent(
  iterator: AsyncIterator<ProviderEvent>,
  userSignal: AbortSignal,
  timeoutController: AbortController,
): Promise<IteratorResult<ProviderEvent>> {
  if (userSignal.aborted) throw cancelled();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const idle = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timeoutController.abort();
      reject(new ProviderError(
        "transport",
        "Provider stream timed out",
        true,
      ));
    }, DEFAULT_PROVIDER_STREAM_IDLE_TIMEOUT_MS);
    (timeout as unknown as { unref?(): void }).unref?.();
  });
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      timeoutController.abort();
      reject(cancelled());
    };
    userSignal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => userSignal.removeEventListener("abort", onAbort);
  });

  try {
    const result = await Promise.race([iterator.next(), idle, aborted]);
    if (userSignal.aborted) throw cancelled();
    return result;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    removeAbortListener?.();
  }
}

export async function* streamProviderEvents(
  provider: ModelProvider,
  request: ProviderRequest,
): AsyncGenerator<ProviderEvent> {
  const timeoutController = new AbortController();
  const signal = AbortSignal.any([request.signal, timeoutController.signal]);
  const iterator = provider.stream({ ...request, signal })[Symbol.asyncIterator]();
  let finished = false;

  try {
    while (true) {
      const next = await nextEvent(iterator, request.signal, timeoutController);
      if (next.done) {
        finished = true;
        return;
      }
      yield next.value;
    }
  } finally {
    if (!finished) {
      timeoutController.abort();
      void iterator.return?.().catch(() => undefined);
    }
  }
}
