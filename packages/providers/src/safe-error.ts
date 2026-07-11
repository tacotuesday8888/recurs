import {
  type ProviderError,
  type ProviderErrorCode,
} from "./types.js";

const safeMessages: Record<ProviderErrorCode, string> = {
  authentication: "Provider authentication failed",
  rate_limit: "Provider rate limit reached",
  context_overflow: "Provider context limit exceeded",
  transport: "Provider request failed",
  cancelled: "Provider request cancelled",
  invalid_response: "Provider returned an invalid response",
};

export function safeProviderErrorMessage(
  error: ProviderError | ProviderErrorCode,
): string {
  const code = typeof error === "string" ? error : error.code;
  return safeMessages[code] ?? "Provider request failed";
}
