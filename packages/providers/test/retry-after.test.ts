import { describe, expect, it } from "vitest";

import {
  MAX_PROVIDER_RETRY_AFTER_MS,
  ProviderError,
} from "../src/index.js";
import { retryAfterMilliseconds } from "../src/retry-after.js";

describe("provider retry timing", () => {
  it("prefers milliseconds and bounds every provider-requested delay", () => {
    expect(retryAfterMilliseconds(new Headers({
      "retry-after-ms": "125.2",
      "retry-after": "9",
    }))).toBe(126);
    expect(retryAfterMilliseconds(new Headers({
      "retry-after": "999999",
    }))).toBe(MAX_PROVIDER_RETRY_AFTER_MS);
  });

  it("accepts seconds or an HTTP date and rejects malformed values", () => {
    expect(retryAfterMilliseconds(new Headers({ "retry-after": "1.25" })))
      .toBe(1_250);
    expect(retryAfterMilliseconds(
      new Headers({ "retry-after": "Mon, 20 Jul 2026 12:00:02 GMT" }),
      Date.parse("Mon, 20 Jul 2026 12:00:00 GMT"),
    )).toBe(2_000);
    expect(retryAfterMilliseconds(new Headers({ "retry-after": "later" })))
      .toBeUndefined();
  });

  it("retains only canonical nonnegative retry metadata on provider errors", () => {
    expect(new ProviderError("rate_limit", "safe", true, {
      retryAfterMs: 750,
    }).retryAfterMs).toBe(750);
    expect(new ProviderError("rate_limit", "safe", true, {
      retryAfterMs: -1,
    }).retryAfterMs).toBeUndefined();
    expect(new ProviderError("rate_limit", "safe", true, {
      retryAfterMs: Number.MAX_SAFE_INTEGER,
    }).retryAfterMs).toBe(MAX_PROVIDER_RETRY_AFTER_MS);
  });
});
