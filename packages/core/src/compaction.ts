import { randomUUID } from "node:crypto";

import type { IntegrationFailure, VerifiedModelLimits } from "@recurs/contracts";
import {
  ProviderError,
  collectProviderEvents,
  safeProviderErrorMessage,
  type ModelMessage,
  type ModelProvider,
  type ProviderErrorCode,
  type ProviderRequest,
  type ProviderUsage,
} from "@recurs/providers";

import type { JsonlSessionStore } from "./jsonl-session-store.js";
import type { SessionState } from "./session.js";
import {
  reduceSessionRecordV2,
  type PinnedSessionState,
} from "./session-v2.js";

export const MAX_COMPACTION_CONTEXT_BYTES = 256 * 1024;
export const AUTO_COMPACTION_OUTPUT_RESERVE_TOKENS = 20_000;
export const AUTO_COMPACTION_GROWTH_HEADROOM_TOKENS = 4_096;
const MAX_COMPACTION_MESSAGE_BYTES = 32 * 1024;
const MAX_COMPACTION_MESSAGES = 128;
const MAX_METADATA_ITEMS = 32;
const MAX_METADATA_ITEM_BYTES = 1024;
const MAX_METADATA_TEXT_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface CompactionResult {
  summary: string;
  retainedMessages: ModelMessage[];
  usage: ProviderUsage | null;
  usageSource: "provider" | "unavailable";
}

export interface DurableCompactionInput {
  sessions: JsonlSessionStore;
  state: PinnedSessionState;
  provider: ModelProvider;
  signal: AbortSignal;
  at: string;
}

export interface ProactiveCompactionDecision {
  compact: boolean;
  thresholdTokens: number | null;
  projectedInputTokens: number | null;
  reason:
    | "threshold_reached"
    | "unverified_limit"
    | "usage_unavailable"
    | "insufficient_history"
    | "below_threshold";
}

function compactionOutputReserve(limits: VerifiedModelLimits): number {
  return Math.min(
    limits.maxOutputTokens ?? AUTO_COMPACTION_OUTPUT_RESERVE_TOKENS,
    AUTO_COMPACTION_OUTPUT_RESERVE_TOKENS,
  );
}

export function proactiveCompactionDecision(
  state: PinnedSessionState,
  prompt: string,
): ProactiveCompactionDecision {
  const limits = state.backend.pin.modelLimitsAtCreation;
  if (limits === undefined) {
    return {
      compact: false,
      thresholdTokens: null,
      projectedInputTokens: null,
      reason: "unverified_limit",
    };
  }
  const usage = state.lastProviderUsage;
  if (usage === undefined || usage === null || usage.inputTokens <= 0) {
    return {
      compact: false,
      thresholdTokens: null,
      projectedInputTokens: null,
      reason: "usage_unavailable",
    };
  }
  if (state.messages.length <= 6) {
    return {
      compact: false,
      thresholdTokens: null,
      projectedInputTokens: null,
      reason: "insufficient_history",
    };
  }
  const outputReserve = compactionOutputReserve(limits);
  const thresholdTokens = Math.min(
    Math.floor(limits.maxInputTokens * 0.9),
    limits.maxInputTokens - outputReserve,
  );
  if (thresholdTokens <= 0) {
    return {
      compact: false,
      thresholdTokens,
      projectedInputTokens: null,
      reason: "below_threshold",
    };
  }
  const promptBytes = encoder.encode(prompt).byteLength;
  const projectedInputTokens = Math.min(
    Number.MAX_SAFE_INTEGER,
    usage.inputTokens + usage.outputTokens + promptBytes +
      AUTO_COMPACTION_GROWTH_HEADROOM_TOKENS,
  );
  return projectedInputTokens >= thresholdTokens
    ? {
        compact: true,
        thresholdTokens,
        projectedInputTokens,
        reason: "threshold_reached",
      }
    : {
        compact: false,
        thresholdTokens,
        projectedInputTokens,
        reason: "below_threshold",
      };
}

