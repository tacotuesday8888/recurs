import type { ProviderEvent, ProviderRequest } from "./model.js";

export const NATIVE_OPENAI_RESPONSES_FAILURE_MESSAGES = Object.freeze({
  cancelled: "The native provider request was cancelled.",
  invalid_request: "The native provider request is invalid.",
  request_too_large: "The native provider request is too large.",
  invalid_credential: "The provider credential is invalid.",
  route_unavailable: "The native provider route is unavailable.",
  delivery_uncertain:
    "The provider request did not complete; delivery or billing may have occurred.",
  invalid_response: "The provider returned an invalid response.",
  response_too_large: "The provider returned an oversized response.",
  authentication_rejected: "The provider rejected the credential.",
  rate_limited: "The provider rate-limited the request.",
  provider_unavailable: "The provider is temporarily unavailable.",
  request_rejected: "The provider rejected the request.",
  content_filtered: "The provider stopped the response because of its content filter.",
  provider_failure: "The provider failed to complete the response.",
  credential_echo_detected: "The provider returned prohibited credential material.",
} as const);

export type NativeOpenAIResponsesFailureCode =
  keyof typeof NATIVE_OPENAI_RESPONSES_FAILURE_MESSAGES;

export class NativeOpenAIResponsesError extends Error {
  constructor(public readonly code: NativeOpenAIResponsesFailureCode) {
    super(NATIVE_OPENAI_RESPONSES_FAILURE_MESSAGES[code]);
    this.name = "NativeOpenAIResponsesError";
  }
}

export interface NativeOpenAIResponsesPort {
  streamOpenAIResponses(
    request: ProviderRequest,
    adapterId?: "openai-responses" | "anthropic-messages" | "openai-chat-completions",
  ): AsyncIterable<ProviderEvent>;
}
