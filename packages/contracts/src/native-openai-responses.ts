import type { ProviderEvent, ProviderRequest } from "./model.js";

export const NATIVE_OPENAI_RESPONSES_FAILURE_MESSAGES = Object.freeze({
  cancelled: "The native OpenAI request was cancelled.",
  invalid_request: "The native OpenAI request is invalid.",
  request_too_large: "The native OpenAI request is too large.",
  invalid_credential: "The OpenAI credential is invalid.",
  route_unavailable: "The native OpenAI route is unavailable.",
  delivery_uncertain:
    "The OpenAI request did not complete; delivery or billing may have occurred.",
  invalid_response: "OpenAI returned an invalid response.",
  response_too_large: "OpenAI returned an oversized response.",
  authentication_rejected: "OpenAI rejected the credential.",
  rate_limited: "OpenAI rate-limited the request.",
  provider_unavailable: "OpenAI is temporarily unavailable.",
  request_rejected: "OpenAI rejected the request.",
  content_filtered: "OpenAI stopped the response because of its content filter.",
  provider_failure: "OpenAI failed to complete the response.",
  credential_echo_detected: "OpenAI returned prohibited credential material.",
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
  ): AsyncIterable<ProviderEvent>;
}
