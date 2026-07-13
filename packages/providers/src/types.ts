import type {
  ProviderEvent,
  StopReason,
  ToolCall,
} from "@recurs/contracts";

export type {
  JsonValue,
  ConnectionBoundModelProvider,
  MessageRole,
  ModelMessage,
  ModelProvider,
  ProviderEvent,
  ProviderRequest,
  ProviderUsage,
  StopReason,
  ToolCall,
  ToolDefinition,
} from "@recurs/contracts";

export type ProviderErrorCode =
  | "authentication"
  | "rate_limit"
  | "context_overflow"
  | "transport"
  | "cancelled"
  | "invalid_response";

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderError";
  }
}

export interface CollectedProviderEvents {
  text: string;
  toolCalls: ToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  stopReason: StopReason;
}

export interface CollectProviderEventsOptions {
  onEvent?(event: ProviderEvent): void | Promise<void>;
}