function retainedContinuation(
  messages: readonly ModelMessage[],
  targetCount: number,
): ModelMessage[] {
  let start = Math.max(0, messages.length - targetCount);
  while (messages[start]?.role === "tool") {
    const callId = messages[start]?.toolCallId;
    let requestIndex = -1;
    if (callId !== undefined) {
      for (let index = start - 1; index >= 0; index -= 1) {
        if (messages[index]?.toolCalls?.some((call) => call.id === callId)) {
          requestIndex = index;
          break;
        }
      }
    }
    start = requestIndex >= 0 ? requestIndex : start + 1;
  }
  return messages.slice(start);
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function boundedText(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value;
  const suffix = "\n...[truncated]";
  const suffixBytes = byteLength(suffix);
  const prefix = decoder.decode(
    encoder.encode(value).slice(0, Math.max(0, maxBytes - suffixBytes)),
  );
  return `${prefix}${suffix}`;
}

function boundedItems(
  values: readonly string[],
  maxItemBytes = MAX_METADATA_ITEM_BYTES,
): string[] {
  return values.slice(-MAX_METADATA_ITEMS).map((value) =>
    boundedText(value, maxItemBytes)
  );
}

function projectedMessage(
  message: ModelMessage,
  maxContentBytes = MAX_COMPACTION_MESSAGE_BYTES,
): Record<string, unknown> {
  return {
    id: message.id,
    role: message.role,
    content: boundedText(message.content, maxContentBytes),
    ...(message.toolCallId === undefined
      ? {}
      : { toolCallId: message.toolCallId }),
    ...(message.toolCalls === undefined
      ? {}
      : {
          toolCalls: message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
          })),
        }),
  };
}

function compactionContext(
  state: SessionState,
  retainedMessages: readonly ModelMessage[],
  maxBytes: number,
): string {
  const retainedIds = new Set(retainedMessages.map((message) => message.id));
  const metadataItemBytes = Math.max(
    32,
    Math.min(MAX_METADATA_ITEM_BYTES, Math.floor(maxBytes / 256)),
  );
  const metadataTextBytes = Math.max(
    256,
    Math.min(MAX_METADATA_TEXT_BYTES, Math.floor(maxBytes / 16)),
  );
  const messageBytes = Math.max(
    256,
    Math.min(MAX_COMPACTION_MESSAGE_BYTES, Math.floor(maxBytes / 2)),
  );
  const earlierMessages = state.messages.filter((message) =>
    !retainedIds.has(message.id)
  );
  const goal = state.goal === null
    ? null
    : {
        ...state.goal,
        objective: boundedText(state.goal.objective, metadataTextBytes),
        progress: boundedText(state.goal.progress, metadataTextBytes),
        blockers: boundedItems(state.goal.blockers, metadataItemBytes),
        evidence: boundedItems(state.goal.evidence, metadataItemBytes),
      };
  const base = {
    task: "Summarize the earlier conversation for a coding agent that will continue later.",
    requiredSections: [
      "goal and progress",
      "decisions and constraints",
      "files changed",
      "verification evidence",
      "open blockers and next steps",
    ],
    goal,
    changedFiles: boundedItems(state.changedFiles, metadataItemBytes),
    evidence: boundedItems(state.evidence, metadataItemBytes),
    blockers: boundedItems(state.goal?.blockers ?? [], metadataItemBytes),
    previousSummary: state.summary === null
      ? null
      : boundedText(state.summary, metadataTextBytes),
  };
  let selected: Record<string, unknown>[] = [];
  let truncatedMessages = 0;
  for (
    let index = earlierMessages.length - 1;
    index >= 0 && selected.length < MAX_COMPACTION_MESSAGES;
    index -= 1
  ) {
    const projected = projectedMessage(earlierMessages[index]!, messageBytes);
    const candidateTruncatedMessages = truncatedMessages +
      (projected.content === earlierMessages[index]!.content ? 0 : 1);
    const candidate = [projected, ...selected];
    const serialized = JSON.stringify({
      ...base,
      omittedEarlierMessages: earlierMessages.length - candidate.length,
      truncatedEarlierMessages: candidateTruncatedMessages,
      earlierMessages: candidate,
    });
    if (byteLength(serialized) > maxBytes) break;
    selected = candidate;
    truncatedMessages = candidateTruncatedMessages;
  }
  const serialized = JSON.stringify({
    ...base,
    omittedEarlierMessages: earlierMessages.length - selected.length,
    truncatedEarlierMessages: truncatedMessages,
    earlierMessages: selected,
  });
  if (byteLength(serialized) > maxBytes) {
    throw new ProviderError(
      "invalid_response",
      "Compaction context metadata exceeds its safety limit",
      false,
    );
  }
  return serialized;
}

