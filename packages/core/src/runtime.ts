import type {
  ExecutionMode,
} from "@recurs/tools";

import type {
  HostInvocation,
  IntegrationFailure,
  RunCoordinator,
  RunResult,
} from "@recurs/contracts";

import type { JsonlSessionStore } from "./jsonl-session-store.js";
import type { SessionState } from "./session.js";

export class CoordinatedRunError extends Error {
  constructor(public readonly failure: IntegrationFailure) {
    super(failure.safeMessage);
    this.name = "CoordinatedRunError";
  }
}

export interface CoordinatedRuntimeDependencies {
  sessions: JsonlSessionStore;
  coordinator: RunCoordinator;
  emit?: (event: unknown) => void | Promise<void>;
}

export class CoordinatedRuntime {
  #active = false;

  constructor(
    private readonly dependencies: CoordinatedRuntimeDependencies,
    public session: SessionState,
  ) {}

  replaceSession(session: SessionState): void {
    if (this.#active) {
      throw new Error("Cannot replace a session during an active run");
    }
    this.session = session;
  }

  async run(
    prompt: string,
    invocation: HostInvocation,
    signal: AbortSignal,
    executionMode?: ExecutionMode,
  ): Promise<RunResult> {
    if (this.#active) {
      throw new Error("An agent run is already active");
    }
    const normalized = prompt.trim();
    if (normalized.length === 0) {
      throw new Error("A prompt is required");
    }
    this.#active = true;
    try {
      const run = await this.dependencies.coordinator.start({
        sessionId: this.session.id,
        expectedSessionRecordSequence: this.session.lastSequence ?? 0,
        prompt: normalized,
        invocation,
        ...(executionMode === undefined ? {} : { executionMode }),
        signal,
      });
      const drain = (async () => {
        for await (const event of run.events) {
          await this.dependencies.emit?.(event);
        }
      })();
      const [outcome] = await Promise.all([run.outcome, drain]);
      try {
        this.session = await this.dependencies.sessions.loadState(this.session.id);
      } catch {
        // Preserve the coordinator outcome if session recovery fails.
      }
      if (!outcome.ok) {
        throw new CoordinatedRunError(outcome.failure);
      }
      return outcome.result;
    } finally {
      this.#active = false;
    }
  }
}
