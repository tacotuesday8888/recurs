import { describe, expect, it } from "vitest";

import {
  COMPATIBLE_TOOL_USE_PROFILE,
  NATIVE_TOOL_USE_PROFILE,
  harnessProfileForAdapter,
} from "../src/index.js";

describe("model harness profiles", () => {
  it("uses stable, versioned, protocol-level identities", () => {
    expect(harnessProfileForAdapter("openai-responses"))
      .toBe(NATIVE_TOOL_USE_PROFILE);
    expect(harnessProfileForAdapter("anthropic-messages"))
      .toBe(NATIVE_TOOL_USE_PROFILE);
    expect(harnessProfileForAdapter("openai-chat-completions"))
      .toBe(COMPATIBLE_TOOL_USE_PROFILE);
    expect(NATIVE_TOOL_USE_PROFILE.id).not.toMatch(/openai|anthropic|kimi/u);
    expect(COMPATIBLE_TOOL_USE_PROFILE.id).not.toMatch(/openai|anthropic|kimi/u);
  });

  it("publishes immutable instructions", () => {
    expect(Object.isFrozen(NATIVE_TOOL_USE_PROFILE)).toBe(true);
    expect(Object.isFrozen(NATIVE_TOOL_USE_PROFILE.instructions)).toBe(true);
  });
});
