import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  deriveTrustedRunContext,
  modelImagesByteLength,
  type AgentRuntime,
  type BackendResolver,
  type ConnectionBoundModelProvider,
  type CoordinatedRun,
  type CoordinatedRunInput,
  type IntegrationFailure,
  type ModelImageInput,
  type ModelProvider,
  type ResolvedBackend,
  type RunAuthorization,
  type RunCoordinator,
  type RunResult,
  type RuntimeContinuationAuthority,
  type RuntimeContinuationHandle,
  type QueuedTurnSource,
  type SessionBackendPin,
  type TrustedRunContext,
  type TurnSteeringSource,
} from "@recurs/contracts";
import { safeProviderErrorMessage } from "@recurs/providers";

import type {
  JsonlSessionStore,
  SessionMutationLease,
} from "./jsonl-session-store.js";
import {
  AgentLoopError,
  safeAgentLoopErrorMessage,
  unexpectedFailureMessage,
} from "./agent-loop.js";
import {
  BackendAuthorizationError,
  verifyRunAuthorization,
} from "./backend-authorization.js";
import { SessionStoreError } from "./jsonl-session-store.js";
import { restoredRuntimePredecessor } from "./runtime-continuation-lifecycle.js";
import { isPinnedSessionState, type PinnedSessionState } from "./session-v2.js";

