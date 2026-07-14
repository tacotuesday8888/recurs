import type { ProviderEvent, ProviderRequest } from "./model.js";

export interface NativeOpenAIResponsesPort {
  streamOpenAIResponses(
    request: ProviderRequest,
  ): AsyncIterable<ProviderEvent>;
}
