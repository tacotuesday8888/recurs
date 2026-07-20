import type {
  ProviderEvent,
  ProviderUsage,
  DirectContinuationHandle,
  StopReason,
  ToolCall,
} from "@recurs/contracts";

export type {
  JsonValue,
  ConnectionBoundModelProvider,
  DirectContinuationHandle,
  DirectProviderRunContext,
  MessageRole,
  ModelMessage,
  ModelProvider,
  ProviderEvent,
  ProviderRequest,
  ProviderUsage,
  ProviderBackedMessage,
  RunAuthorization,
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

export interface ProviderErrorOptions extends ErrorOptions {
  readonly retryAfterMs?: number;
}

export const MAX_PROVIDER_RETRY_AFTER_MS = 30_000;

export class ProviderError extends Error {
  readonly retryAfterMs?: number;

  constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryable: boolean,
    options?: ProviderErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderError";
    if (
      Number.isSafeInteger(options?.retryAfterMs) &&
      Number(options?.retryAfterMs) >= 0
    ) {
      this.retryAfterMs = Math.min(
        MAX_PROVIDER_RETRY_AFTER_MS,
        Number(options?.retryAfterMs),
      );
    }
  }
}

export interface CollectedProviderEvents {
  text: string;
  toolCalls: ToolCall[];
  usage: ProviderUsage;
  usageReported: boolean;
  stopReason: StopReason;
  providerStateHandle?: DirectContinuationHandle;
}

export interface CollectProviderEventsOptions {
  onEvent?(event: ProviderEvent): void | Promise<void>;
}
