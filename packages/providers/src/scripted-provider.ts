import {
  ProviderError,
  type ConnectionBoundModelProvider,
  type ProviderEvent,
  type ProviderRequest,
} from "./types.js";

export type ScriptedResponse = readonly ProviderEvent[] | Error;

export class ScriptedProvider implements ConnectionBoundModelProvider {
  readonly id: string;
  readonly adapterId: string;
  readonly inputModalities = ["text", "image"] as const;
  readonly connectionId: string;
  readonly requests: ProviderRequest[] = [];

  constructor(
    private readonly responses: readonly ScriptedResponse[],
    id = "scripted",
    identity: {
      readonly adapterId: string;
      readonly connectionId: string;
    } = {
      adapterId: "scripted-v1",
      connectionId: "test-connection",
    },
  ) {
    this.id = id;
    this.adapterId = identity.adapterId;
    this.connectionId = identity.connectionId;
  }

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
