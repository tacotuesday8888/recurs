import type { Checkpoint, CheckpointStore } from "@recurs/tools";
import { ToolError } from "@recurs/tools";

import {
  projectTeamRunActivityEvent,
  type RecursEvent,
} from "./events.js";
import type {
  GitPatchArtifactHandle,
  GitPatchArtifactManager,
} from "./git-patch-artifacts.js";
import type { GitWorktreeLeaseManager } from "./git-worktree-leases.js";
import type {
  JsonlTeamRunStore,
  TeamRunListEntry,
} from "./jsonl-team-run-store.js";
import { SessionStoreError } from "./session-store-error.js";
import type {
  DurableTeamChildRecoveryInput,
} from "./team-child-recovery.js";
import type {
  TeamRunOwnerLease,
  TeamRunOwnerLeaseManager,
} from "./team-run-owner-lease.js";
import type {
  CheckpointRef,
  TeamRunChildRecord,
  TeamRunRecordInput,
  TeamRunState,
} from "./team-run-state.js";

const SAFE_RECOVERY_FAILURE_MESSAGES: Readonly<Record<string, string>> =
  Object.freeze({
    cancelled: "Team recovery was cancelled",
    checkpoint_conflict: "Team recovery checkpoint verification failed",
    checkpoint_corrupt: "Team recovery checkpoint verification failed",
    checkpoint_migration_required: "Team recovery checkpoint verification failed",
    checkpoint_not_found: "Team recovery checkpoint verification failed",
    checkpoint_storage: "Team recovery checkpoint verification failed",
    corrupt_log: "Team recovery session data is invalid",
    external_path: "Team recovery safety validation failed",
    invalid_record: "Team recovery session data is invalid",
    invalid_session_id: "Team recovery session data is invalid",
    legacy_read_only: "Team recovery session data is invalid",
    not_found: "Team recovery data was not found",
    permission_denied: "Team recovery safety validation failed",
    process_failed: "Team recovery process failed",
    sensitive_file: "Team recovery safety validation failed",
    session_busy: "Team recovery session is busy",
    session_conflict: "Team recovery session is busy",
    session_mismatch: "Team recovery session data is invalid",
    session_not_found: "Team recovery session data was not found",
    unsupported_version: "Team recovery session data is invalid",
  });

export interface TeamRunRecoveryDependencies {
  readonly runs: Pick<JsonlTeamRunStore, "list" | "load" | "append">;
  readonly owners: Pick<TeamRunOwnerLeaseManager, "tryAcquire">;
  readonly worktrees: Pick<GitWorktreeLeaseManager, "recoverStale">;
  readonly patches: Pick<
    GitPatchArtifactManager,
    "inspectCandidateWorkspace" | "completeCandidateApply" | "discard"
  >;
  readonly checkpoints: Pick<CheckpointStore, "complete">;
  readonly recoverChild: (
    input: DurableTeamChildRecoveryInput,
  ) => Promise<TeamRunChildRecord>;
  readonly emit: (event: RecursEvent) => Promise<void>;
  readonly now?: () => string;
}

export interface TeamRunRecoveryFailure {
  readonly runId: string;
  readonly code: string;
  readonly message: string;
}

export interface TeamRunRecoverySummary {
  readonly inspectedRunIds: readonly string[];
  readonly recoveredRunIds: readonly string[];
  readonly readyRunIds: readonly string[];
  readonly busyRunIds: readonly string[];
  readonly manualAttentionRunIds: readonly string[];
  readonly failures: readonly TeamRunRecoveryFailure[];
}

type RecoveryDisposition =
  | "unchanged"
  | "recovered"
  | "ready"
  | "manual_attention";

type WithoutRecoveryTime<T> = T extends TeamRunRecordInput ? Omit<T, "at"> : never;
type RecoveryRecordInput = WithoutRecoveryTime<TeamRunRecordInput>;

function terminal(state: TeamRunState): boolean {
  return state.status === "approved" || state.status === "changes_requested" ||
    state.status === "unverified" || state.status === "failed" ||
    state.status === "cancelled";
}

