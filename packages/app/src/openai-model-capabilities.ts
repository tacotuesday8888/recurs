/**
 * Reviewed against the official OpenAI model pages on 2026-07-13:
 * https://developers.openai.com/api/docs/models/gpt-5.6-luna
 * https://developers.openai.com/api/docs/models/gpt-5.6-sol
 * https://developers.openai.com/api/docs/models/gpt-5.6-terra
 */
export const OPENAI_RESPONSES_CAPABILITY_PROFILE_REVISION =
  "openai-responses-tools-2026-07-13-v1";

export const OPENAI_RESPONSES_EXACT_MODEL_IDS = Object.freeze([
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
] as const);

const exactModelIds = new Set<string>(OPENAI_RESPONSES_EXACT_MODEL_IDS);

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
