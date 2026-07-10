import {
  ProviderError,
  type ModelProvider,
  type ProviderEvent,
  type ProviderRequest,
} from "./types.js";

export type ScriptedResponse = readonly ProviderEvent[] | Error;

export class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly responses: readonly ScriptedResponse[]) {}

  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const responseIndex = this.requests.length;
    this.requests.push({
      ...request,
      messages: [...request.messages],
      tools: [...request.tools],
    });
    const response = this.responses[responseIndex];
    if (response === undefined) {
      throw new ProviderError(
        "invalid_response",
        `No scripted response at index ${responseIndex}`,
        false,
      );
    }
    if (response instanceof Error) {
      throw response;
    }

    for (const event of response) {
      if (request.signal.aborted) {
        throw new ProviderError("cancelled", "Provider request cancelled", false);
      }
      yield event;
    }
  }
}