export async function compactSession(
  state: SessionState,
  provider: ModelProvider,
  signal: AbortSignal,
  options: { readonly maxContextBytes?: number } = {},
): Promise<CompactionResult> {
  try {
    if (signal.aborted) {
      throw new ProviderError("cancelled", "Compaction cancelled", false);
    }
    const retainedMessages = retainedContinuation(state.messages, 6);
    const maxContextBytes = Math.min(
      options.maxContextBytes ?? MAX_COMPACTION_CONTEXT_BYTES,
      MAX_COMPACTION_CONTEXT_BYTES,
    );
    if (!Number.isSafeInteger(maxContextBytes) || maxContextBytes <= 0) {
      throw new ProviderError(
        "invalid_response",
        "Compaction context safety limit is invalid",
        false,
      );
    }
    const request: ProviderRequest = {
      model: state.model,
      messages: [
        {
          id: randomUUID(),
          role: "system",
          content:
            "Produce a concise, factual continuation summary. Do not request tools and do not claim unverified work.",
        },
        {
          id: randomUUID(),
          role: "user",
          content: compactionContext(state, retainedMessages, maxContextBytes),
        },
      ],
      tools: [],
      signal,
    };
    const collected = await collectProviderEvents(provider.stream(request));
    if (
      collected.stopReason !== "complete" ||
      collected.toolCalls.length > 0 ||
      collected.text.trim().length === 0
    ) {
      throw new ProviderError(
        "invalid_response",
        "Compaction provider did not return a final text summary",
        false,
      );
    }
    return {
      summary: collected.text.trim(),
      retainedMessages,
      usage: collected.usageReported ? collected.usage : null,
      usageSource: collected.usageReported ? "provider" : "unavailable",
    };
  } catch (error) {
    if (error instanceof ProviderError) {
      throw new ProviderError(
        error.code,
        safeProviderErrorMessage(error),
        error.retryable,
      );
    }
    const code = signal.aborted ? "cancelled" : "transport";
    throw new ProviderError(code, safeProviderErrorMessage(code), false);
  }
}

function compactionFailureCode(code: ProviderErrorCode): IntegrationFailure["code"] {
  switch (code) {
    case "authentication":
      return "authentication_failed";
    case "rate_limit":
      return "rate_limited";
    case "context_overflow":
      return "context_overflow";
    case "transport":
      return "transport";
    case "cancelled":
      return "cancelled";
    case "invalid_response":
      return "invalid_response";
  }
}

function compactionFailure(
  error: ProviderError,
  diagnosticId: string,
): IntegrationFailure {
  return {
    domain: "provider",
    phase: "started",
    code: compactionFailureCode(error.code),
    safeMessage: safeProviderErrorMessage(error),
    diagnosticId,
    retryable: error.retryable,
  };
}

export async function compactPinnedSession(
  input: DurableCompactionInput,
): Promise<PinnedSessionState> {
  const operationId = randomUUID();
  const inputBaseSequence = input.state.lastSequence;
  let state = input.state;
  await input.sessions.withSessionMutation(
    state.id,
    inputBaseSequence,
    async (lease) => {
      const started = await lease.append({
        type: "compaction_started",
        operationId,
        inputBaseSequence,
        at: input.at,
      });
      state = reduceSessionRecordV2(state, started);

      let compacted: CompactionResult;
      try {
        const verifiedLimits = input.state.backend.pin.modelLimitsAtCreation;
        compacted = await compactSession(
          input.state,
          input.provider,
          input.signal,
          verifiedLimits === undefined
            ? {}
            : {
                maxContextBytes: Math.max(
                  1,
                  Math.min(
                    Math.floor(verifiedLimits.maxInputTokens * 0.8),
                    verifiedLimits.maxInputTokens -
                      compactionOutputReserve(verifiedLimits) -
                      AUTO_COMPACTION_GROWTH_HEADROOM_TOKENS,
                  ),
                ),
              },
        );
      } catch (error) {
        const safeError = error instanceof ProviderError
          ? error
          : new ProviderError("transport", safeProviderErrorMessage("transport"), false);
        const failed = await lease.append({
          type: "compaction_failed",
          operationId,
          at: input.at,
          error: compactionFailure(safeError, randomUUID()),
          usage: null,
          usageSource: "unknown",
        });
        state = reduceSessionRecordV2(state, failed);
        throw safeError;
      }

      const retainedTurnIds = [
        ...new Set(compacted.retainedMessages.flatMap((message) => {
          const turnId = input.state.messageTurnIds[message.id];
          return turnId === undefined ? [] : [turnId];
        })),
      ];
      const completed = await lease.append({
        type: "session_compacted",
        operationId,
        inputBaseSequence,
        baseSequence: inputBaseSequence,
        at: input.at,
        summary: compacted.summary,
        retainedTurnIds,
        usage: compacted.usage,
        usageSource: compacted.usageSource,
      });
      state = reduceSessionRecordV2(state, completed);
    },
  );
  return state;
}