export interface DirectRunExecutorInput {
  session: PinnedSessionState;
  turnId: string;
  prompt: string;
  images?: readonly ModelImageInput[];
  executionMode: "act" | "plan";
  provider: ModelProvider;
  authorization: RunAuthorization;
  context: TrustedRunContext;
  steering?: TurnSteeringSource;
  queuedTurns?: QueuedTurnSource;
  queuedInputId?: string;
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
  context: TrustedRunContext;
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
  continuationAuthority?: RuntimeContinuationAuthority;
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

function policyFailure(
  code: IntegrationFailure["code"],
  safeMessage: string,
  diagnosticId: string,
): IntegrationFailure {
  return {
    domain: "policy",
    phase: "preflight",
    code,
    safeMessage,
    diagnosticId,
    retryable: false,
  };
}

function runtimeFailure(
  code: IntegrationFailure["code"],
  safeMessage: string,
  diagnosticId: string,
): IntegrationFailure {
  return {
    domain: "runtime",
    phase: "preflight",
    code,
    safeMessage,
    diagnosticId,
    retryable: false,
  };
}

type RuntimePin = SessionBackendPin & {
  readonly kind: "agent_runtime";
  readonly runtimeCapabilityProfileRevisionAtCreation: string;
};

function isRuntimePin(pin: SessionBackendPin): pin is RuntimePin {
  return pin.kind === "agent_runtime" &&
    typeof pin.runtimeCapabilityProfileRevisionAtCreation === "string" &&
    pin.runtimeCapabilityProfileRevisionAtCreation.length > 0;
}

function committedVersion(
  uncertain: RuntimeContinuationHandle,
  committed: RuntimeContinuationHandle,
): boolean {
  return uncertain.status === "uncertain" && committed.status === "committed" &&
    isDeepStrictEqual({ ...uncertain, status: "committed" }, committed);
}

function startedFailure(
  error: unknown,
  signal: AbortSignal,
  diagnosticId: string,
): IntegrationFailure {
  const cancelled = signal.aborted ||
    (isObject(error) && error.code === "cancelled");
  const agentLoopError = error instanceof AgentLoopError ? error : null;
  const contextOverflow = !cancelled &&
    agentLoopError?.code === "context_overflow";
  const providerFailureCode: IntegrationFailure["code"] | null = cancelled
    ? "cancelled"
    : contextOverflow
    ? "context_overflow"
    : agentLoopError?.code === "invalid_provider_response"
    ? "invalid_response"
    : agentLoopError?.code === "provider_failed"
    ? agentLoopError.message === safeProviderErrorMessage("authentication")
      ? "authentication_failed"
      : agentLoopError.message === safeProviderErrorMessage("rate_limit")
      ? "rate_limited"
      : "transport"
    : null;
  const safeMessage = cancelled
    ? agentLoopError === null
      ? "The run was cancelled"
      : safeAgentLoopErrorMessage(agentLoopError)
    : agentLoopError === null
      ? unexpectedFailureMessage(diagnosticId)
      : safeAgentLoopErrorMessage(agentLoopError);
  return {
    domain: providerFailureCode === null ? "runtime" : "provider",
    phase: "started",
    code: providerFailureCode ?? "runtime_failed",
    safeMessage,
    diagnosticId,
    retryable: isObject(error) && error.retryable === true,
    ...(providerFailureCode === "authentication_failed"
      ? { action: "reauthenticate" as const }
      : providerFailureCode === "rate_limited"
      ? { action: "wait" as const }
      : {}),
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

type ReconciledSession =
  | { readonly ok: true; readonly session: PinnedSessionState }
  | { readonly ok: false; readonly failure: IntegrationFailure };

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

  #currentTime(): Date {
    const value = new Date(this.#now());
    if (!Number.isFinite(value.getTime())) {
      throw new TypeError("The coordinator clock is invalid");
    }
    return value;
  }

  #throwIfPreflightAborted(
    signal: AbortSignal,
    diagnosticId: string,
  ): void {
    if (signal.aborted) {
      throw {
        domain: "provider",
        phase: "preflight",
        code: "cancelled",
        safeMessage: "The run was cancelled before it started",
        diagnosticId,
        retryable: false,
      } satisfies IntegrationFailure;
    }
  }

  #validateResolution(
    resolved: ResolvedBackend,
    input: {
      readonly session: PinnedSessionState;
      readonly operation: "run" | "runtime_reconcile";
      readonly operationId: string;
      readonly turnId: string | null;
      readonly context: TrustedRunContext;
    },
  ): IntegrationFailure | null {
    const pin = input.session.backend.pin;
    if (!isDeepStrictEqual(resolved.pin, pin)) {
      return failure(
        "session_conflict",
        "The resolved backend does not match the immutable session pin",
        input.operationId,
      );
    }
    const expectedKind = pin.kind === "model_provider" ? "direct" : "delegated";
    if (resolved.kind !== expectedKind) {
      return failure(
        "connection_invalid",
        "The resolved backend lane does not match the immutable session pin",
        input.operationId,
      );
    }
    try {
      verifyRunAuthorization(resolved.authorization, {
        id: resolved.authorization.id,
        operation: input.operation,
        sessionId: input.session.id,
        operationId: input.operationId,
        turnId: input.turnId,
        pin,
        connectionRevision: resolved.authorization.connectionRevision,
        policyRevision: pin.policyRevisionAtCreation,
        context: input.context,
        maxRequests: resolved.authorization.maxRequests,
        expiresAt: resolved.authorization.expiresAt,
      }, this.#currentTime());
    } catch (error) {
      const code = error instanceof BackendAuthorizationError
        ? error.code
        : "authorization_invalid";
      return policyFailure(
        "authorization_denied",
        code === "authorization_expired"
          ? "The backend authorization expired before this operation"
          : "The backend authorization does not match this operation",
        input.operationId,
      );
    }
    return null;
  }

  #runtimeIdentityFailure(
    runtime: AgentRuntime,
    pin: RuntimePin,
    diagnosticId: string,
  ): IntegrationFailure | null {
    return runtime.adapterId === pin.adapterId &&
        runtime.connectionId === pin.connectionId &&
        runtime.capabilityProfileRevision ===
          pin.runtimeCapabilityProfileRevisionAtCreation
      ? null
      : failure(
          "connection_invalid",
          "The delegated runtime does not match the immutable session pin",
          diagnosticId,
        );
  }

