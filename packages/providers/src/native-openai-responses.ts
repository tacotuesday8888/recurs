import type {
  ConnectionBoundModelProvider,
  NativeOpenAIResponsesPort,
  ProviderEvent,
  ProviderRequest,
} from "@recurs/contracts";

import { ProviderError } from "./types.js";

export interface NativeOpenAIResponsesProviderOptions {
  readonly connectionId: string;
  readonly modelId: string;
  readonly port: NativeOpenAIResponsesPort;
}

function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 256 && value === value.trim();
}

export class NativeOpenAIResponsesProvider
  implements ConnectionBoundModelProvider {
  readonly id = "openai-api";
  readonly adapterId = "openai-responses";
  readonly connectionId: string;
  readonly #modelId: string;
  readonly #port: NativeOpenAIResponsesPort;

  constructor(options: NativeOpenAIResponsesProviderOptions) {
    if (!validIdentity(options.connectionId) || !validIdentity(options.modelId)) {
      throw new TypeError("Native OpenAI connection identity is invalid");
    }
    this.connectionId = options.connectionId;
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
      yield* this.#port.streamOpenAIResponses(request);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
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
