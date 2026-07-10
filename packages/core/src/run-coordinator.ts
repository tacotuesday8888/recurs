import { randomUUID } from "node:crypto";

import {
  deriveTrustedRunContext,
  type AgentRuntime,
  type BackendResolver,
  type CoordinatedRun,
  type CoordinatedRunInput,
  type IntegrationFailure,
  type ModelProvider,
  type RunAuthorization,
  type RunCoordinator,
  type RunResult,
} from "@recurs/contracts";

import type {
  JsonlSessionStore,
  SessionMutationLease,
} from "./jsonl-session-store.js";
import { SessionStoreError } from "./jsonl-session-store.js";
import { isPinnedSessionState, type PinnedSessionState } from "./session-v2.js";

export interface DirectRunExecutorInput {
  session: PinnedSessionState;
  turnId: string;
  prompt: string;
  executionMode: "act" | "plan";
  provider: ModelProvider;
  authorization: RunAuthorization;
  mutation: SessionMutationLease;
  signal: AbortSignal;
}

export interface DirectRunExecutor {
  run(input: DirectRunExecutorInput): Promise<RunResult>;
}

export interface DelegatedRunExecutorInput {
  session: PinnedSessionState;
  turnId: string;
  prompt: string;
  executionMode: "act" | "plan";
  runtime: AgentRuntime;
  authorization: RunAuthorization;
  mutation: SessionMutationLease;
  signal: AbortSignal;
}

export interface DelegatedRunExecutor {
  run(input: DelegatedRunExecutorInput): Promise<RunResult>;
}

export interface BackendRunCoordinatorDependencies {
  sessions: JsonlSessionStore;
  resolver: BackendResolver;
  direct: DirectRunExecutor;
  delegated?: DelegatedRunExecutor;
  now?: () => string;
  createId?: () => string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegrationFailure(value: unknown): value is IntegrationFailure {
  return isObject(value) &&
    typeof value.domain === "string" &&
    (value.phase === "preflight" || value.phase === "started") &&
    typeof value.code === "string" &&
    typeof value.safeMessage === "string" &&
    typeof value.diagnosticId === "string" &&
    typeof value.retryable === "boolean";
}

function failure(
  code: IntegrationFailure["code"],
  safeMessage: string,
  diagnosticId: string,
): IntegrationFailure {
  return {
    domain: "connection",
    phase: "preflight",
    code,
    safeMessage,
    diagnosticId,
    retryable: false,
  };
}

function noEvents(): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<never>> {
          return { done: true, value: undefined as never };
        },
      };
    },
  };
}

export class BackendRunCoordinator implements RunCoordinator {
  readonly #now: () => string;
  readonly #createId: () => string;

  constructor(private readonly dependencies: BackendRunCoordinatorDependencies) {
    this.#now = dependencies.now ?? (() => new Date().toISOString());
    this.#createId = dependencies.createId ?? randomUUID;
  }

  async start(input: CoordinatedRunInput): Promise<CoordinatedRun> {
    const outcome = this.#start(input);
    return { events: noEvents(), outcome };
  }

  async #start(input: CoordinatedRunInput) {
    if (input.signal.aborted) {
      return {
        ok: false,
        failure: {
          domain: "provider",
          phase: "preflight",
          code: "cancelled",
          safeMessage: "The run was cancelled before it started",
          diagnosticId: this.#createId(),
          retryable: false,
        },
      } as const;
    }
    const prompt = input.prompt.trim();
    if (prompt.length === 0) {
      return {
        ok: false,
        failure: failure(
          "connection_invalid",
          "A prompt is required",
          this.#createId(),
        ),
      } as const;
    }
    const operationId = this.#createId();
    const turnId = this.#createId();
    try {
      return await this.dependencies.sessions.withSessionMutation(
        input.sessionId,
        input.expectedSessionRecordSequence,
        async (mutation) => {
          const session = await this.dependencies.sessions.loadState(
            input.sessionId,
          );
          if (!isPinnedSessionState(session)) {
            return {
              ok: false,
              failure: failure(
                "continuation_incompatible",
                "Legacy sessions are read-only; create a pinned session to continue",
                operationId,
              ),
            } as const;
          }
          const context = deriveTrustedRunContext(input.invocation);
          const resolved = await this.dependencies.resolver.resolve({
            operation: "run",
            operationId,
            sessionId: input.sessionId,
            turnId,
            pin: session.backend.pin,
            context,
            signal: input.signal,
          });
          if (
            JSON.stringify(resolved.pin) !== JSON.stringify(session.backend.pin)
          ) {
            return {
              ok: false,
              failure: failure(
                "session_conflict",
                "The resolved backend does not match the immutable session pin",
                operationId,
              ),
            } as const;
          }
          if (resolved.kind === "direct") {
            const provider = await resolved.createProvider(input.signal);
            const result = await this.dependencies.direct.run({
              session,
              turnId,
              prompt,
              executionMode: input.executionMode ?? session.executionMode,
              provider,
              authorization: resolved.authorization,
              mutation,
              signal: input.signal,
            });
            return { ok: true, result } as const;
          }
          if (this.dependencies.delegated === undefined) {
            return {
              ok: false,
              failure: failure(
                "adapter_unavailable",
                "The delegated runtime executor is unavailable",
                operationId,
              ),
            } as const;
          }
          const runtime = await resolved.createRuntime(input.signal);
          const result = await this.dependencies.delegated.run({
            session,
            turnId,
            prompt,
            executionMode: input.executionMode ?? session.executionMode,
            runtime,
            authorization: resolved.authorization,
            mutation,
            signal: input.signal,
          });
          return { ok: true, result } as const;
        },
      );
    } catch (error) {
      if (isIntegrationFailure(error)) {
        return { ok: false, failure: error } as const;
      }
      if (error instanceof SessionStoreError) {
        return {
          ok: false,
          failure: failure(
            error.code === "legacy_read_only"
              ? "continuation_incompatible"
              : "session_conflict",
            error.message,
            operationId,
          ),
        } as const;
      }
      return {
        ok: false,
        failure: {
          domain: "connection",
          phase: "preflight",
          code: "connection_invalid",
          safeMessage: "The selected backend could not be prepared",
          diagnosticId: `${operationId}:${this.#now()}`,
          retryable: false,
        },
      } as const;
    }
  }
}