  #providerIdentityFailure(
    provider: ConnectionBoundModelProvider,
    pin: SessionBackendPin,
    diagnosticId: string,
  ): IntegrationFailure | null {
    return provider.id === pin.providerId &&
        provider.adapterId === pin.adapterId &&
        provider.connectionId === pin.connectionId
      ? null
      : failure(
          "connection_invalid",
          "The direct provider does not match the immutable session pin",
          diagnosticId,
        );
  }

  async #reconcileRuntimeContinuation(input: {
    readonly session: PinnedSessionState;
    readonly mutation: SessionMutationLease;
    readonly context: TrustedRunContext;
    readonly signal: AbortSignal;
  }): Promise<ReconciledSession> {
    const uncertain = input.session.runtimeContinuation;
    if (uncertain === null || uncertain.status !== "uncertain") {
      return { ok: true, session: input.session };
    }
    const operationId = this.#createId();
    const pin = input.session.backend.pin;
    const authority = this.dependencies.continuationAuthority;
    if (!isRuntimePin(pin) || this.dependencies.delegated === undefined ||
      authority === undefined) {
      return {
        ok: false,
        failure: failure(
          "adapter_unavailable",
          "The uncertain delegated continuation cannot be reconciled",
          operationId,
        ),
      };
    }
    this.#throwIfPreflightAborted(input.signal, operationId);
    const resolved = await this.dependencies.resolver.resolve({
      operation: "runtime_reconcile",
      operationId,
      sessionId: input.session.id,
      turnId: null,
      pin,
      context: input.context,
      signal: input.signal,
    });
    this.#throwIfPreflightAborted(input.signal, operationId);
    const resolutionFailure = this.#validateResolution(resolved, {
      session: input.session,
      operation: "runtime_reconcile",
      operationId,
      turnId: null,
      context: input.context,
    });
    if (resolutionFailure !== null) {
      return { ok: false, failure: resolutionFailure };
    }
    if (resolved.kind !== "delegated" ||
      resolved.authorization.operation !== "runtime_reconcile" ||
      resolved.authorization.turnId !== null) {
      return {
        ok: false,
        failure: policyFailure(
          "authorization_denied",
          "The reconciliation authorization is invalid",
          operationId,
        ),
      };
    }
    const authorization = resolved.authorization as RunAuthorization & {
      readonly operation: "runtime_reconcile";
      readonly turnId: null;
    };
    this.#throwIfPreflightAborted(input.signal, operationId);
    const runtime = await resolved.createRuntime(input.signal);
    this.#throwIfPreflightAborted(input.signal, operationId);
    const identityFailure = this.#runtimeIdentityFailure(runtime, pin, operationId);
    if (identityFailure !== null) {
      return { ok: false, failure: identityFailure };
    }
    this.#throwIfPreflightAborted(input.signal, operationId);
    const reader = await authority.mintReader({
      authorization,
      pin,
      expectedSessionRecordSequence: input.mutation.currentSequence,
      purpose: "reconcile",
      activeHandles: [uncertain],
    });
    let outcome: "committed" | "uncertain" | "gone";
    try {
      this.#throwIfPreflightAborted(input.signal, operationId);
      outcome = await runtime.reconcile({
        continuation: uncertain,
        reader,
        authorization,
        expectedSessionRecordSequence: input.mutation.currentSequence,
        signal: input.signal,
      });
      this.#throwIfPreflightAborted(input.signal, operationId);
    } finally {
      try {
        await authority.release(reader);
      } catch {
        // Capability expiry is the final cleanup fallback.
      }
    }
    this.#throwIfPreflightAborted(input.signal, operationId);
    if (outcome === "uncertain") {
      return {
        ok: false,
        failure: runtimeFailure(
          "continuation_uncertain",
          "The delegated continuation is still uncertain",
          operationId,
        ),
      };
    }
    let finalization: Awaited<ReturnType<
      RuntimeContinuationAuthority["prepareFinalization"]
    >>;
    if (outcome === "committed" || outcome === "gone") {
      finalization = await authority.prepareFinalization({
        authorization,
        handle: uncertain,
        outcome,
        expectedSessionRecordSequence: input.mutation.currentSequence,
      });
      if (
        outcome === "committed" &&
        (finalization.activeHandle === null ||
          !committedVersion(uncertain, finalization.activeHandle))
      ) {
        return {
          ok: false,
          failure: runtimeFailure(
            "continuation_incompatible",
            "The continuation store returned an invalid reconciliation result",
            operationId,
          ),
        };
      }
      if (
        outcome === "gone" &&
        !isDeepStrictEqual(
          finalization.activeHandle,
          restoredRuntimePredecessor(
            input.session.runtimeContinuationPredecessor,
            uncertain,
          ),
        )
      ) {
        return {
          ok: false,
          failure: runtimeFailure(
            "continuation_incompatible",
            "The continuation store returned an invalid reconciliation result",
            operationId,
          ),
        };
      }
    } else {
      return {
        ok: false,
        failure: runtimeFailure(
          "continuation_incompatible",
          "The delegated runtime returned an invalid reconciliation result",
          operationId,
        ),
      };
    }
    const activeHandle = finalization.activeHandle;
    this.#throwIfPreflightAborted(input.signal, operationId);
    const reconciliationRecord = await input.mutation.append({
      type: "runtime_continuation_reconciled",
      operationId,
      uncertainHandle: uncertain,
      outcome,
      activeHandle,
      at: this.#now(),
    });
    try {
      await authority.acknowledgeFinalization({
        authorization,
        receipt: finalization.receipt,
        durableSessionRecordSequence: reconciliationRecord.sequence,
      });
    } catch {
      // A prepared active view remains valid from the durable next sequence.
    }
    this.#throwIfPreflightAborted(input.signal, operationId);
    const reloaded = await this.dependencies.sessions.loadState(input.session.id);
    this.#throwIfPreflightAborted(input.signal, operationId);
    if (!isPinnedSessionState(reloaded) ||
      reloaded.lastSequence !== input.mutation.currentSequence ||
      reloaded.runtimeContinuation?.status === "uncertain") {
      return {
        ok: false,
        failure: failure(
          "session_conflict",
          "The reconciled session could not be reloaded safely",
          operationId,
        ),
      };
    }
    return { ok: true, session: reloaded };
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
    if (
      input.images !== undefined &&
      modelImagesByteLength(input.images) === null
    ) {
      return {
        ok: false,
        failure: failure(
          "connection_invalid",
          "Image input is invalid or exceeds the Recurs limit",
          operationId,
        ),
      } as const;
    }
    const liveTurnIds = [input.steering?.turnId, input.queuedTurns?.turnId]
      .filter((id): id is string => id !== undefined);
    if (new Set(liveTurnIds).size > 1) {
      return {
        ok: false,
        failure: failure(
          "connection_invalid",
          "Live-input mailboxes do not identify the same active turn",
          operationId,
        ),
      } as const;
    }
    const turnId = liveTurnIds[0] ?? this.#createId();
    let executionStarted = false;
    try {
      return await this.dependencies.sessions.withSessionMutation(
        input.sessionId,
        input.expectedSessionRecordSequence,
        async (mutation) => {
          const loadedSession = await this.dependencies.sessions.loadState(
            input.sessionId,
          );
          this.#throwIfPreflightAborted(input.signal, operationId);
          if (!isPinnedSessionState(loadedSession)) {
            return {
              ok: false,
              failure: failure(
                "continuation_incompatible",
                "Legacy sessions are read-only; create a pinned session to continue",
                operationId,
              ),
            } as const;
          }
          if (
            (input.queuedTurns !== undefined || input.queuedInputId !== undefined) &&
            (loadedSession.backend.pin.kind !== "model_provider" ||
              loadedSession.agent.role !== "parent")
          ) {
            return {
              ok: false,
              failure: failure(
                "connection_invalid",
                "Queued turns require a direct-provider parent session",
                operationId,
              ),
            } as const;
          }
          if (input.queuedInputId !== undefined) {
            const queued = loadedSession.queuedTurns[0];
            if (
              queued?.id !== input.queuedInputId || queued.prompt !== prompt
            ) {
              return {
                ok: false,
                failure: failure(
                  "session_conflict",
                  "The queued turn does not match the durable FIFO head",
                  operationId,
                ),
              } as const;
            }
          }
          const context = deriveTrustedRunContext(input.invocation);
          this.#throwIfPreflightAborted(input.signal, operationId);
          const reconciled = await this.#reconcileRuntimeContinuation({
            session: loadedSession,
            mutation,
            context,
            signal: input.signal,
          });
          this.#throwIfPreflightAborted(input.signal, operationId);
          if (!reconciled.ok) {
            return { ok: false, failure: reconciled.failure } as const;
          }
          const session = reconciled.session;
          this.#throwIfPreflightAborted(input.signal, operationId);
          const resolved = await this.dependencies.resolver.resolve({
            operation: "run",
            operationId,
            sessionId: input.sessionId,
            turnId,
            pin: session.backend.pin,
            context,
            signal: input.signal,
          });
          this.#throwIfPreflightAborted(input.signal, operationId);
          const resolutionFailure = this.#validateResolution(resolved, {
            session,
            operation: "run",
            operationId,
            turnId,
            context,
          });
          if (resolutionFailure !== null) {
            return { ok: false, failure: resolutionFailure } as const;
          }
          if (resolved.kind === "direct") {
            const directPin = session.backend.pin;
            if (directPin.kind !== "model_provider") {
              return {
                ok: false,
                failure: failure(
                  "connection_invalid",
                  "The direct provider pin is invalid",
                  operationId,
                ),
              } as const;
            }
            this.#throwIfPreflightAborted(input.signal, operationId);
            const provider = await resolved.createProvider(input.signal);
            this.#throwIfPreflightAborted(input.signal, operationId);
            const identityFailure = this.#providerIdentityFailure(
              provider,
              directPin,
              operationId,
            );
            if (identityFailure !== null) {
              return { ok: false, failure: identityFailure } as const;
            }
            if (
              input.images !== undefined &&
              !provider.inputModalities?.includes("image")
            ) {
              return {
                ok: false,
                failure: failure(
                  "model_incompatible",
                  "The selected provider adapter does not support image input",
                  operationId,
                ),
              } as const;
            }
            executionStarted = true;
            const result = await this.dependencies.direct.run({
              session,
              turnId,
              prompt,
              ...(input.images === undefined ? {} : { images: input.images }),
              executionMode: input.executionMode ?? session.executionMode,
              provider,
              authorization: resolved.authorization,
              context,
              ...(input.steering === undefined ? {} : { steering: input.steering }),
              ...(input.queuedTurns === undefined
                ? {}
                : { queuedTurns: input.queuedTurns }),
              ...(input.queuedInputId === undefined
                ? {}
                : { queuedInputId: input.queuedInputId }),
              mutation,
              signal: input.signal,
            });
            return { ok: true, result } as const;
          }
          if (input.images !== undefined) {
            return {
              ok: false,
              failure: runtimeFailure(
                "runtime_capability_missing",
                "The selected delegated runtime does not support Recurs image input",
                operationId,
              ),
            } as const;
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
          const runtimePin = session.backend.pin;
          if (!isRuntimePin(runtimePin)) {
            return {
              ok: false,
              failure: failure(
                "connection_invalid",
                "The delegated runtime pin is invalid",
                operationId,
              ),
            } as const;
          }
          this.#throwIfPreflightAborted(input.signal, operationId);
          const runtime = await resolved.createRuntime(input.signal);
          this.#throwIfPreflightAborted(input.signal, operationId);
          const identityFailure = this.#runtimeIdentityFailure(
            runtime,
            runtimePin,
            operationId,
          );
          if (identityFailure !== null) {
            return { ok: false, failure: identityFailure } as const;
          }
          this.#throwIfPreflightAborted(input.signal, operationId);
          executionStarted = true;
          const result = await this.dependencies.delegated.run({
            session,
            turnId,
            prompt,
            executionMode: input.executionMode ?? session.executionMode,
            runtime,
            authorization: resolved.authorization,
            context,
            mutation,
            signal: input.signal,
          });
          return { ok: true, result } as const;
        },
      );
    } catch (error) {
      if (!executionStarted && input.signal.aborted) {
        return {
          ok: false,
          failure: {
            domain: "provider",
            phase: "preflight",
            code: "cancelled",
            safeMessage: "The run was cancelled before it started",
            diagnosticId: operationId,
            retryable: false,
          },
        } as const;
      }
      if (isIntegrationFailure(error)) {
        return {
          ok: false,
          failure: executionStarted || error.phase === "preflight"
            ? error
            : { ...error, phase: "preflight" as const },
        } as const;
      }
      if (error instanceof SessionStoreError) {
        if (executionStarted) {
          return {
            ok: false,
            failure: {
              domain: "storage",
              phase: "started",
              code: "session_conflict",
              safeMessage: error.message,
              diagnosticId: operationId,
              retryable: false,
            },
          } as const;
        }
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
      if (executionStarted) {
        return {
          ok: false,
          failure: startedFailure(error, input.signal, operationId),
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
