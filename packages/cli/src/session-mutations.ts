import { randomUUID } from "node:crypto";

import {
  SessionStoreError,
  isPinnedSessionState,
  reduceSessionRecordV2,
  type JsonlSessionStore,
  type SessionRecord,
  type SessionState,
} from "@recurs/core";

export async function applyCommandSessionRecord(
  sessions: JsonlSessionStore,
  initial: SessionState,
  record: SessionRecord,
): Promise<SessionState> {
  if (!isPinnedSessionState(initial)) {
    throw new SessionStoreError(
      "legacy_read_only",
      `Legacy session ${initial.id} is read-only`,
    );
  }
  let state = initial;
  await sessions.withSessionMutation(
    state.id,
    state.lastSequence,
    async (lease) => {
      if (record.type === "goal_updated") {
        const persisted = await lease.append({
          type: "goal_updated",
          source: "command",
          at: record.at,
          goal: record.goal,
        });
        state = reduceSessionRecordV2(state, persisted);
      } else if (record.type === "mode_updated") {
        const persisted = await lease.append({
          type: "mode_updated",
          source: "command",
          at: record.at,
          executionMode: record.executionMode,
          permissionMode: record.permissionMode,
          ...(record.prePlanPermissionMode === undefined
            ? {}
            : { prePlanPermissionMode: record.prePlanPermissionMode }),
        });
        state = reduceSessionRecordV2(state, persisted);
      } else if (record.type === "session_compacted") {
        const operationId = randomUUID();
        const inputBaseSequence = state.lastSequence;
        const started = await lease.append({
          type: "compaction_started",
          operationId,
          inputBaseSequence,
          at: record.at,
        });
        state = reduceSessionRecordV2(state, started);
        const retainedTurnIds = [
          ...new Set(
            record.retainedMessages.flatMap((message) => {
              const turnId = state.messageTurnIds[message.id];
              return turnId === undefined ? [] : [turnId];
            }),
          ),
        ];
        const completed = await lease.append({
          type: "session_compacted",
          operationId,
          inputBaseSequence,
          baseSequence: inputBaseSequence,
          at: record.at,
          summary: record.summary,
          retainedTurnIds,
          usage: null,
          usageSource: "unavailable",
        });
        state = reduceSessionRecordV2(state, completed);
      } else {
        throw new TypeError(
          `${record.type} is not a command-owned session mutation`,
        );
      }
    },
  );
  return state;
}
