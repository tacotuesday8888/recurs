import { randomUUID } from "node:crypto";

import {
  ProviderError,
  collectProviderEvents,
  safeProviderErrorMessage,
  type ModelMessage,
  type ModelProvider,
  type ProviderRequest,
} from "@recurs/providers";

import type { SessionState } from "./session.js";

export interface CompactionResult {
  summary: string;
  retainedMessages: ModelMessage[];
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

function compactionContext(
  state: SessionState,
  retainedMessages: readonly ModelMessage[],
): string {
  const retainedIds = new Set(retainedMessages.map((message) => message.id));
  return JSON.stringify({
    task: "Summarize the earlier conversation for a coding agent that will continue later.",
    requiredSections: [
      "goal and progress",
      "decisions and constraints",
      "files changed",
      "verification evidence",
      "open blockers and next steps",
    ],
    goal: state.goal,
    changedFiles: state.changedFiles,
    evidence: state.evidence,
    blockers: state.goal?.blockers ?? [],
    previousSummary: state.summary,
    earlierMessages: state.messages.filter((message) => !retainedIds.has(message.id)),
  });
}

export async function compactSession(
  state: SessionState,
  provider: ModelProvider,
  signal: AbortSignal,
): Promise<CompactionResult> {
  try {
    if (signal.aborted) {
      throw new ProviderError("cancelled", "Compaction cancelled", false);
    }
    const retainedMessages = retainedContinuation(state.messages, 6);
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
          content: compactionContext(state, retainedMessages),
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
    return { summary: collected.text.trim(), retainedMessages };
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
