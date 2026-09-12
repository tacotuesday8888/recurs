import { describe, expect, it } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";

import {
  AcpUpdateError,
  translateAcpUpdate,
  type AcpUpdateTranslationState,
} from "../src/acp-updates.js";

function state(): AcpUpdateTranslationState {
  return {
    sessionId: "session",
    cwd: "/workspace",
    expectedModeId: null,
    expectedConfigOptions: [],
    emitFileEvents: true,
    activities: new Map(),
  };
}

function notification(update: SessionNotification["update"]): SessionNotification {
  return { sessionId: "session", update };
}

describe("translateAcpUpdate", () => {
  it("streams agent text and reasoning as deltas", () => {
    expect(translateAcpUpdate(notification({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    }), state())).toEqual([{ type: "text_delta", text: "hello" }]);
    expect(translateAcpUpdate(notification({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "thinking" },
    }), state())).toEqual([{ type: "reasoning_delta", text: "thinking" }]);
  });

  it("keeps vendor-internal compaction updates out of the durable record", () => {
    const translation = state();
    expect(translateAcpUpdate(notification({
      sessionUpdate: "compaction_update",
      compactionId: "compaction-1",
      status: "in_progress",
    }), translation)).toEqual([]);
    expect(translateAcpUpdate(notification({
      sessionUpdate: "compaction_summary_chunk",
      compactionId: "compaction-1",
      content: { type: "text", text: "Earlier context was summarized." },
    }), translation)).toEqual([]);
    expect(translateAcpUpdate(notification({
      sessionUpdate: "compaction_update",
      compactionId: "compaction-1",
      status: "completed",
    }), translation)).toEqual([]);
    expect(translation.activities.size).toBe(0);
  });

  it("rejects updates addressed to another session", () => {
    expect(() => translateAcpUpdate({
      sessionId: "other",
      update: { sessionUpdate: "usage_update", used: 1, size: 2 },
    }, state())).toThrow(AcpUpdateError);
  });
});