function safeFailure(error: unknown): Omit<TeamRunRecoveryFailure, "runId"> {
  const rawCode = error instanceof ToolError || error instanceof SessionStoreError
    ? error.code
    : "recovery_failed";
  const code = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(rawCode)
    ? rawCode
    : "recovery_failed";
  return {
    code,
    message: SAFE_RECOVERY_FAILURE_MESSAGES[code] ??
      "Durable team recovery failed",
  };
}

function checkpointReference(checkpoint: Checkpoint): CheckpointRef {
  return {
    id: checkpoint.id,
    sessionId: checkpoint.sessionId,
    toolCallId: checkpoint.toolCallId,
  };
}

function uniqueArtifacts(state: TeamRunState): readonly GitPatchArtifactHandle[] {
  const byId = new Map<string, GitPatchArtifactHandle>();
  for (const link of state.artifacts) byId.set(link.handle.id, link.handle);
  if (state.candidate !== null) {
    byId.set(state.candidate.artifact.id, state.candidate.artifact);
  }
  return Object.freeze([...byId.values()]);
}

function obsoleteReadyArtifacts(state: TeamRunState): readonly GitPatchArtifactHandle[] {
  const candidateId = state.candidate?.artifact.id;
  return Object.freeze(uniqueArtifacts(state).filter((artifact) =>
    artifact.id !== candidateId
  ));
}

class RecoveryJournal {
  constructor(
    private current: TeamRunState,
    private readonly lease: TeamRunOwnerLease,
    private readonly dependencies: TeamRunRecoveryDependencies,
    private readonly recoveryAt: (state: TeamRunState) => string,
  ) {}

  get state(): TeamRunState {
    return this.current;
  }

  async append(input: RecoveryRecordInput): Promise<TeamRunState> {
    await this.lease.assertOwned();
    this.current = await this.dependencies.runs.append(
      this.current.descriptor.id,
      this.current.lastSequence,
      { ...input, at: this.recoveryAt(this.current) } as TeamRunRecordInput,
    );
    try {
      await this.dependencies.emit(projectTeamRunActivityEvent(this.current));
    } catch {
      // The durable journal remains authoritative when presentation fails.
    }
    return this.current;
  }
}

export class TeamRunRecoveryCoordinator {
  readonly #now: () => string;

  constructor(private readonly dependencies: TeamRunRecoveryDependencies) {
    this.#now = dependencies.now ?? (() => new Date().toISOString());
  }

