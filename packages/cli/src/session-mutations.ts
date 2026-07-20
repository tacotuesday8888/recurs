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
      } else if (record.type === "agent_policy_updated") {
        const persisted = await lease.append({
          type: "agent_policy_updated",
          at: record.at,
          operatingModeId: record.operatingModeId,
          operatingModeVersion: record.operatingModeVersion,
        });
        state = reduceSessionRecordV2(state, persisted);
      } else {
        throw new TypeError(
          `${record.type} is not a command-owned session mutation`,
        );
      }
    },
  );
  return state;
}
