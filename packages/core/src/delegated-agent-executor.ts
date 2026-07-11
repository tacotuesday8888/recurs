import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentRuntimeHost,
  ContinuationReadCapability,
  ContinuationWriteCapability,
  IntegrationFailure,
  ProviderUsage,
  RunResult,
  RuntimeActivity,
  RuntimeApprovalDecision,
  RuntimeApprovalRequest,
  RuntimeCapabilities,
  RuntimeContinuationAuthority,
  RuntimeContinuationHandle,
  SessionBackendPin,
  ToolCall,
} from "@recurs/contracts";
import {
  PermissionEngine,
  ToolError,
  type ApprovalHandler,
  type ToolContext,
  type ToolRegistry,
  type ToolResult,
} from "@recurs/tools";

import {
  BackendAuthorizationError,
  createBackendFingerprint,
  verifyRunAuthorization,
} from "./backend-authorization.js";
import {
  cancelledResolution,
  exactPolicyResolution,
  runtimeGrantKey,
  runtimePermissionIntent,
  validHandlerResolution,
  type RuntimeApprovalHandlerResult,
  type RuntimeApprovalResolution,
} from "./delegated-agent-approval.js";
import {
  addUniqueBounded,
  addUsage,
  boundedMetadataStrings,
  boundedNonEmptyString,
  boundedString,
  committedVersion,
  deepFreeze,
  exactKeys,
  isObject,
  preflightFailure,
  resolveLimits,
  RuntimeProtocolError,
  safeToolFailure,
  snapshotCapabilities,
  startedFailure,
  utf8Bytes,
  validRuntimeApprovalRequest,
  validRuntimeFailure,
  validToolCall,
  validToolResult,
  validUsage,
  type DelegatedAgentExecutorLimits,
  type HostArtifacts,
} from "./delegated-agent-validation.js";
import type { RecursEvent } from "./events.js";
import type {
  DelegatedRunExecutor,
  DelegatedRunExecutorInput,
} from "./run-coordinator.js";
import type { SessionState } from "./session.js";

export type { RuntimeApprovalHandlerResult } from "./delegated-agent-approval.js";
export type { DelegatedAgentExecutorLimits } from "./delegated-agent-validation.js";

export interface ExactRuntimeApprovalHandler {
  request(request: RuntimeApprovalRequest): Promise<RuntimeApprovalHandlerResult>;
}

export interface DelegatedAgentExecutorDependencies {
  readonly continuationAuthority: RuntimeContinuationAuthority;
  readonly tools: ToolRegistry;
  readonly approvals: ApprovalHandler;
  readonly runtimeApprovals: ExactRuntimeApprovalHandler;
  emit(event: RecursEvent): Promise<void>;
  createToolContext(state: SessionState, signal: AbortSignal): ToolContext;
  readonly now?: () => Date;
  readonly createDiagnosticId?: () => string;
  readonly limits?: Partial<DelegatedAgentExecutorLimits>;
}

interface TerminalDone {
  readonly kind: "done";
  readonly finalText: string;
  readonly stopReason: "complete" | "length";
  readonly continuation?: RuntimeContinuationHandle;
}

interface TerminalCancelled {
  readonly kind: "cancelled";
  readonly reason: string;
  readonly continuation?: RuntimeContinuationHandle;
}

interface TerminalFailed {
  readonly kind: "failed";
  readonly failure: IntegrationFailure;
  readonly continuation?: RuntimeContinuationHandle;
}

type RuntimeTerminal = TerminalDone | TerminalCancelled | TerminalFailed;

const approvalAborted = Symbol("approval-aborted");

