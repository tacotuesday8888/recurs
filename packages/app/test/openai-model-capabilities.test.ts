import { describe, expect, it } from "vitest";

import {
  OPENAI_RESPONSES_CAPABILITY_PROFILE_REVISION,
  OPENAI_RESPONSES_EXACT_MODEL_IDS,
  compatibleOpenAIResponsesModelIds,
  isCompatibleOpenAIResponsesModelId,
} from "../src/openai-model-capabilities.js";

describe("OpenAI Responses capability profile", () => {
  it("publishes the reviewed exact model IDs as an immutable profile", () => {
    expect(OPENAI_RESPONSES_CAPABILITY_PROFILE_REVISION).toBe(
      "openai-responses-tools-2026-07-13-v1",
    );
    expect(OPENAI_RESPONSES_EXACT_MODEL_IDS).toEqual([
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    expect(Object.isFrozen(OPENAI_RESPONSES_EXACT_MODEL_IDS)).toBe(true);
  });

  it("returns only visible reviewed IDs once, in deterministic byte order", () => {
    const compatibleIds = compatibleOpenAIResponsesModelIds([
      "gpt-5.6",
      "gpt-5.6-terra",
      "unreviewed-model",
      "gpt-5.6-sol",
      "gpt-5.6-sol",
    ]);

    expect(compatibleIds).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
    expect(Object.isFrozen(compatibleIds)).toBe(true);
  });

  it.each([
    "gpt-5.6",
    " gpt-5.6-sol",
    "gpt-5.6-sol ",
    "gpt-5.6-sol\n",
    "gpt-5.6-sol\u0000",
    "gpt-5.6-sol-preview",
    "prefix-gpt-5.6-sol",
  ])("rejects aliases and non-exact model ID %j", (modelId) => {
    expect(isCompatibleOpenAIResponsesModelId(modelId)).toBe(false);
  });

  it("accepts every exact reviewed model ID", () => {
    for (const modelId of OPENAI_RESPONSES_EXACT_MODEL_IDS) {
      expect(isCompatibleOpenAIResponsesModelId(modelId)).toBe(true);
    }
  });
});
