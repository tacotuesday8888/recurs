import type { ModelHarnessProfile } from "@recurs/contracts";

function profile(
  input: ModelHarnessProfile,
): ModelHarnessProfile {
  return Object.freeze({
    ...input,
    instructions: Object.freeze([...input.instructions]),
  });
}

export const NATIVE_TOOL_USE_PROFILE_V1 = profile({
  id: "native_tool_use_v1",
  version: 1,
  toolCallStyle: "native",
  instructions: [
    "Use the supplied native tools when workspace evidence or changes are required.",
    "Tool arguments must satisfy the supplied schema exactly; never invent unavailable tools.",
    "After tool results, continue until the user's request has a truthful terminal answer.",
  ],
});

export const NATIVE_TOOL_USE_PROFILE = profile({
  id: "native_tool_use_v2",
  version: 2,
  toolCallStyle: "native",
  instructions: [
    "Use the supplied native tools when workspace evidence or changes are required.",
    "Tool arguments must satisfy the supplied schema exactly; never invent unavailable tools.",
    "You may group up to four independent read-only tool calls; keep dependent calls and all mutations ordered.",
    "After tool results, continue until the user's request has a truthful terminal answer.",
  ],
});

export const COMPATIBLE_TOOL_USE_PROFILE = profile({
  id: "compatible_tool_use_v1",
  version: 1,
  toolCallStyle: "conservative",
  instructions: [
    "Use at most one supplied tool call at a time and wait for its result before choosing the next action.",
    "Emit tool arguments as one complete JSON object matching the supplied schema exactly.",
    "Never describe a tool action as completed unless the host returned a successful result.",
  ],
});

export type HarnessAdapterId =
  | "openai-responses"
  | "anthropic-messages"
  | "openai-chat-completions";

export function harnessProfileForAdapter(
  adapterId: HarnessAdapterId,
): ModelHarnessProfile {
  return adapterId === "openai-chat-completions"
    ? COMPATIBLE_TOOL_USE_PROFILE
    : NATIVE_TOOL_USE_PROFILE;
}
