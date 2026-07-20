import type { JsonValue } from "./json.js";
import type { RunAuthorization } from "./runtime.js";

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

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
}

export type ModelReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type StopReason =
  | "complete"
  | "tool_calls"
  | "length"
  | "cancelled"
  | "error";

export interface ProviderRequest {
  model: string;
  messages: readonly ModelMessage[];
  tools: readonly ToolDefinition[];
  signal: AbortSignal;
  reasoningEffort?: ModelReasoningEffort;
  directContext?: DirectProviderRunContext;
}

export type ModelHarnessProfileId =
  | "native_tool_use_v1"
  | "native_tool_use_v2"
  | "compatible_tool_use_v1";

interface ModelHarnessProfileBase {
  readonly toolCallStyle: "native" | "conservative";
  readonly instructions: readonly string[];
}

export type ModelHarnessProfile = ModelHarnessProfileBase & (
  | { readonly id: "native_tool_use_v1"; readonly version: 1 }
  | { readonly id: "native_tool_use_v2"; readonly version: 2 }
  | { readonly id: "compatible_tool_use_v1"; readonly version: 1 }
);

export interface DirectProviderRunContext {
  readonly authorization: RunAuthorization;
  readonly expectedSessionRecordSequence: number;
}

export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "provider_state"; handle: DirectContinuationHandle }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; stopReason: StopReason };

export interface ModelProvider {
  readonly id: string;
  readonly harnessProfile?: ModelHarnessProfile;
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}

export interface ConnectionBoundModelProvider extends ModelProvider {
  readonly adapterId: string;
  readonly connectionId: string;
}

export interface ProviderBackedMessage extends ModelMessage {
  providerStateHandle?: DirectContinuationHandle;
}

export interface DirectContinuationHandle {
  kind: "direct";
  id: string;
  storageClass: "persistent_broker" | "process_scoped";
  ownerInstanceId?: string;
  expiresAt?: string;
  recursSessionId: string;
  connectionId: string;
  adapterId: string;
  modelId: string;
  backendFingerprint: string;
  stateVersion: number;
  originTurnId: string;
  continuationSequence: number;
  status: "committed" | "uncertain";
}
