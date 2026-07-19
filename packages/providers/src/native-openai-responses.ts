import type {
  ConnectionBoundModelProvider,
  NativeOpenAIResponsesPort,
  ProviderEvent,
  ProviderRequest,
} from "@recurs/contracts";
import { NativeOpenAIResponsesError } from "@recurs/contracts";

import { ProviderError } from "./types.js";
import { harnessProfileForAdapter } from "./harness-profile.js";

export interface NativeOpenAIResponsesProviderOptions {
  readonly connectionId: string;
  readonly modelId: string;
  readonly port: NativeOpenAIResponsesPort;
  readonly providerId?: "openai-api" | "anthropic-api" | "kimi-code";
  readonly adapterId?: "openai-responses" | "anthropic-messages" | "openai-chat-completions";
}

function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value === value.trim();
}

function nativeFailure(error: NativeOpenAIResponsesError): ProviderError {
  switch (error.code) {
    case "invalid_credential":
    case "authentication_rejected":
      return new ProviderError("authentication", error.message, false);
    case "rate_limited":
      return new ProviderError("rate_limit", error.message, true);
    case "request_too_large":
      return new ProviderError("context_overflow", error.message, false);
    case "invalid_request":
    case "invalid_response":
    case "response_too_large":
    case "credential_echo_detected":
      return new ProviderError("invalid_response", error.message, false);
    case "provider_unavailable":
      return new ProviderError("transport", error.message, true);
    case "cancelled":
      return new ProviderError("cancelled", error.message, false);
    case "route_unavailable":
    case "delivery_uncertain":
    case "request_rejected":
    case "content_filtered":
    case "provider_failure":
      return new ProviderError("transport", error.message, false);
  }
}

export class NativeOpenAIResponsesProvider
  implements ConnectionBoundModelProvider {
  readonly id: "openai-api" | "anthropic-api" | "kimi-code";
  readonly adapterId: "openai-responses" | "anthropic-messages" | "openai-chat-completions";
  readonly connectionId: string;
  readonly harnessProfile;
  readonly #modelId: string;
  readonly #port: NativeOpenAIResponsesPort;

  constructor(options: NativeOpenAIResponsesProviderOptions) {
    if (!validIdentity(options.connectionId) || !validIdentity(options.modelId)) {
      throw new TypeError("Native OpenAI connection identity is invalid");
    }
    this.connectionId = options.connectionId;
    this.id = options.providerId ?? "openai-api";
    this.adapterId = options.adapterId ?? "openai-responses";
    if (
      (this.id === "openai-api" && this.adapterId !== "openai-responses") ||
      (this.id === "anthropic-api" && this.adapterId !== "anthropic-messages") ||
      (this.id === "kimi-code" && this.adapterId !== "openai-chat-completions")
    ) {
      throw new TypeError("Native provider profile is invalid");
    }
    this.harnessProfile = harnessProfileForAdapter(this.adapterId);
    this.#modelId = options.modelId;
    this.#port = options.port;
  }

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const context = request.directContext;
    const authorization = context?.authorization;
    if (
      request.model !== this.#modelId ||
      context === undefined ||
      authorization === undefined ||
      authorization.operation !== "run" ||
      authorization.turnId === null ||
      authorization.connectionId !== this.connectionId ||
      authorization.modelId !== this.#modelId ||
      !Number.isSafeInteger(context.expectedSessionRecordSequence) ||
      context.expectedSessionRecordSequence < 0
    ) {
      throw new ProviderError(
        "authentication",
        "Native OpenAI run authorization is invalid",
        false,
      );
    }

    try {
      yield* this.#port.streamOpenAIResponses(request, this.adapterId);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (error instanceof NativeOpenAIResponsesError) {
        throw nativeFailure(error);
      }
      throw new ProviderError(
        request.signal.aborted ? "cancelled" : "transport",
        request.signal.aborted
          ? "Native OpenAI request was cancelled"
          : "Native OpenAI request failed",
        false,
      );
    }
  }
}