async function raceAgainstAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof approvalAborted> {
  if (signal.aborted) {
    return approvalAborted;
  }
  return await new Promise<T | typeof approvalAborted>((resolve, reject) => {
    let settled = false;
    const finish = (result: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      result();
    };
    const onAbort = (): void => finish(() => resolve(approvalAborted));
    signal.addEventListener("abort", onAbort, { once: true });
    const pending: Promise<T | typeof approvalAborted> = (async () =>
      signal.aborted ? approvalAborted : await operation()
    )();
    void pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

class SerialQueue {
  #tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async drain(): Promise<void> {
    await this.#tail;
  }
}

export class DelegatedAgentExecutor implements DelegatedRunExecutor {
  readonly #now: () => Date;
  readonly #createDiagnosticId: () => string;
  readonly #limits: Readonly<DelegatedAgentExecutorLimits>;
  readonly #permissions = new Map<string, PermissionEngine>();
  readonly #runtimeApprovalGrants = new Map<string, Set<string>>();

  constructor(private readonly dependencies: DelegatedAgentExecutorDependencies) {
    this.#now = dependencies.now ?? (() => new Date());
    this.#createDiagnosticId = dependencies.createDiagnosticId ?? randomUUID;
    this.#limits = resolveLimits(dependencies.limits);
  }

  async run(input: DelegatedRunExecutorInput): Promise<RunResult> {
    const diagnosticId = this.#createDiagnosticId();
    let reader: ContinuationReadCapability | null = null;
    let writer: ContinuationWriteCapability | null = null;
    let started = false;
    let closed = false;
    let uncertain: RuntimeContinuationHandle | null = null;
    const queue = new SerialQueue();

    try {
      const capabilities = this.#preflight(input, diagnosticId);
      const pin = input.session.backend.pin as SessionBackendPinRuntime;
      const expectedSequence = input.mutation.currentSequence;
      const previous = input.session.runtimeContinuation;
      if (previous !== null) {
        reader = await this.dependencies.continuationAuthority.mintReader({
          authorization: input.authorization,
          pin,
          expectedSessionRecordSequence: expectedSequence,
          purpose: "run",
          activeHandles: [previous],
        });
      }
      writer = await this.dependencies.continuationAuthority.mintWriter({
        authorization: input.authorization,
        pin,
        expectedSessionRecordSequence: expectedSequence,
        previous,
        stateVersion: 1,
      });
      this.#assertRuntimeStable(
        input.runtime,
        capabilities,
        pin.runtimeCapabilityProfileRevisionAtCreation,
      );

      const startedRecord = await queue.run(() => input.mutation.append({
        type: "turn_started",
        at: this.#timestamp(),
        turnId: input.turnId,
        prompt: input.prompt,
      }));
      started = true;
      await this.#emitPresentation({
        type: "turn_started",
        sessionId: startedRecord.sessionId,
        at: startedRecord.at,
        turnId: input.turnId,
        prompt: input.prompt,
      });
      this.#throwIfAborted(input.signal, diagnosticId);

      let terminal: RuntimeTerminal | null = null;
      let protocolInvalid = false;
      let eventCount = 0;
      let textBytes = 0;
      let reasoningBytes = 0;
      let usage: ProviderUsage | null = null;
      const changedFiles: string[] = [];
      const evidence: string[] = [];
      const activityIds = new Set<string>();
      const approvalRequestIds = new Set<string>();
      const toolCallIds = new Set<string>();
      let runtimeFileEventSeen = false;
      let runtimeEvidenceSeen = false;
      let continuationEvents = 0;
      let callbackFailure: unknown = null;

      let permissionEngine = this.#permissions.get(input.session.id);
      if (permissionEngine === undefined) {
        permissionEngine = new PermissionEngine(input.session.permissionMode);
        this.#permissions.set(input.session.id, permissionEngine);
      } else {
        permissionEngine.mode = input.session.permissionMode;
      }
      const executionState = input.executionMode === input.session.executionMode
        ? input.session
        : { ...input.session, executionMode: input.executionMode };
      const toolContext = this.dependencies.createToolContext(
        executionState,
        input.signal,
      );
      const hostArtifacts: HostArtifacts = {
        changedFiles,
        evidence,
        changedFilesContributed: false,
        evidenceContributed: false,
      };
      const requestApproval = (rawRequest: RuntimeApprovalRequest) => {
        const pending = queue.run(async () => {
          this.#assertRuntimeStable(
            input.runtime,
            capabilities,
            pin.runtimeCapabilityProfileRevisionAtCreation,
          );
          if (terminal !== null) {
            throw new RuntimeProtocolError();
          }
          return this.#resolveRuntimeApproval(
            rawRequest,
            input,
            permissionEngine,
            approvalRequestIds,
          );
        });
        void pending.catch((error: unknown) => {
          callbackFailure ??= error;
        });
        return pending;
      };
      const hostBase: AgentRuntimeHost = capabilities.approvalControl === "none"
        ? {}
        : { requestApproval };
      const host: AgentRuntimeHost = capabilities.toolExecution === "host_tools"
        ? Object.freeze({
            ...hostBase,
            executeTool: (rawCall: ToolCall, runtimeSignal: AbortSignal) => {
              const pending = queue.run(async () => {
                this.#assertRuntimeStable(
                  input.runtime,
                  capabilities,
                  pin.runtimeCapabilityProfileRevisionAtCreation,
                );
                if (terminal !== null) {
                  throw new RuntimeProtocolError();
                }
                return this.#executeHostTool(
                  rawCall,
                  runtimeSignal,
                  input,
                  permissionEngine,
                  toolContext,
                  toolCallIds,
                  hostArtifacts,
                  diagnosticId,
                );
              });
              void pending.catch((error: unknown) => {
                callbackFailure ??= error;
              });
              return pending;
            },
          })
        : Object.freeze(hostBase);

      const request: AgentRunRequest = Object.freeze({
        sessionId: input.session.id,
        turnId: input.turnId,
        prompt: input.prompt,
        cwd: input.session.cwd,
        modelId: pin.modelId,
        executionMode: input.executionMode,
        permissionMode: input.session.permissionMode,
        authorization: input.authorization,
        continuationReader: reader,
        continuationWriter: writer,
        continuation: previous,
        signal: input.signal,
      });

      let iteratorError: unknown = null;
      try {
        const iterable = input.runtime.run(request, host);
        const iterator = iterable[Symbol.asyncIterator]();
        for (;;) {
          let step: IteratorResult<AgentRuntimeEvent>;
          try {
            step = await iterator.next();
          } catch (error) {
            iteratorError = error;
            break;
          }
          if (step.done) {
            break;
          }
          eventCount += 1;
          if (eventCount > this.#limits.maxEvents) {
            protocolInvalid = true;
            try {
              await iterator.return?.();
            } catch {
              // The bounded protocol failure is already authoritative.
            }
            break;
          }
          let raw: unknown;
          try {
            raw = structuredClone(step.value);
          } catch {
            protocolInvalid = true;
            continue;
          }
          await queue.run(async () => {
            try {
              this.#assertRuntimeStable(
                input.runtime,
                capabilities,
                pin.runtimeCapabilityProfileRevisionAtCreation,
              );
              if (!isObject(raw) || typeof raw.type !== "string") {
                protocolInvalid = true;
                return;
              }
              if (terminal !== null) {
                protocolInvalid = true;
                return;
              }
              switch (raw.type) {
                case "text_delta": {
                  if (!exactKeys(raw, ["type", "text"]) ||
                    !boundedString(raw.text, this.#limits.maxTextBytes)) {
                    protocolInvalid = true;
                    return;
                  }
                  textBytes += utf8Bytes(raw.text);
                  if (textBytes > this.#limits.maxTextBytes) {
                    protocolInvalid = true;
                    return;
                  }
                  await this.#emitPresentation({
                    type: "model_text_delta",
                    sessionId: input.session.id,
                    turnId: input.turnId,
                    at: this.#timestamp(),
                    text: raw.text,
                  });
                  return;
                }
                case "reasoning_delta": {
                  if (!exactKeys(raw, ["type", "text"]) ||
                    !boundedString(raw.text, this.#limits.maxReasoningBytes)) {
                    protocolInvalid = true;
                    return;
                  }
                  reasoningBytes += utf8Bytes(raw.text);
                  if (reasoningBytes > this.#limits.maxReasoningBytes) {
                    protocolInvalid = true;
                    return;
                  }
                  await this.#emitPresentation({
                    type: "model_reasoning_delta",
                    sessionId: input.session.id,
                    turnId: input.turnId,
                    at: this.#timestamp(),
                    text: raw.text,
                  });
                  return;
                }
                case "usage":
                  if (!capabilities.usageEvents ||
                    !exactKeys(raw, ["type", "usage"]) ||
                    !validUsage(raw.usage)) {
                    protocolInvalid = true;
                    return;
                  }
                  try {
                    usage = addUsage(usage, raw.usage);
                  } catch {
                    protocolInvalid = true;
                  }
                  return;
                case "files_changed":
                  if (!capabilities.fileEvents ||
                    !exactKeys(raw, ["type", "paths"]) ||
                    !Array.isArray(raw.paths) ||
                    !addUniqueBounded(changedFiles, raw.paths, this.#limits)) {
                    protocolInvalid = true;
                    return;
                  }
                  runtimeFileEventSeen ||= raw.paths.length > 0;
                  return;
                case "evidence":
                  if (!exactKeys(raw, ["type", "items"]) ||
                    !Array.isArray(raw.items) ||
                    !addUniqueBounded(evidence, raw.items, this.#limits)) {
                    protocolInvalid = true;
                    return;
                  }
                  runtimeEvidenceSeen ||= raw.items.length > 0;
                  return;
                case "activity": {
                  if (!exactKeys(raw, ["type", "activity"]) ||
                    !this.#validActivity(raw.activity)) {
                    protocolInvalid = true;
                    return;
                  }
                  const id = raw.activity.id;
                  activityIds.add(id);
                  if (activityIds.size > this.#limits.maxActivityIds) {
                    protocolInvalid = true;
                  }
                  return;
                }
                case "continuation_updated": {
                  continuationEvents += 1;
                  if (continuationEvents !== 1 ||
                    !exactKeys(raw, ["type", "continuation"])) {
                    protocolInvalid = true;
                    return;
                  }
                  const recovered = await this.dependencies.continuationAuthority
                    .recoverStaged({
                      authorization: input.authorization,
                      writer: writer as ContinuationWriteCapability,
                    });
                  if (recovered === null ||
                    !isDeepStrictEqual(recovered, raw.continuation)) {
                    protocolInvalid = true;
                    return;
                  }
                  uncertain = recovered;
                  await input.mutation.append({
                    type: "runtime_continuation_updated",
                    at: this.#timestamp(),
                    turnId: input.turnId,
                    continuation: recovered,
                  });
                  return;
                }
                case "done":
                  if (!exactKeys(raw, ["type", "finalText", "stopReason"], [
                    "continuation",
                  ]) ||
                    !boundedString(raw.finalText, this.#limits.maxFinalTextBytes) ||
                    (raw.stopReason !== "complete" && raw.stopReason !== "length")) {
                    protocolInvalid = true;
                    return;
                  }
                  terminal = {
                    kind: "done",
                    finalText: raw.finalText,
                    stopReason: raw.stopReason,
                    ...(raw.continuation === undefined
                      ? {}
                      : { continuation: raw.continuation as RuntimeContinuationHandle }),
                  };
                  return;
                case "cancelled":
                  if (!exactKeys(raw, ["type", "reason"], ["continuation"]) ||
                    !boundedString(raw.reason, this.#limits.maxItemBytes)) {
                    protocolInvalid = true;
                    return;
                  }
                  terminal = {
                    kind: "cancelled",
                    reason: raw.reason,
                    ...(raw.continuation === undefined
                      ? {}
                      : { continuation: raw.continuation as RuntimeContinuationHandle }),
                  };
                  return;
                case "failed":
                  if (!exactKeys(raw, ["type", "failure"], ["continuation"]) ||
                    !validRuntimeFailure(raw.failure, this.#limits)) {
                    protocolInvalid = true;
                    return;
                  }
                  terminal = {
                    kind: "failed",
                    failure: raw.failure,
                    ...(raw.continuation === undefined
                      ? {}
                      : { continuation: raw.continuation as RuntimeContinuationHandle }),
                  };
                  return;
                default:
                  protocolInvalid = true;
              }
            } catch (error) {
              callbackFailure ??= error;
            }
          });
        }
      } catch (error) {
        iteratorError = error;
      }
      await queue.drain();
      this.#throwIfAborted(input.signal, diagnosticId);
      this.#assertRuntimeStable(
        input.runtime,
        capabilities,
        pin.runtimeCapabilityProfileRevisionAtCreation,
      );

      const recovered = await this.dependencies.continuationAuthority
        .recoverStaged({
          authorization: input.authorization,
          writer,
        });
      if (recovered !== null) {
        if (uncertain === null) {
          uncertain = recovered;
          await queue.run(() => input.mutation.append({
            type: "runtime_continuation_updated",
            at: this.#timestamp(),
            turnId: input.turnId,
            continuation: recovered,
          }));
          protocolInvalid = true;
        } else if (!isDeepStrictEqual(uncertain, recovered)) {
          protocolInvalid = true;
        }
      }
      this.#throwIfAborted(input.signal, diagnosticId);

      const completedTerminal = terminal as RuntimeTerminal | null;
      if (protocolInvalid) {
        throw new RuntimeProtocolError();
      }
      if (iteratorError !== null) {
        throw iteratorError;
      }
      if (callbackFailure !== null) {
        throw callbackFailure;
      }
      if (completedTerminal === null) {
        throw new RuntimeProtocolError();
      }
      if (
        completedTerminal.continuation !== undefined &&
        (uncertain === null ||
          !isDeepStrictEqual(completedTerminal.continuation, uncertain))
      ) {
        throw new RuntimeProtocolError();
      }
      if (completedTerminal.kind === "cancelled") {
        throw startedFailure(
          "cancelled",
          "The delegated runtime turn was cancelled",
          diagnosticId,
        );
      }
      if (completedTerminal.kind === "failed") {
        throw startedFailure(
          completedTerminal.failure.code,
          "The delegated runtime failed",
          diagnosticId,
          completedTerminal.failure.domain,
          completedTerminal.failure.retryable,
        );
      }

      let committed: RuntimeContinuationHandle | undefined;
      let finalization:
        | Awaited<ReturnType<
          RuntimeContinuationAuthority["prepareFinalization"]
        >>
        | undefined;
      if (uncertain !== null) {
        this.#throwIfAborted(input.signal, diagnosticId);
        finalization = await this.dependencies.continuationAuthority
          .prepareFinalization({
          authorization: input.authorization,
          handle: uncertain,
          outcome: "committed",
          expectedSessionRecordSequence: input.mutation.currentSequence,
        });
        const candidate = finalization.activeHandle;
        if (candidate === null) {
          throw new RuntimeProtocolError();
        }
        if (!committedVersion(uncertain, candidate)) {
          throw new RuntimeProtocolError();
        }
        committed = candidate;
      }
      this.#assertRuntimeStable(
        input.runtime,
        capabilities,
        pin.runtimeCapabilityProfileRevisionAtCreation,
      );
      const result: RunResult = deepFreeze({
        finalText: completedTerminal.finalText,
        usage,
        usageSource: usage === null ? "unavailable" : "runtime",
        steps: null,
        changedFiles,
        changedFilesSource: artifactSource(
          changedFiles.length,
          runtimeFileEventSeen,
          hostArtifacts.changedFilesContributed,
        ),
        evidence,
        evidenceSource: artifactSource(
          evidence.length,
          runtimeEvidenceSeen,
          hostArtifacts.evidenceContributed,
        ),
      });
      const runtimeCompleted = await queue.run(() => input.mutation.append({
        type: "runtime_completed",
        at: this.#timestamp(),
        turnId: input.turnId,
        result,
        stopReason: completedTerminal.stopReason,
        ...(committed === undefined ? {} : { continuation: committed }),
        provenance: {
          adapterId: input.runtime.adapterId,
          connectionId: input.runtime.connectionId,
          modelId: pin.modelId,
          backendFingerprint: createBackendFingerprint(pin),
          capabilityProfileRevision: input.runtime.capabilityProfileRevision,
        },
      }));
      if (finalization !== undefined) {
        try {
          await this.dependencies.continuationAuthority
            .acknowledgeFinalization({
              authorization: input.authorization,
              receipt: finalization.receipt,
              durableSessionRecordSequence: runtimeCompleted.sequence,
            });
        } catch {
          // The prepared view remains readable from the durable next sequence.
        }
      }
      const completed = await queue.run(() => input.mutation.append({
        type: "turn_completed",
        at: this.#timestamp(),
        turnId: input.turnId,
        result,
      }));
      closed = true;
      try {
        await this.#emitPresentation({
          type: "turn_completed",
          sessionId: input.session.id,
          at: completed.at,
          usage: result.usage,
          evidence: [...result.evidence],
        });
      } catch {
        // Durable completion is authoritative over a presentation sink failure.
      }
      return result;
    } catch (error) {
      if (!started) {
        if (isIntegrationFailure(error) && error.diagnosticId === diagnosticId) {
          throw error;
        }
        if (error instanceof BackendAuthorizationError) {
          throw preflightFailure(
            "authorization_denied",
            "The delegated runtime authorization is invalid or expired",
            diagnosticId,
            "policy",
          );
        }
        if (isObject(error) && typeof error.code === "string" &&
          error.code.startsWith("continuation_")) {
          throw preflightFailure(
            "continuation_incompatible",
            "The delegated runtime continuation cannot be resumed",
            diagnosticId,
          );
        }
        throw preflightFailure(
          "runtime_capability_missing",
          "The delegated runtime cannot safely execute this turn",
          diagnosticId,
        );
      }
      if (closed && isIntegrationFailure(error)) {
        throw error;
      }
      const failure = isIntegrationFailure(error) && error.phase === "started" &&
          error.diagnosticId === diagnosticId
        ? error
        : error instanceof RuntimeProtocolError
          ? startedFailure(
              "invalid_response",
              "The delegated runtime returned an invalid response",
              diagnosticId,
            )
          : input.signal.aborted
            ? startedFailure(
                "cancelled",
                "The delegated runtime turn was cancelled",
                diagnosticId,
              )
            : startedFailure(
                "runtime_failed",
                "The delegated runtime failed",
                diagnosticId,
              );
      if (!closed) {
        try {
          if (writer !== null && uncertain === null) {
            const recovered = await this.dependencies.continuationAuthority
              .recoverStaged({ authorization: input.authorization, writer });
            if (recovered !== null) {
              uncertain = recovered;
              await queue.run(() => input.mutation.append({
                type: "runtime_continuation_updated",
                at: this.#timestamp(),
                turnId: input.turnId,
                continuation: recovered,
              }));
            }
          }
          const failed = failure.code === "cancelled"
            ? await queue.run(() => input.mutation.append({
                type: "turn_cancelled",
                at: this.#timestamp(),
                turnId: input.turnId,
                reason: failure.safeMessage,
                ...(uncertain === null ? {} : { continuation: uncertain }),
              }))
            : await queue.run(() => input.mutation.append({
                type: "turn_failed",
                at: this.#timestamp(),
                turnId: input.turnId,
                error: failure,
                ...(uncertain === null ? {} : { continuation: uncertain }),
              }));
          closed = true;
          await this.#emitPresentation(failure.code === "cancelled"
            ? {
                type: "turn_cancelled",
                sessionId: input.session.id,
                at: failed.at,
                turnId: input.turnId,
              }
            : {
                type: "turn_failed",
                sessionId: input.session.id,
                at: failed.at,
                error: {
                  code: failure.code,
                  message: failure.safeMessage,
                  retryable: failure.retryable,
                },
              });
        } catch {
          // Keep the original bounded failure authoritative.
        }
      }
      throw failure;
    } finally {
      const capabilities = [reader, writer].filter(
        (item): item is ContinuationReadCapability | ContinuationWriteCapability =>
          item !== null,
      );
      for (const capability of capabilities) {
        try {
          await this.dependencies.continuationAuthority.release(capability);
        } catch {
          // Capability expiry is the final fallback; release cannot rewrite a terminal.
        }
      }
    }
  }

  #preflight(
    input: DelegatedRunExecutorInput,
    diagnosticId: string,
  ): Readonly<RuntimeCapabilities> {
    const pin = input.session.backend.pin;
    if (
      pin.kind !== "agent_runtime" ||
      !boundedNonEmptyString(
        pin.runtimeCapabilityProfileRevisionAtCreation,
        this.#limits.maxItemBytes,
      ) ||
      input.runtime.adapterId !== pin.adapterId ||
      input.runtime.connectionId !== pin.connectionId ||
      input.runtime.capabilityProfileRevision !==
        pin.runtimeCapabilityProfileRevisionAtCreation ||
      !boundedNonEmptyString(input.runtime.capabilityProfileRevision, 512) ||
      input.session.id !== input.mutation.sessionId ||
      input.session.lastSequence !== input.mutation.currentSequence ||
      input.session.openTurnId !== null ||
      input.session.pendingRuntimeCompletion !== null ||
      !boundedNonEmptyString(input.turnId, 512) ||
      !boundedNonEmptyString(input.prompt.trim(), this.#limits.maxTextBytes)
    ) {
      throw preflightFailure(
        "runtime_capability_missing",
        "The delegated runtime does not match the immutable session pin",
        diagnosticId,
      );
    }
    if (input.signal.aborted) {
      throw preflightFailure(
        "cancelled",
        "The delegated runtime turn was cancelled before it started",
        diagnosticId,
      );
    }
    verifyRunAuthorization(input.authorization, {
      id: input.authorization.id,
      operation: "run",
      sessionId: input.session.id,
      operationId: input.authorization.operationId,
      turnId: input.turnId,
      pin,
      connectionRevision: input.authorization.connectionRevision,
      policyRevision: pin.policyRevisionAtCreation,
      context: input.context,
      maxRequests: input.authorization.maxRequests,
      expiresAt: input.authorization.expiresAt,
    }, this.#currentTime());
    const capabilities = snapshotCapabilities(input.runtime.capabilities);
    if (
      capabilities.cancellation !== "protocol" ||
      !capabilities.supportedPermissionModes.includes(
        input.session.permissionMode,
      ) ||
      (input.executionMode === "plan" && capabilities.planMode !== "enforced") ||
      (input.executionMode === "act" &&
        (capabilities.toolExecution !== "host_tools" ||
          capabilities.checkpointing !== "host_tools" ||
          (capabilities.approvalControl !== "host" &&
            capabilities.approvalControl !== "recurs_policy_bridge"))) ||
      (input.session.runtimeContinuation?.status === "committed" &&
        !capabilities.resume)
    ) {
      throw preflightFailure(
        "runtime_capability_missing",
        "The delegated runtime cannot safely execute the requested mode",
        diagnosticId,
      );
    }
    if (input.session.runtimeContinuation?.status === "uncertain") {
      throw preflightFailure(
        "continuation_uncertain",
        "The delegated runtime continuation must be reconciled before another turn",
        diagnosticId,
      );
    }
    return capabilities;
  }

  async #resolveRuntimeApproval(
    rawRequest: RuntimeApprovalRequest,
    input: DelegatedRunExecutorInput,
    permissions: PermissionEngine,
    requestIds: Set<string>,
  ): Promise<RuntimeApprovalDecision> {
    if (!validRuntimeApprovalRequest(rawRequest, this.#limits) ||
      requestIds.has(rawRequest.requestId) ||
      requestIds.size >= this.#limits.maxDistinctItems) {
      throw new RuntimeProtocolError();
    }
    requestIds.add(rawRequest.requestId);
    const request = deepFreeze(structuredClone(rawRequest));
    let grants = this.#runtimeApprovalGrants.get(input.session.id);
    if (grants === undefined) {
      grants = new Set();
      this.#runtimeApprovalGrants.set(input.session.id, grants);
    }

    let resolution: RuntimeApprovalResolution | null = input.signal.aborted
      ? cancelledResolution("signal")
      : null;
    if (
      resolution === null &&
      input.executionMode === "plan" &&
      (request.action !== "read" || request.risk !== "normal")
    ) {
      resolution = exactPolicyResolution(request, "reject_once", "deny") ??
        cancelledResolution("policy");
    }
    if (resolution === null) {
      const cached = request.options.filter((option) =>
        option.kind === "allow_once" &&
        grants.has(runtimeGrantKey(request, option.optionId))
      );
      if (cached.length === 1) {
        resolution = {
          decision: { outcome: "selected", optionId: cached[0]!.optionId },
          scope: "allow_session",
          provenance: "policy",
        };
      }

      const intent = runtimePermissionIntent(request);
      const policy = permissions.evaluate(intent);
      if (resolution === null && policy === "allow") {
        resolution = exactPolicyResolution(request, "allow_once", "allow_once");
      }
      if (resolution === null && policy === "deny") {
        resolution = exactPolicyResolution(request, "reject_once", "deny") ??
          cancelledResolution("policy");
      }
    }

    if (resolution === null) {
      if (input.signal.aborted) {
        resolution = cancelledResolution("signal");
      } else {
        let handled: unknown;
        try {
          handled = await raceAgainstAbort(
            () => this.dependencies.runtimeApprovals.request(request),
            input.signal,
          );
        } catch (error) {
          if (input.signal.aborted) {
            resolution = cancelledResolution("signal");
          } else {
            throw error;
          }
        }
        if (resolution === null) {
          if (input.signal.aborted || handled === approvalAborted) {
            resolution = cancelledResolution("signal");
          } else {
            const candidate = validHandlerResolution(handled);
            if (candidate?.decision.outcome !== "selected") {
              resolution = cancelledResolution("user");
            } else {
              const selectedOptionId = candidate.decision.optionId;
              const selected = request.options.find((option) =>
                option.optionId === selectedOptionId
              );
              const compatible = selected?.kind === "allow_once"
                ? candidate.scope === "allow_once" ||
                  candidate.scope === "allow_session"
                : selected?.kind === "reject_once" && candidate.scope === "deny";
              resolution = compatible
                ? { ...candidate, provenance: "user" }
                : cancelledResolution("user");
            }
          }
        }
      }
    }

    if (input.signal.aborted) {
      resolution = cancelledResolution("signal");
    }

    await input.mutation.append({
      type: "runtime_approval_resolved",
      at: this.#timestamp(),
      turnId: input.turnId,
      request,
      decision: resolution.decision,
      scope: resolution.scope,
      provenance: resolution.provenance,
    });
    if (resolution.decision.outcome === "selected" &&
      resolution.scope === "allow_session") {
      grants.add(runtimeGrantKey(request, resolution.decision.optionId));
    }
    return deepFreeze(structuredClone(resolution.decision));
  }

  async #executeHostTool(
    rawCall: ToolCall,
    runtimeSignal: AbortSignal,
    input: DelegatedRunExecutorInput,
    permissions: PermissionEngine,
    baseContext: ToolContext,
    callIds: Set<string>,
    artifacts: HostArtifacts,
    diagnosticId: string,
  ): Promise<{ output: string }> {
    if (!validToolCall(rawCall, this.#limits) ||
      callIds.has(rawCall.id) ||
      callIds.size >= this.#limits.maxDistinctItems ||
      !(runtimeSignal instanceof AbortSignal)) {
      throw new RuntimeProtocolError();
    }
    callIds.add(rawCall.id);
    const call = deepFreeze(structuredClone(rawCall));
    const signal = runtimeSignal === input.signal
      ? input.signal
      : AbortSignal.any([input.signal, runtimeSignal]);
    const context: ToolContext = { ...baseContext, signal };
    await this.#emitPresentation({
      type: "tool_requested",
      sessionId: input.session.id,
      at: this.#timestamp(),
      call,
    });
    const started = await input.mutation.append({
      type: "tool_started",
      turnId: input.turnId,
      at: this.#timestamp(),
      call,
    });
    await this.#emitPresentation({
      type: "tool_started",
      sessionId: input.session.id,
      at: started.at,
      call,
    });

    let result: ToolResult;
    let resultChangedFiles: string[];
    let resultEvidence: string[];
    try {
      const approvals: ApprovalHandler = {
        request: async (intent) => {
          await this.#emitPresentation({
            type: "permission_requested",
            sessionId: input.session.id,
            at: this.#timestamp(),
            intent,
          });
          const candidate = await raceAgainstAbort(
            () => this.dependencies.approvals.request(intent),
            signal,
          );
          const decision = signal.aborted || candidate === approvalAborted
            ? "deny"
            : candidate === "allow_once" || candidate === "allow_session" ||
                candidate === "deny"
              ? candidate
              : "deny";
          const persisted = await input.mutation.append({
            type: "permission_resolved",
            turnId: input.turnId,
            at: this.#timestamp(),
            intent,
            decision,
          });
          await this.#emitPresentation({
            type: "permission_resolved",
            sessionId: input.session.id,
            at: persisted.at,
            intent,
            decision,
          });
          return decision;
        },
      };
      result = await this.dependencies.tools.invoke(
        call,
        context,
        permissions,
        approvals,
      );
      if (!validToolResult(result, this.#limits)) {
        throw new ToolError("output_limit", "Host tool output exceeded its bounds");
      }
      const changedFiles = boundedMetadataStrings(
        result,
        "changedFiles",
        this.#limits,
      );
      const evidence = boundedMetadataStrings(
        result,
        "evidence",
        this.#limits,
      );
      if (changedFiles === null || evidence === null ||
        !addUniqueBounded(artifacts.changedFiles, changedFiles, this.#limits) ||
        !addUniqueBounded(artifacts.evidence, evidence, this.#limits)) {
        throw new ToolError("output_limit", "Host tool metadata exceeded its bounds");
      }
      resultChangedFiles = changedFiles;
      resultEvidence = evidence;
      artifacts.changedFilesContributed ||= changedFiles.length > 0;
      artifacts.evidenceContributed ||= evidence.length > 0;
    } catch (error) {
      const normalized = safeToolFailure(error, diagnosticId);
      const failed = await input.mutation.append({
        type: "tool_failed",
        turnId: input.turnId,
        at: this.#timestamp(),
        callId: call.id,
        error: normalized.failure,
      });
      await this.#emitPresentation({
        type: "tool_failed",
        sessionId: input.session.id,
        at: failed.at,
        callId: call.id,
        error: {
          code: normalized.failure.code,
          message: normalized.failure.safeMessage,
          retryable: normalized.failure.retryable,
        },
      });
      if (normalized.cancelled || signal.aborted) {
        throw startedFailure(
          "cancelled",
          "The delegated runtime turn was cancelled",
          diagnosticId,
        );
      }
      return { output: normalized.output };
    }

    const completed = await input.mutation.append({
      type: "tool_completed",
      turnId: input.turnId,
      at: this.#timestamp(),
      callId: call.id,
      result,
    });
    await this.#emitPresentation({
      type: "tool_completed",
      sessionId: input.session.id,
      at: completed.at,
      callId: call.id,
      result,
    });
    if (resultChangedFiles.length > 0) {
      const files = await input.mutation.append({
        type: "files_changed",
        turnId: input.turnId,
        at: this.#timestamp(),
        paths: resultChangedFiles,
      });
      await this.#emitPresentation({
        type: "files_changed",
        sessionId: input.session.id,
        at: files.at,
        paths: resultChangedFiles,
      });
    }
    if (resultEvidence.length > 0) {
      const verification = await input.mutation.append({
        type: "verification_recorded",
        turnId: input.turnId,
        at: this.#timestamp(),
        evidence: resultEvidence,
      });
      await this.#emitPresentation({
        type: "verification_recorded",
        sessionId: input.session.id,
        at: verification.at,
        evidence: resultEvidence,
      });
    }
    return { output: result.output };
  }

  #assertRuntimeStable(
    runtime: AgentRuntime,
    capabilities: Readonly<RuntimeCapabilities>,
    capabilityProfileRevision: string,
  ): void {
    if (
      runtime.capabilityProfileRevision !== capabilityProfileRevision ||
      !isDeepStrictEqual(runtime.capabilities, capabilities)
    ) {
      throw new RuntimeProtocolError();
    }
  }

  #throwIfAborted(signal: AbortSignal, diagnosticId: string): void {
    if (signal.aborted) {
      throw startedFailure(
        "cancelled",
        "The delegated runtime turn was cancelled",
        diagnosticId,
      );
    }
  }

  async #emitPresentation(event: RecursEvent): Promise<void> {
    try {
      await this.dependencies.emit(event);
    } catch {
      // Session records, not presentation sinks, are authoritative.
    }
  }

  #validActivity(value: unknown): value is RuntimeActivity {
    if (!(isObject(value) && exactKeys(
      value,
      ["id", "kind", "name", "status"],
      ["summary"],
    ))) {
      return false;
    }
    return boundedNonEmptyString(value.id, this.#limits.maxItemBytes) &&
      (value.kind === "tool" || value.kind === "command" ||
        value.kind === "file_change" || value.kind === "subagent" ||
        value.kind === "other") &&
      boundedNonEmptyString(value.name, this.#limits.maxItemBytes) &&
      (value.status === "started" || value.status === "running" ||
        value.status === "completed" || value.status === "failed" ||
        value.status === "declined") &&
      (value.summary === undefined ||
        boundedString(value.summary, this.#limits.maxItemBytes));
  }

  #currentTime(): Date {
    const value = this.#now();
    if (!Number.isFinite(value.getTime())) {
      throw new TypeError("Delegated runtime clock is invalid");
    }
    return new Date(value);
  }

  #timestamp(): string {
    return this.#currentTime().toISOString();
  }
}

type SessionBackendPinRuntime = Omit<
  SessionBackendPin,
  "kind" | "runtimeCapabilityProfileRevisionAtCreation"
> & {
  kind: "agent_runtime";
  runtimeCapabilityProfileRevisionAtCreation: string;
};

function isIntegrationFailure(value: unknown): value is IntegrationFailure {
  return isObject(value) &&
    typeof value.domain === "string" &&
    (value.phase === "preflight" || value.phase === "started") &&
    typeof value.code === "string" &&
    typeof value.safeMessage === "string" &&
    typeof value.diagnosticId === "string" &&
    typeof value.retryable === "boolean";
}

function artifactSource(
  itemCount: number,
  runtimeContributed: boolean,
  hostContributed: boolean,
): "runtime" | "host_tools" | "mixed" | "none" {
  if (itemCount === 0) {
    return "none";
  }
  if (runtimeContributed && hostContributed) {
    return "mixed";
  }
  if (runtimeContributed) {
    return "runtime";
  }
  if (hostContributed) {
    return "host_tools";
  }
  throw new RuntimeProtocolError();
}
