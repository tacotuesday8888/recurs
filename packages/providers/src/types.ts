export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ModelMessage {
  id: string;
  role: MessageRole;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, JsonValue>;
}

export interface ProviderRequest {
  model: string;
  messages: readonly ModelMessage[];
  tools: readonly ToolDefinition[];
  signal: AbortSignal;
}

export type StopReason =
  | "complete"
  | "tool_calls"
  | "length"
  | "cancelled"
  | "error";

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; stopReason: StopReason };

export interface ModelProvider {
  readonly id: string;
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}

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
