import type { ModelReasoningEffort } from "@recurs/contracts";

/**
 * Reviewed against the official OpenAI model pages on 2026-07-20:
 * https://developers.openai.com/api/docs/models/gpt-5.6-luna
 * https://developers.openai.com/api/docs/models/gpt-5.6-sol
 * https://developers.openai.com/api/docs/models/gpt-5.6-terra
 * https://developers.openai.com/api/docs/guides/latest-model
 */
export const OPENAI_RESPONSES_CAPABILITY_PROFILE_REVISION =
  "openai-responses-tools-2026-07-13-v1";

export const OPENAI_RESPONSES_EXACT_MODEL_IDS = Object.freeze([
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
] as const);

const exactModelIds = new Set<string>(OPENAI_RESPONSES_EXACT_MODEL_IDS);

export const OPENAI_RESPONSES_REASONING_EFFORTS: readonly ModelReasoningEffort[] =
  Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]);

export function isCompatibleOpenAIResponsesModelId(modelId: string): boolean {
  return exactModelIds.has(modelId);
}

export function compatibleOpenAIResponsesModelIds(
  visibleIds: readonly string[],
): readonly string[] {
  return Object.freeze(
    [...new Set(visibleIds)]
      .filter(isCompatibleOpenAIResponsesModelId)
      .sort((left, right) =>
        Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
      ),
  );
}

export function openAIResponsesReasoningEfforts(
  modelId: string,
): readonly ModelReasoningEffort[] {
  return isCompatibleOpenAIResponsesModelId(modelId)
    ? OPENAI_RESPONSES_REASONING_EFFORTS
    : Object.freeze([]);
}