  #at(state: TeamRunState): string {
    const requested = this.#now();
    const parsed = Date.parse(requested);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== requested) {
      throw new ToolError("invalid_input", "Team recovery time is invalid");
    }
    return Date.parse(state.updatedAt) > parsed ? state.updatedAt : requested;
  }

  async #discard(handles: readonly GitPatchArtifactHandle[]): Promise<void> {
    if (handles.length > 0) await this.dependencies.patches.discard(handles);
  }

  async #warn(
    item: TeamRunListEntry,
    failure: Omit<TeamRunRecoveryFailure, "runId">,
  ): Promise<void> {
    try {
      await this.dependencies.emit({
        type: "warning",
        sessionId: item.parentSessionId,
        at: this.#now(),
        code: `team_recovery_${failure.code}`,
        message: `Team run ${item.id}: ${failure.message}`,
      });
    } catch {
      // Recovery warnings are presentation only; the journal remains authoritative.
    }
  }

  async #recoverChild(
    state: TeamRunState,
    reservation: TeamRunState["children"][number]["reservation"],
  ): Promise<TeamRunChildRecord> {
    try {
      return await this.dependencies.recoverChild({
        descriptor: state.descriptor,
        reservation: {
          attemptId: reservation.attemptId,
          role: reservation.role,
          index: reservation.index,
          round: reservation.round,
          childAgentId: reservation.childAgentId,
          childSessionId: reservation.childSessionId,
          requestAllowance: reservation.requestAllowance,
        },
        at: this.#at(state),
      });
    } catch (error) {
      const missing = error instanceof SessionStoreError &&
        error.code === "session_not_found";
      const invalid = error instanceof ToolError &&
        error.code === "permission_denied";
      if (!missing && !invalid) throw error;
      return {
        attemptId: reservation.attemptId,
        status: "failed",
        requestsUsed: missing ? 0 : reservation.requestAllowance,
        usage: null,
        usageSource: "unavailable",
        changedFiles: [],
        evidence: [],
        failure: {
          code: missing ? "missing_child_session" : "invalid_child_state",
          message: missing
            ? "The reserved child session was not created before the process ended"
            : "The recovered child did not match its durable reservation",
        },
      };
    }
  }

  async #settleChildren(journal: RecoveryJournal): Promise<void> {
    for (const child of journal.state.children) {
      if (child.result !== null) continue;
      const recovered = await this.#recoverChild(journal.state, child.reservation);
      await journal.append({ type: "child_finished", child: recovered });
    }
  }

  async #reconcileApply(journal: RecoveryJournal): Promise<RecoveryDisposition> {
    const state = journal.state;
    const candidate = state.candidate?.artifact;
    if (candidate === undefined) {
      if (state.status === "applying") {
        await journal.append({
          type: "run_interrupted",
          reason: "The interrupted apply is missing its reviewed candidate",
          manualAttentionRequired: true,
        });
      }
      return "manual_attention";
    }
    const base = {
      repositoryRoot: state.descriptor.repositoryRoot,
      revision: state.descriptor.baseRevision,
    };
    const workspace = await this.dependencies.patches.inspectCandidateWorkspace({
      base,
      artifact: candidate,
      signal: new AbortController().signal,
    });
    if (workspace === "clean_base") {
      await journal.append({ type: "apply_reset", reason: "clean_base" });
      await this.#discard(obsoleteReadyArtifacts(journal.state));
      return "ready";
    }
    if (workspace === "exact_candidate" && state.apply !== null) {
      const completed = await this.dependencies.checkpoints.complete(
        state.apply.checkpoint,
        state.descriptor.repositoryRoot,
      );
      const prepared: Checkpoint = {
        id: completed.id,
        sessionId: completed.sessionId,
        toolCallId: completed.toolCallId,
        before: completed.before,
      };
      const verified = await this.dependencies.patches.completeCandidateApply({
        base,
        artifact: candidate,
        checkpoint: prepared,
        checkpoints: this.dependencies.checkpoints,
        signal: new AbortController().signal,
      });
      await journal.append({
        type: "apply_committed",
        checkpoint: checkpointReference(verified.checkpoint),
        changedFiles: verified.changedFiles,
      });
      await this.#discard(uniqueArtifacts(journal.state));
      return "recovered";
    }
    if (state.status === "applying") {
      await journal.append({
        type: "run_interrupted",
        reason: workspace === "exact_candidate"
          ? "The exact candidate is present without a durable prepared checkpoint"
          : "The parent workspace does not match the clean base or reviewed candidate",
        manualAttentionRequired: true,
      });
    }
    return "manual_attention";
  }

  async #recoverOwned(
    initial: TeamRunState,
    lease: TeamRunOwnerLease,
  ): Promise<RecoveryDisposition> {
    await lease.assertOwned();
    const current = await this.dependencies.runs.load(initial.descriptor.id);
    const journal = new RecoveryJournal(
      current,
      lease,
      this.dependencies,
      (state) => this.#at(state),
    );
    if (terminal(journal.state)) {
      await this.dependencies.worktrees.recoverStale({
        repositoryRoot: journal.state.descriptor.repositoryRoot,
      });
      await this.#discard(uniqueArtifacts(journal.state));
      return "unchanged";
    }
    if (journal.state.status === "ready_to_apply" &&
      journal.state.cancellation === null) {
      await this.dependencies.worktrees.recoverStale({
        repositoryRoot: journal.state.descriptor.repositoryRoot,
      });
      await this.#discard(obsoleteReadyArtifacts(journal.state));
      return "ready";
    }

    await this.#settleChildren(journal);
    await lease.assertOwned();
    await this.dependencies.worktrees.recoverStale({
      repositoryRoot: journal.state.descriptor.repositoryRoot,
    });

    if (journal.state.status === "ready_to_apply") {
      if (journal.state.cancellation === null) return "ready";
      const reason = journal.state.cancellation.reason;
      await journal.append({
        type: "run_terminal",
        status: "cancelled",
        outcome: {
          changedFiles: [],
          evidence: [],
          failure: { code: "cancelled", message: reason },
        },
      });
      await this.#discard(uniqueArtifacts(journal.state));
      return "recovered";
    }
    if (journal.state.phase === "apply" &&
      (journal.state.status === "applying" || journal.state.status === "interrupted")) {
      return await this.#reconcileApply(journal);
    }
    if (journal.state.status === "created" || journal.state.status === "running") {
      if (journal.state.cancellation !== null) {
        const reason = journal.state.cancellation.reason;
        await journal.append({
          type: "run_terminal",
          status: "cancelled",
          outcome: {
            changedFiles: [],
            evidence: [],
            failure: { code: "cancelled", message: reason },
          },
        });
      } else {
        await journal.append({
          type: "run_interrupted",
          reason: "The owning process ended before the team reached a stable boundary",
          manualAttentionRequired: false,
        });
      }
      await this.#discard(uniqueArtifacts(journal.state));
      return "recovered";
    }
    if (journal.state.status === "interrupted") {
      await this.#discard(uniqueArtifacts(journal.state));
    }
    return journal.state.interruption?.manualAttentionRequired === true
      ? "manual_attention"
      : "unchanged";
  }

  async #markRecoveryFailure(
    runId: string,
    lease: TeamRunOwnerLease,
    failure: Omit<TeamRunRecoveryFailure, "runId">,
  ): Promise<boolean> {
    try {
      await lease.assertOwned();
      const state = await this.dependencies.runs.load(runId);
      if (state.interruption?.manualAttentionRequired === true) return true;
      if (terminal(state) || state.status === "ready_to_apply" ||
        state.status === "interrupted") return false;
      const journal = new RecoveryJournal(
        state,
        lease,
        this.dependencies,
        (current) => this.#at(current),
      );
      await journal.append({
        type: "run_interrupted",
        reason: failure.message,
        manualAttentionRequired: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  async recover(): Promise<TeamRunRecoverySummary> {
    const listed = [...await this.dependencies.runs.list()]
      .sort((left: TeamRunListEntry, right: TeamRunListEntry) =>
        left.id.localeCompare(right.id)
      );
    const inspectedRunIds: string[] = [];
    const recoveredRunIds: string[] = [];
    const readyRunIds: string[] = [];
    const busyRunIds: string[] = [];
    const manualAttentionRunIds: string[] = [];
    const failures: TeamRunRecoveryFailure[] = [];
    for (const item of listed) {
      inspectedRunIds.push(item.id);
      let initial: TeamRunState;
      try {
        initial = await this.dependencies.runs.load(item.id);
        const ownership = await this.dependencies.owners.tryAcquire(
          initial.descriptor.id,
          initial.descriptor.parentSessionId,
        );
        if (ownership.status === "busy") {
          busyRunIds.push(item.id);
          continue;
        }
        try {
          try {
            const disposition = await this.#recoverOwned(initial, ownership.lease);
            if (disposition === "recovered") recoveredRunIds.push(item.id);
            else if (disposition === "ready") readyRunIds.push(item.id);
            else if (disposition === "manual_attention") {
              manualAttentionRunIds.push(item.id);
            }
          } catch (error) {
            const failure = safeFailure(error);
            failures.push({ runId: item.id, ...failure });
            await this.#warn(item, failure);
            if (await this.#markRecoveryFailure(
              item.id,
              ownership.lease,
              failure,
            )) {
              manualAttentionRunIds.push(item.id);
            }
          }
        } finally {
          await ownership.lease.release();
        }
      } catch (error) {
        const failure = safeFailure(error);
        failures.push({ runId: item.id, ...failure });
        await this.#warn(item, failure);
      }
    }
    return Object.freeze({
      inspectedRunIds: Object.freeze(inspectedRunIds),
      recoveredRunIds: Object.freeze(recoveredRunIds),
      readyRunIds: Object.freeze(readyRunIds),
      busyRunIds: Object.freeze(busyRunIds),
      manualAttentionRunIds: Object.freeze(manualAttentionRunIds),
      failures: Object.freeze(failures.map((failure) => Object.freeze(failure))),
    });
  }
}
