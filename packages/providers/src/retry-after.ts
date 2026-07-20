import { MAX_PROVIDER_RETRY_AFTER_MS } from "./types.js";

export { MAX_PROVIDER_RETRY_AFTER_MS } from "./types.js";

const DECIMAL = /^\d+(?:\.\d+)?$/u;

function boundedMilliseconds(value: number): number | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.min(MAX_PROVIDER_RETRY_AFTER_MS, Math.ceil(value));
}

export function retryAfterMilliseconds(
  headers: Pick<Headers, "get">,
  now = Date.now(),
): number | undefined {
  const milliseconds = headers.get("retry-after-ms")?.trim();
  if (milliseconds !== undefined && DECIMAL.test(milliseconds)) {
    return boundedMilliseconds(Number(milliseconds));
  }

  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter === undefined || retryAfter.length === 0) return undefined;
  if (DECIMAL.test(retryAfter)) {
    return boundedMilliseconds(Number(retryAfter) * 1_000);
  }
  const date = Date.parse(retryAfter);
  return Number.isFinite(date)
    ? boundedMilliseconds(Math.max(0, date - now))
    : undefined;
}

export function retryAfterOptions(
  headers: Pick<Headers, "get">,
): { readonly retryAfterMs: number } | undefined {
  const retryAfterMs = retryAfterMilliseconds(headers);
  return retryAfterMs === undefined ? undefined : { retryAfterMs };
}
