import { randomUUID, createHash } from "node:crypto";
import path from "node:path";

import {
  client,
  methods,
  RequestError,
  type AuthMethod,
  type ClientConnection,
  type ClientContext,
  type InitializeResponse,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionResponse,
  type SessionConfigOption,
} from "@agentclientprotocol/sdk";
import type {
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentRuntimeHost,
  ContinuationReadCapability,
  IntegrationFailure,
  RunAuthorization,
  RuntimeApprovalRequest,
  RuntimeCapabilities,
  RuntimeContinuationHandle,
  RuntimeContinuationStore,
} from "@recurs/contracts";
import { z } from "zod";

import {
  AcpUpdateError,
  configSelectionsMatch,
  translateAcpUpdate,
} from "./acp-updates.js";
import {
  authResponseSchema,
  configResponseSchema,
  emptyResponseSchema,
  initializeResponseSchema,
  newSessionResponseSchema,
  promptResponseSchema,
  sanitizeAcpStream,
  sessionStateSchema,
} from "./acp-codec.js";
import {
  ACP_TERMINAL_EVENT_RESERVE_BYTES,
  SAFE_ACP_IDENTIFIER_PATTERN,
  containsSecretCanary,
  createAcpRuntimeProfile,
  deepFreeze,
  type AcpRuntimeBounds,
  type AcpRuntimeProfile,
  type AcpSessionMapping,
} from "./acp-profile.js";
import {
  AcpTransportError,
  spawnManagedAcpProcess,
  type ManagedAcpProcess,
} from "./process-supervisor.js";

export interface AcpRuntimeInspection {
  readonly protocolVersion: number;
  readonly agentInfo: {
    readonly name: string;
    readonly version: string;
    readonly title?: string;
  } | null;
  readonly authMethods: readonly {
    readonly id: string;
    readonly name: string;
    readonly type: "agent" | "env_var" | "terminal";
  }[];
  readonly sessionCapabilities: {
    readonly resume: boolean;
    readonly close: boolean;
  };
}

export interface AcpAuthenticationResult extends AcpRuntimeInspection {
  readonly authenticatedMethodId: string;
}

export type AcpOperationErrorCode =
  | "authentication_required"
  | "cancelled"
  | "session_unavailable"
  | "request_rejected";

function acpOperationErrorMessage(code: AcpOperationErrorCode): string {
  switch (code) {
    case "authentication_required":
      return "The ACP operation requires authentication";
    case "cancelled":
      return "The ACP operation was cancelled";
    case "session_unavailable":
      return "The ACP session is unavailable";
    case "request_rejected":
      return "The ACP agent rejected the operation";
  }
}

export class AcpOperationError extends Error {
  constructor(readonly code: AcpOperationErrorCode) {
    super(acpOperationErrorMessage(code));
    this.name = "AcpOperationError";
  }
}

const continuationPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  vendorSessionId: z.string().min(1).max(1_024),
  cwd: z.string().min(1).max(4_096),
}).strict();

class RuntimeBoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeBoundError";
  }
}

class RuntimeTimeoutError extends Error {
  constructor(readonly phase: "prompt" | "cancel" | "shutdown") {
    super(`ACP ${phase} timeout`);
    this.name = "RuntimeTimeoutError";
  }
}

class RuntimePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimePreflightError";
  }
}

class RuntimeCancelledError extends Error {
  constructor() {
    super("ACP operation cancelled");
    this.name = "RuntimeCancelledError";
  }
}

type AcpSessionBindingDecision =
  | "verified"
  | "authentication_required"
  | "account_mismatch";

export interface AcpRuntimeSessionBinding {
  readonly expectedAgentInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly extensionMethod: string;
  evaluate(value: unknown): AcpSessionBindingDecision;
}

class RuntimeSessionBindingError extends Error {
  constructor(
    readonly code:
      | "authentication_required"
      | "account_mismatch"
      | "adapter_unavailable",
  ) {
    super("ACP runtime session binding failed");
    this.name = "RuntimeSessionBindingError";
  }
}

class RuntimeEventChannel implements AsyncIterable<AgentRuntimeEvent> {
  private readonly queue: { event: AgentRuntimeEvent; bytes: number }[] = [];
  private readonly waiters: Array<() => void> = [];
  private queuedBytes = 0;
  private eventCount = 0;
  private eventBytes = 0;
  private closed = false;

  constructor(private readonly bounds: AcpRuntimeBounds) {}

  push(event: AgentRuntimeEvent): void {
    if (this.closed) throw new RuntimeBoundError("runtime event channel is closed");
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (
      this.eventCount + 1 > this.bounds.maxEvents - 1 ||
      this.eventBytes + bytes >
        this.bounds.maxEventBytes - ACP_TERMINAL_EVENT_RESERVE_BYTES
    ) {
      throw new RuntimeBoundError("ACP runtime event limit exceeded");
    }
    if (
      this.queue.length + 1 > this.bounds.maxEventQueueEvents - 1 ||
      this.queuedBytes + bytes >
        this.bounds.maxEventQueueBytes - ACP_TERMINAL_EVENT_RESERVE_BYTES
    ) {
      throw new RuntimeBoundError("ACP runtime event queue limit exceeded");
    }
    this.eventCount += 1;
    this.eventBytes += bytes;
    this.queue.push({ event, bytes });
    this.queuedBytes += bytes;
    this.wake();
  }

  finish(event: AgentRuntimeEvent, fallback: AgentRuntimeEvent): void {
    if (this.closed) return;
    const selected = this.canFitTerminal(event) ? event : fallback;
    if (!this.canFitTerminal(selected)) {
      throw new RuntimeBoundError("ACP terminal event reserve was exhausted");
    }
    const bytes = Buffer.byteLength(JSON.stringify(selected));
    this.eventCount += 1;
    this.eventBytes += bytes;
    this.queue.push({ event: selected, bytes });
    this.queuedBytes += bytes;
    this.closed = true;
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent> {
    for (;;) {
      const item = this.queue.shift();
      if (item) {
        this.queuedBytes -= item.bytes;
        yield item.event;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private wake(): void {
    const waiter = this.waiters.shift();
    waiter?.();
  }

  private canFitTerminal(event: AgentRuntimeEvent): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    return this.eventCount + 1 <= this.bounds.maxEvents &&
      this.eventBytes + bytes <= this.bounds.maxEventBytes &&
      this.queue.length + 1 <= this.bounds.maxEventQueueEvents &&
      this.queuedBytes + bytes <= this.bounds.maxEventQueueBytes;
  }
}

function failure(
  phase: "preflight" | "started",
  domain: IntegrationFailure["domain"],
  code: IntegrationFailure["code"],
  safeMessage: string,
  options: {
    retryable?: boolean;
    action?: IntegrationFailure["action"];
  } = {},
): IntegrationFailure {
  return {
    domain,
    phase,
    code,
    safeMessage,
    diagnosticId: `acp-${randomUUID()}`,
    retryable: options.retryable ?? false,
    ...(options.action === undefined ? {} : { action: options.action }),
  };
}

function terminalBoundFallback(): AgentRuntimeEvent {
  return {
    type: "failed",
    failure: failure(
      "started",
      "runtime",
      "invalid_response",
      "The delegated runtime exceeded a configured terminal-event bound",
    ),
  };
}

function mapFailure(error: unknown, phase: "preflight" | "started"): IntegrationFailure {
  if (error instanceof RuntimeSessionBindingError) {
    if (error.code === "authentication_required") {
      return failure(
        phase,
        "auth",
        "authentication_required",
        "The Codex connection requires ChatGPT sign-in",
        { action: "reauthenticate" },
      );
    }
    if (error.code === "account_mismatch") {
      return failure(
        phase,
        "auth",
        "account_mismatch",
        "The active ChatGPT account does not match this Codex connection",
        { action: "select_connection" },
      );
    }
    return failure(
      phase,
      "connection",
      "adapter_unavailable",
      "The official Codex runtime could not be verified",
    );
  }
  if (error instanceof RuntimeCancelledError) {
    return failure(phase, "runtime", "cancelled", "The delegated runtime was cancelled");
  }
  if (error instanceof RuntimePreflightError) {
    return failure(
      phase,
      "runtime",
      "runtime_capability_missing",
      "The delegated runtime does not support this model, mode, or permission profile",
    );
  }
  if (error instanceof RequestError && error.code === -32000) {
    return failure(
      phase,
      "auth",
      "authentication_required",
      "The delegated runtime requires authentication",
      { action: "reauthenticate" },
    );
  }
  if (error instanceof RuntimeTimeoutError) {
    return failure(
      phase,
      "runtime",
      "timeout",
      "The delegated runtime did not settle within its time limit",
      { retryable: true },
    );
  }
  if (error instanceof RuntimeBoundError) {
    return failure(
      phase,
      "runtime",
      "invalid_response",
      "The delegated runtime exceeded a configured safety bound",
    );
  }
  if (error instanceof z.ZodError) {
    return failure(
      phase,
      "runtime",
      "invalid_response",
      "The delegated runtime returned an invalid response",
    );
  }
  if (error instanceof AcpTransportError || error instanceof AcpUpdateError) {
    return failure(
      phase,
      "runtime",
      "protocol_mismatch",
      "The delegated runtime violated the bounded ACP protocol",
    );
  }
  if (error instanceof RequestError && error.code === -32800) {
    return failure(phase, "runtime", "cancelled", "The delegated runtime was cancelled");
  }
  return failure(
    phase,
    "runtime",
    "runtime_failed",
    "The delegated runtime failed safely",
    { retryable: true },
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  phase: RuntimeTimeoutError["phase"],
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new RuntimeTimeoutError(phase)),
      timeoutMs,
    );
    timer.unref?.();
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function raceTransport<T>(promise: Promise<T>, process: ManagedAcpProcess): Promise<T> {
  return Promise.race([
    promise,
    process.failure.then((error) => Promise.reject(error)),
  ]);
}

async function sendSessionCancellation(
  context: ClientContext,
  process: ManagedAcpProcess,
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await raceTransport(
      withTimeout(
        context.notify(methods.agent.session.cancel, { sessionId }),
        timeoutMs,
        "cancel",
      ),
      process,
    );
  } catch {
    // Process shutdown is the bounded fallback when protocol cancellation fails.
  }
}

async function requestSessionOperation<T>(
  start: (cancellationSignal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  context: ClientContext,
  process: ManagedAcpProcess,
  sessionId: string,
  timeoutMs: number,
  cancelSettlementTimeoutMs: number,
): Promise<T> {
  if (signal.aborted) {
    await sendSessionCancellation(
      context,
      process,
      sessionId,
      cancelSettlementTimeoutMs,
    );
    throw new RuntimeCancelledError();
  }
  const requestCancellation = new AbortController();
  const operation = raceTransport(
    withTimeout(
      start(requestCancellation.signal),
      timeoutMs,
      "prompt",
    ),
    process,
  ).then(
    (value) => ({ kind: "value" as const, value }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );
  let finishAbort: (() => void) | null = null;
  const aborted = new Promise<{ readonly kind: "cancelled" }>((resolve) => {
    finishAbort = () => resolve({ kind: "cancelled" });
  });
  const onAbort = (): void => finishAbort?.();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    const outcome = await Promise.race([operation, aborted]);
    if (signal.aborted) {
      requestCancellation.abort(new Error("ACP session operation cancelled"));
      await sendSessionCancellation(
        context,
        process,
        sessionId,
        cancelSettlementTimeoutMs,
      );
      throw new RuntimeCancelledError();
    }
    if (outcome.kind === "value") return outcome.value;
    if (outcome.kind === "error") throw outcome.error;
    requestCancellation.abort(new Error("ACP session operation cancelled"));
    await sendSessionCancellation(
      context,
      process,
      sessionId,
      cancelSettlementTimeoutMs,
    );
    throw new RuntimeCancelledError();
  } finally {
    signal.removeEventListener("abort", onAbort);
    finishAbort = null;
  }
}

async function verifySessionBinding(
  context: ClientContext,
  initialized: InitializeResponse,
  process: ManagedAcpProcess,
  binding: AcpRuntimeSessionBinding | null,
  signal: AbortSignal,
  timeoutMs: number,
  activeSession: {
    readonly sessionId: string;
    readonly cancelSettlementTimeoutMs: number;
  } | null = null,
): Promise<void> {
  if (binding === null) return;
  if (signal.aborted) {
    if (activeSession !== null) {
      await sendSessionCancellation(
        context,
        process,
        activeSession.sessionId,
        activeSession.cancelSettlementTimeoutMs,
      );
    }
    throw new RuntimeCancelledError();
  }
  if (
    initialized.agentInfo?.name !== binding.expectedAgentInfo.name ||
    initialized.agentInfo.version !== binding.expectedAgentInfo.version
  ) {
    throw new RuntimeSessionBindingError("adapter_unavailable");
  }
  const response = activeSession === null
    ? await raceTransport(
        withTimeout(
          context.request<unknown, Record<string, never>>(
            binding.extensionMethod,
            {},
          ),
          timeoutMs,
          "prompt",
        ),
        process,
      )
    : await requestSessionOperation(
        (cancellationSignal) =>
          context.request<unknown, Record<string, never>>(
            binding.extensionMethod,
            {},
            { cancellationSignal },
          ),
        signal,
        context,
        process,
        activeSession.sessionId,
        timeoutMs,
        activeSession.cancelSettlementTimeoutMs,
      );
  if (signal.aborted) {
    if (activeSession !== null) {
      await sendSessionCancellation(
        context,
        process,
        activeSession.sessionId,
        activeSession.cancelSettlementTimeoutMs,
      );
    }
    throw new RuntimeCancelledError();
  }
  const decision = binding.evaluate(response);
  if (decision !== "verified") {
    throw new RuntimeSessionBindingError(decision);
  }
}

function parseInitialize(value: unknown, profile: AcpRuntimeProfile): InitializeResponse {
  const parsed = initializeResponseSchema.parse(value);
  if (parsed.protocolVersion !== profile.protocolVersion) {
    throw new AcpTransportError("ACP protocol version negotiation failed");
  }
  const methodIds = new Set<string>();
  for (const method of parsed.authMethods ?? []) {
    if (
      !SAFE_ACP_IDENTIFIER_PATTERN.test(method.id) ||
      methodIds.has(method.id) ||
      containsSecretCanary(method.id) ||
      containsSecretCanary(method.name)
    ) {
      throw new AcpTransportError("ACP agent advertised invalid authentication metadata");
    }
    methodIds.add(method.id);
  }
  if (
    parsed.agentInfo != null &&
    (containsSecretCanary(parsed.agentInfo.name) ||
      containsSecretCanary(parsed.agentInfo.version) ||
      (parsed.agentInfo.title != null && containsSecretCanary(parsed.agentInfo.title)))
  ) {
    throw new AcpTransportError("ACP agent advertised invalid implementation metadata");
  }
  return parsed as InitializeResponse;
}

function inspectionFromInitialize(value: InitializeResponse): AcpRuntimeInspection {
  const sessionCapabilities = value.agentCapabilities?.sessionCapabilities;
  return deepFreeze({
    protocolVersion: value.protocolVersion,
    agentInfo: value.agentInfo == null
      ? null
      : {
          name: value.agentInfo.name,
          version: value.agentInfo.version,
          ...(value.agentInfo.title == null ? {} : { title: value.agentInfo.title }),
        },
    authMethods: (value.authMethods ?? []).map((method) => ({
      id: method.id,
      name: method.name,
      type: "type" in method ? method.type : "agent",
    })),
    sessionCapabilities: {
      resume: sessionCapabilities?.resume != null,
      close: sessionCapabilities?.close != null,
    },
  });
}

function selectMapping(
  profile: AcpRuntimeProfile,
  request: AgentRunRequest,
): AcpSessionMapping {
  const mapping = profile.mappings.find((candidate) =>
    candidate.modelId === request.modelId &&
    candidate.executionMode === request.executionMode &&
    candidate.permissionMode === request.permissionMode
  );
  if (!mapping) throw new RuntimePreflightError("missing reviewed ACP mapping");
  return mapping;
}

function ensureRequestPreflight(
  profile: AcpRuntimeProfile,
  request: AgentRunRequest,
): AcpSessionMapping {
  if (
    !path.isAbsolute(request.cwd) ||
    request.authorization.connectionId !== profile.connectionId ||
    request.authorization.operation !== "run" ||
    request.authorization.modelId !== request.modelId ||
    request.authorization.sessionId !== request.sessionId ||
    request.authorization.turnId !== request.turnId
  ) {
    throw new RuntimePreflightError("ACP request identity is inconsistent");
  }
  if (request.continuation === null && request.continuationReader !== null) {
    throw new RuntimePreflightError("ACP continuation reader has no continuation");
  }
  if (
    request.continuation !== null &&
    (request.continuationReader === null || !profile.capabilities.resume)
  ) {
    throw new RuntimePreflightError("ACP continuation cannot be resumed");
  }
  if (request.continuation !== null) {
    const continuation = request.continuation;
    if (
      continuation.status !== "committed" ||
      continuation.adapterId !== profile.adapterId ||
      continuation.connectionId !== profile.connectionId ||
      continuation.modelId !== request.modelId ||
      continuation.recursSessionId !== request.sessionId ||
      continuation.backendFingerprint !== request.authorization.backendFingerprint
    ) {
      throw new RuntimePreflightError("ACP continuation identity is inconsistent");
    }
  }
  return selectMapping(profile, request);
}

function validateStagedContinuation(
  continuation: RuntimeContinuationHandle,
  profile: AcpRuntimeProfile,
  request: AgentRunRequest,
): void {
  if (
    continuation.status !== "uncertain" ||
    continuation.adapterId !== profile.adapterId ||
    continuation.connectionId !== profile.connectionId ||
    continuation.modelId !== request.modelId ||
    continuation.recursSessionId !== request.sessionId ||
    continuation.backendFingerprint !== request.authorization.backendFingerprint ||
    continuation.originTurnId !== request.turnId
  ) {
    throw new AcpTransportError("ACP continuation store returned inconsistent provenance");
  }
}

function optionContainsValue(option: SessionConfigOption, value: string | boolean): boolean {
  if (option.type === "boolean") return typeof value === "boolean";
  if (typeof value !== "string") return false;
  return option.options.some((candidate) =>
    "value" in candidate
      ? candidate.value === value
      : candidate.options.some((nested) => nested.value === value)
  );
}

function assertReviewedSelectors(
  options: readonly SessionConfigOption[],
  mapping: AcpSessionMapping,
): void {
  for (const selector of [
    mapping.modelSelector,
    mapping.executionModeSelector,
  ]) {
    const option = options.find((candidate) => candidate.id === selector.configId);
    if (
      option === undefined ||
      option.type === "boolean" ||
      option.category !== selector.category ||
      !optionContainsValue(option, selector.value)
    ) {
      throw new RuntimePreflightError(
        `reviewed ACP ${selector.category} selector is unavailable`,
      );
    }
  }
}

function configValue(option: SessionConfigOption): string | boolean {
  return option.currentValue;
}

async function enforceSessionMapping(
  context: ClientContext,
  sessionId: string,
  state: NewSessionResponse | ResumeSessionResponse,
  mapping: AcpSessionMapping,
  process: ManagedAcpProcess,
  timeoutMs: number,
  cancelSettlementTimeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (mapping.modeId !== null) {
    const modes = state.modes;
    if (!modes?.availableModes.some((mode) => mode.id === mapping.modeId)) {
      throw new RuntimePreflightError("reviewed ACP mode is unavailable");
    }
    if (modes.currentModeId !== mapping.modeId) {
      const response = await requestSessionOperation(
        (cancellationSignal) =>
          context.request(methods.agent.session.setMode, {
            sessionId,
            modeId: mapping.modeId,
          }, { cancellationSignal }),
        signal,
        context,
        process,
        sessionId,
        timeoutMs,
        cancelSettlementTimeoutMs,
      );
      emptyResponseSchema.parse(response);
    }
  }

  let current = [...(state.configOptions ?? [])] as SessionConfigOption[];
  assertReviewedSelectors(current, mapping);
  const selectorsRequiringConfirmation = new Set([
    mapping.modelSelector.configId,
    mapping.executionModeSelector.configId,
  ]);
  for (const selection of mapping.configOptions) {
    const option = current.find((candidate) => candidate.id === selection.configId);
    if (!option || !optionContainsValue(option, selection.value)) {
      throw new RuntimePreflightError("reviewed ACP configuration is unavailable");
    }
    if (
      configValue(option) === selection.value &&
      !selectorsRequiringConfirmation.has(selection.configId)
    ) continue;
    const response = await requestSessionOperation(
      (cancellationSignal) =>
        context.request(methods.agent.session.setConfigOption, {
          sessionId,
          configId: selection.configId,
          ...(typeof selection.value === "boolean"
            ? { type: "boolean" as const, value: selection.value }
            : { value: selection.value }),
        }, { cancellationSignal }),
      signal,
      context,
      process,
      sessionId,
      timeoutMs,
      cancelSettlementTimeoutMs,
    );
    current = configResponseSchema.parse(response).configOptions as SessionConfigOption[];
    assertReviewedSelectors(current, mapping);
    if (!configSelectionsMatch(current, [selection])) {
      throw new AcpTransportError("ACP configuration change did not take effect");
    }
  }
  if (!configSelectionsMatch(current, mapping.configOptions)) {
    throw new AcpTransportError("ACP session configuration drifted during setup");
  }
  assertReviewedSelectors(current, mapping);
}

function encodeContinuation(vendorSessionId: string, cwd: string): Uint8Array {
  const payload = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    vendorSessionId,
    cwd,
  }), "utf8");
  if (payload.byteLength > 4_096) {
    throw new RuntimeBoundError("ACP continuation payload limit exceeded");
  }
  return payload;
}

function decodeContinuation(payload: Uint8Array): {
  readonly vendorSessionId: string;
  readonly cwd: string;
} {
  if (payload.byteLength === 0 || payload.byteLength > 4_096) {
    throw new RuntimePreflightError("ACP continuation payload is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown;
  } catch {
    throw new RuntimePreflightError("ACP continuation payload is invalid");
  }
  try {
    const continuation = continuationPayloadSchema.parse(parsed);
    if (!path.isAbsolute(continuation.cwd)) {
      throw new RuntimePreflightError("ACP continuation payload is invalid");
    }
    return continuation;
  } catch (error) {
    if (error instanceof RuntimePreflightError) throw error;
    throw new RuntimePreflightError("ACP continuation payload is invalid");
  }
}

function safePermissionId(toolCallId: string, requestId: string | number | null): string {
  return `acp-permission-${createHash("sha256")
    .update(`${toolCallId}\0${String(requestId)}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function approvalAction(
  request: RequestPermissionRequest,
  cwd: string,
): RuntimeApprovalRequest["action"] {
  const title = request.toolCall.title ?? "";
  if (/credential|api.?key|token|secret|password|cookie/iu.test(title)) {
    return "credential";
  }
  const paths = request.toolCall.locations?.map((location) => location.path) ?? [];
  if (paths.some((candidate) => {
    if (!path.isAbsolute(candidate)) return true;
    const relative = path.relative(cwd, path.resolve(candidate));
    return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  })) {
    return "external_path";
  }
  switch (request.toolCall.kind ?? "other") {
    case "read":
    case "search":
      return "read";
    case "edit":
    case "delete":
    case "move":
      return "write";
    case "execute":
      return "shell";
    case "fetch":
      return "network";
    default:
      return "unknown";
  }
}

function permissionResource(request: RequestPermissionRequest, cwd: string): string {
  const paths = request.toolCall.locations
    ?.map((location) => {
      if (!path.isAbsolute(location.path)) return null;
      const relative = path.relative(cwd, path.resolve(location.path));
      if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        return null;
      }
      return relative.split(path.sep).join("/");
    })
    .filter((candidate): candidate is string => candidate !== null) ?? [];
  return [...new Set(paths)].sort().join(", ") || "ACP delegated tool";
}

async function bridgePermission(
  params: RequestPermissionRequest,
  requestId: string | number | null,
  sessionId: string,
  cwd: string,
  host: AgentRuntimeHost,
  signal: AbortSignal,
  handlerSignal: AbortSignal,
): Promise<RequestPermissionResponse> {
  if (params.sessionId !== sessionId || params.options.length === 0 || params.options.length > 16) {
    throw new AcpUpdateError("ACP permission request is invalid");
  }
  if (
    containsSecretCanary(params.toolCall.title ?? "") ||
    (params.toolCall.locations ?? []).some((location) =>
      containsSecretCanary(location.path)
    ) ||
    params.options.some((option) =>
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(option.optionId) ||
      containsSecretCanary(option.optionId) ||
      option.name.length === 0 ||
      option.name.length > 256 ||
      containsSecretCanary(option.name)
    )
  ) {
    throw new AcpUpdateError("ACP permission request contained unsafe display data");
  }
  const ids = new Set(params.options.map((option) => option.optionId));
  if (ids.size !== params.options.length) {
    throw new AcpUpdateError("ACP permission option IDs are not unique");
  }
  const action = approvalAction(params, cwd);
  const approval: RuntimeApprovalRequest = {
    requestId: safePermissionId(params.toolCall.toolCallId, requestId),
    action,
    resource: permissionResource(params, cwd),
    risk: action === "unknown" || action === "external_path" || action === "credential"
      ? "elevated"
      : params.toolCall.kind === "delete"
        ? "destructive"
        : "normal",
    summary: `ACP agent requests ${action.replace("_", " ")} permission`,
    options: params.options.map((option) => ({
      optionId: option.optionId,
      name: option.name,
      kind: option.kind,
    })),
  };

  if (typeof host.requestApproval !== "function" || signal.aborted || handlerSignal.aborted) {
    return { outcome: { outcome: "cancelled" } };
  }
  let finishCancellation: (() => void) | null = null;
  const cancelled = new Promise<{ outcome: "cancelled" }>((resolve) => {
    finishCancellation = () => resolve({ outcome: "cancelled" });
  });
  const onCancelled = (): void => finishCancellation?.();
  signal.addEventListener("abort", onCancelled, { once: true });
  handlerSignal.addEventListener("abort", onCancelled, { once: true });
  if (signal.aborted || handlerSignal.aborted) onCancelled();
  let decision: Awaited<ReturnType<NonNullable<AgentRuntimeHost["requestApproval"]>>>;
  try {
    decision = await Promise.race([host.requestApproval(approval), cancelled]);
  } finally {
    signal.removeEventListener("abort", onCancelled);
    handlerSignal.removeEventListener("abort", onCancelled);
    finishCancellation = null;
  }
  if (decision.outcome === "cancelled") {
    return { outcome: { outcome: "cancelled" } };
  }
  if (!ids.has(decision.optionId)) {
    throw new AcpUpdateError("ACP host selected an option that was not offered");
  }
  return { outcome: { outcome: "selected", optionId: decision.optionId } };
}

async function initializeConnection(
  context: ClientContext,
  profile: AcpRuntimeProfile,
  process: ManagedAcpProcess,
): Promise<InitializeResponse> {
  const response = await raceTransport(
    withTimeout(
      context.request(methods.agent.initialize, {
        protocolVersion: profile.protocolVersion,
        clientCapabilities: {},
        clientInfo: profile.clientInfo,
      }),
      profile.bounds.startupTimeoutMs,
      "prompt",
    ),
    process,
  );
  return parseInitialize(response, profile);
}

async function boundedClose(
  connection: ClientConnection | null,
  context: ClientContext | null,
  process: ManagedAcpProcess | null,
  sessionId: string | null,
  supportsClose: boolean,
  timeoutMs: number,
  strict: boolean,
): Promise<void> {
  let closeError: unknown = null;
  if (context && process && sessionId && supportsClose) {
    try {
      const response = await raceTransport(
        withTimeout(
          context.request(methods.agent.session.close, { sessionId }),
          timeoutMs,
          "shutdown",
        ),
        process,
      );
      emptyResponseSchema.parse(response);
    } catch (error) {
      closeError = error;
    }
  }
  connection?.close();
  if (process) {
    try {
      await process.shutdown();
    } catch (error) {
      closeError ??= error;
    }
  }
  if (strict && closeError) throw closeError;
}

export class ManagedAcpRuntime implements AgentRuntime {
  readonly adapterId: string;
  readonly connectionId: string;
  readonly capabilities: RuntimeCapabilities;
  readonly capabilityProfileRevision: string;
  readonly #sessionBinding: AcpRuntimeSessionBinding | null;

  constructor(
    readonly profile: AcpRuntimeProfile,
    private readonly runtimeStore: RuntimeContinuationStore,
    sessionBinding: AcpRuntimeSessionBinding | null = null,
  ) {
    this.profile = createAcpRuntimeProfile(profile);
    this.adapterId = this.profile.adapterId;
    this.connectionId = this.profile.connectionId;
    this.capabilities = this.profile.capabilities;
    this.capabilityProfileRevision = this.profile.capabilityProfileRevision;
    if (
      sessionBinding !== null &&
      (!/^[a-z][a-z0-9._/-]{0,127}$/u.test(sessionBinding.extensionMethod) ||
        containsSecretCanary(sessionBinding.extensionMethod) ||
        containsSecretCanary(sessionBinding.expectedAgentInfo.name) ||
        containsSecretCanary(sessionBinding.expectedAgentInfo.version))
    ) {
      throw new TypeError("ACP runtime session binding is invalid");
    }
    this.#sessionBinding = sessionBinding === null
      ? null
      : Object.freeze({
          expectedAgentInfo: Object.freeze({ ...sessionBinding.expectedAgentInfo }),
          extensionMethod: sessionBinding.extensionMethod,
          evaluate: sessionBinding.evaluate,
        });
  }

  run(request: AgentRunRequest, host: AgentRuntimeHost): AsyncIterable<AgentRuntimeEvent> {
    return this.runEvents(request, host);
  }

  async reconcile(input: {
    readonly continuation: RuntimeContinuationHandle;
    readonly reader: ContinuationReadCapability;
    readonly authorization: RunAuthorization & {
      readonly operation: "runtime_reconcile";
      readonly turnId: null;
    };
    readonly expectedSessionRecordSequence: number;
    readonly signal: AbortSignal;
  }): Promise<"committed" | "uncertain" | "gone"> {
    if (
      !this.profile.capabilities.resume ||
      input.signal.aborted ||
      input.authorization.connectionId !== this.profile.connectionId ||
      input.authorization.modelId !== input.continuation.modelId ||
      input.authorization.backendFingerprint !== input.continuation.backendFingerprint ||
      input.continuation.adapterId !== this.profile.adapterId ||
      input.continuation.connectionId !== this.profile.connectionId ||
      input.continuation.status !== "uncertain"
    ) {
      return "uncertain";
    }
    const continuationPayload = decodeContinuation(await this.runtimeStore.load({
      reader: input.reader,
      handle: input.continuation,
    }));
    if (input.signal.aborted) return "uncertain";
    const { vendorSessionId } = continuationPayload;
    let managed: ManagedAcpProcess | null = null;
    let connection: ClientConnection | null = null;
    let context: ClientContext | null = null;
    let supportsClose = false;
    try {
      managed = await spawnManagedAcpProcess({
        command: this.profile.command,
        args: this.profile.args,
        allowedEnvironmentKeys: this.profile.allowedEnvironmentKeys,
        bounds: this.profile.bounds,
        signal: input.signal,
      });
      connection = client({ name: "recurs" }).connect(
        sanitizeAcpStream(managed.stream, false),
      );
      context = connection.agent;
      const initialized = await initializeConnection(context, this.profile, managed);
      const inspection = inspectionFromInitialize(initialized);
      supportsClose = inspection.sessionCapabilities.close;
      if (!inspection.sessionCapabilities.resume) return "uncertain";
      await verifySessionBinding(
        context,
        initialized,
        managed,
        this.#sessionBinding,
        input.signal,
        this.profile.bounds.startupTimeoutMs,
      );
      managed.detachAbortSignal();
      const response = await requestSessionOperation(
        (cancellationSignal) =>
          context!.request(methods.agent.session.resume, {
            sessionId: vendorSessionId,
            cwd: continuationPayload.cwd,
            additionalDirectories: [],
            mcpServers: [],
          }, { cancellationSignal }),
        input.signal,
        context,
        managed,
        vendorSessionId,
        this.profile.bounds.promptTimeoutMs,
        this.profile.bounds.cancelSettlementTimeoutMs,
      );
      sessionStateSchema.parse(response);
      return "uncertain";
    } catch (error) {
      if (error instanceof RequestError && error.code === -32002) return "gone";
      return "uncertain";
    } finally {
      await boundedClose(
        connection,
        context,
        managed,
        vendorSessionId,
        supportsClose && !input.signal.aborted,
        this.profile.bounds.shutdownTimeoutMs,
        false,
      );
    }
  }

  private async *runEvents(
    request: AgentRunRequest,
    host: AgentRuntimeHost,
  ): AsyncGenerator<AgentRuntimeEvent> {
    const channel = new RuntimeEventChannel(this.profile.bounds);
    let mapping: AcpSessionMapping;
    try {
      mapping = ensureRequestPreflight(this.profile, request);
    } catch (error) {
      yield { type: "failed", failure: mapFailure(error, "preflight") };
      return;
    }

    const work = this.executeRun(request, host, mapping, channel);
    try {
      for await (const event of channel) yield event;
      await work;
    } finally {
      await work.catch(() => undefined);
    }
  }

  private async executeRun(
    request: AgentRunRequest,
    host: AgentRuntimeHost,
    mapping: AcpSessionMapping,
    channel: RuntimeEventChannel,
  ): Promise<void> {
    let managed: ManagedAcpProcess | null = null;
    let connection: ClientConnection | null = null;
    let context: ClientContext | null = null;
    let sessionId: string | null = null;
    let supportsClose = false;
    let continuation: RuntimeContinuationHandle | undefined;
    let finalText = "";
    let terminal: AgentRuntimeEvent | null = null;
    let promptActive = false;
    let promptIssued = false;
    let callbackFailure: unknown = null;
    let activeCallbacks = 0;
    let resolveCallbackDrain: (() => void) | null = null;
    let callbackDrain: Promise<void> = Promise.resolve();
    const beginCallback = (): (() => void) => {
      if (activeCallbacks === 0) {
        callbackDrain = new Promise<void>((resolve) => {
          resolveCallbackDrain = resolve;
        });
      }
      activeCallbacks += 1;
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        activeCallbacks -= 1;
        if (activeCallbacks === 0) {
          resolveCallbackDrain?.();
          resolveCallbackDrain = null;
        }
      };
    };
    const activities = new Map();
    const approvalCancellation = new AbortController();
    const cancelApprovals = (): void => {
      if (!approvalCancellation.signal.aborted) approvalCancellation.abort();
    };
    request.signal.addEventListener("abort", cancelApprovals, { once: true });
    if (request.signal.aborted) cancelApprovals();

    try {
      managed = await spawnManagedAcpProcess({
        command: this.profile.command,
        args: this.profile.args,
        allowedEnvironmentKeys: this.profile.allowedEnvironmentKeys,
        bounds: this.profile.bounds,
        signal: request.signal,
      });

      const app = client({ name: "recurs" })
        .onRequest(methods.client.session.requestPermission, async (handler) => {
          const finishCallback = beginCallback();
          try {
            if (!promptActive || sessionId === null) {
              throw new AcpUpdateError("ACP permission arrived outside an active prompt");
            }
            return await bridgePermission(
              handler.params,
              handler.requestId,
              sessionId,
              request.cwd,
              host,
              approvalCancellation.signal,
              handler.signal,
            );
          } catch (error) {
            callbackFailure ??= error;
            return { outcome: { outcome: "cancelled" as const } };
          } finally {
            finishCallback();
          }
        })
        .onNotification(methods.client.session.update, (handler) => {
          const finishCallback = beginCallback();
          try {
            if (callbackFailure !== null) return;
            if (!promptActive || sessionId === null) {
              throw new AcpUpdateError("ACP update arrived outside an active prompt");
            }
            const translated = translateAcpUpdate(handler.params, {
              sessionId,
              cwd: request.cwd,
              expectedModeId: mapping.modeId,
              expectedConfigOptions: mapping.configOptions,
              emitFileEvents: this.profile.capabilities.fileEvents,
              activities,
            });
            for (const event of translated) {
              if (event.type === "text_delta") finalText += event.text;
              channel.push(event);
            }
          } catch (error) {
            callbackFailure ??= error;
          } finally {
            finishCallback();
          }
        });

      connection = app.connect(sanitizeAcpStream(managed.stream, true));
      context = connection.agent;
      const initialized = await initializeConnection(context, this.profile, managed);
      const inspection = inspectionFromInitialize(initialized);
      supportsClose = inspection.sessionCapabilities.close;
      if (this.profile.capabilities.resume && !inspection.sessionCapabilities.resume) {
        throw new RuntimePreflightError("ACP agent did not advertise reviewed resume support");
      }
      let state: NewSessionResponse | ResumeSessionResponse;
      if (request.continuation !== null) {
        if (request.continuationReader === null || !inspection.sessionCapabilities.resume) {
          throw new RuntimePreflightError("ACP continuation cannot be resumed");
        }
        const continuationPayload = decodeContinuation(await this.runtimeStore.load({
          reader: request.continuationReader,
          handle: request.continuation,
        }));
        if (request.signal.aborted) throw new RuntimeCancelledError();
        if (path.resolve(continuationPayload.cwd) !== path.resolve(request.cwd)) {
          throw new RuntimePreflightError("ACP continuation belongs to another workspace");
        }
        await verifySessionBinding(
          context,
          initialized,
          managed,
          this.#sessionBinding,
          request.signal,
          this.profile.bounds.startupTimeoutMs,
        );
        sessionId = continuationPayload.vendorSessionId;
        managed.detachAbortSignal();
        const response = await requestSessionOperation(
          (cancellationSignal) =>
            context!.request(methods.agent.session.resume, {
              sessionId,
              cwd: request.cwd,
              additionalDirectories: [],
              mcpServers: [],
            }, { cancellationSignal }),
          request.signal,
          context,
          managed,
          sessionId,
          this.profile.bounds.promptTimeoutMs,
          this.profile.bounds.cancelSettlementTimeoutMs,
        );
        state = sessionStateSchema.parse(response) as ResumeSessionResponse;
      } else {
        await verifySessionBinding(
          context,
          initialized,
          managed,
          this.#sessionBinding,
          request.signal,
          this.profile.bounds.startupTimeoutMs,
        );
        const response = await raceTransport(
          withTimeout(
            context.request(methods.agent.session.new, {
              cwd: request.cwd,
              additionalDirectories: [],
              mcpServers: [],
            }),
            this.profile.bounds.promptTimeoutMs,
            "prompt",
          ),
          managed,
        );
        const parsed = newSessionResponseSchema.parse(response);
        sessionId = parsed.sessionId;
        managed.detachAbortSignal();
        state = parsed as NewSessionResponse;
      }

      await enforceSessionMapping(
        context,
        sessionId,
        state,
        mapping,
        managed,
        this.profile.bounds.promptTimeoutMs,
        this.profile.bounds.cancelSettlementTimeoutMs,
        request.signal,
      );

      await verifySessionBinding(
        context,
        initialized,
        managed,
        this.#sessionBinding,
        request.signal,
        this.profile.bounds.startupTimeoutMs,
        {
          sessionId,
          cancelSettlementTimeoutMs:
            this.profile.bounds.cancelSettlementTimeoutMs,
        },
      );

      if (request.signal.aborted) {
        await sendSessionCancellation(
          context,
          managed,
          sessionId,
          this.profile.bounds.cancelSettlementTimeoutMs,
        );
        throw new RuntimeCancelledError();
      }
      continuation = await this.runtimeStore.put({
        writer: request.continuationWriter,
        payload: encodeContinuation(sessionId, request.cwd),
      });
      validateStagedContinuation(continuation, this.profile, request);
      channel.push({ type: "continuation_updated", continuation });

      if (request.signal.aborted) {
        await sendSessionCancellation(
          context,
          managed,
          sessionId,
          this.profile.bounds.cancelSettlementTimeoutMs,
        );
        terminal = {
          type: "cancelled",
          reason: "The delegated runtime turn was cancelled",
          continuation,
        };
      } else {
        promptIssued = true;
        promptActive = true;
        const requestCancellation = new AbortController();
        const promptPromise = context.request(
          methods.agent.session.prompt,
          {
            sessionId,
            prompt: [{ type: "text", text: request.prompt }],
          },
          { cancellationSignal: requestCancellation.signal },
        );
        let resolveAbort: (() => void) | null = null;
        const abortPromise = new Promise<"aborted">((resolve) => {
          resolveAbort = () => resolve("aborted");
        });
        const onPromptAbort = (): void => resolveAbort?.();
        request.signal.addEventListener("abort", onPromptAbort, { once: true });
        if (request.signal.aborted) onPromptAbort();
        let promptTimer: ReturnType<typeof setTimeout> | null = null;
        const promptTimeout = new Promise<"timeout">((resolve) => {
          promptTimer = setTimeout(
            () => resolve("timeout"),
            this.profile.bounds.promptTimeoutMs,
          );
          promptTimer.unref?.();
        });
        let outcome:
          | { readonly kind: "response"; readonly value: unknown }
          | { readonly kind: "aborted" }
          | { readonly kind: "timeout" };
        try {
          outcome = await Promise.race([
            raceTransport(promptPromise, managed).then((value) => ({
              kind: "response" as const,
              value,
            })),
            abortPromise.then(() => ({ kind: "aborted" as const })),
            promptTimeout.then(() => ({ kind: "timeout" as const })),
          ]);
        } finally {
          request.signal.removeEventListener("abort", onPromptAbort);
          resolveAbort = null;
          if (promptTimer !== null) clearTimeout(promptTimer);
        }

        let rawResponse: unknown;
        if (outcome.kind === "response") {
          rawResponse = outcome.value;
        } else {
          cancelApprovals();
          requestCancellation.abort(new Error("ACP prompt cancelled"));
          await raceTransport(
            withTimeout(
              context.notify(methods.agent.session.cancel, { sessionId }),
              this.profile.bounds.cancelSettlementTimeoutMs,
              "cancel",
            ),
            managed,
          );
          try {
            rawResponse = await raceTransport(
              withTimeout(
                promptPromise,
                this.profile.bounds.cancelSettlementTimeoutMs,
                "cancel",
              ),
              managed,
            );
          } catch (error) {
            if (outcome.kind === "timeout") throw new RuntimeTimeoutError("prompt");
            throw error;
          }
        }
        const response = promptResponseSchema.parse(rawResponse);
        promptActive = false;
        cancelApprovals();
        await withTimeout(
          callbackDrain,
          this.profile.bounds.cancelSettlementTimeoutMs,
          "cancel",
        );
        if (callbackFailure !== null) throw callbackFailure;
        if ((request.signal.aborted || outcome.kind === "aborted") && response.stopReason !== "cancelled") {
          throw new AcpTransportError("ACP cancellation settled with a normal completion");
        }
        if (outcome.kind === "timeout") throw new RuntimeTimeoutError("prompt");

        if (this.profile.usageSemantics === "prompt_response" && response.usage) {
          channel.push({
            type: "usage",
            usage: {
              inputTokens: response.usage.inputTokens,
              outputTokens: response.usage.outputTokens,
              ...(response.usage.thoughtTokens == null
                ? {}
                : { reasoningTokens: response.usage.thoughtTokens }),
              ...(response.usage.cachedReadTokens == null
                ? {}
                : { cachedInputTokens: response.usage.cachedReadTokens }),
              ...(response.usage.cachedWriteTokens == null
                ? {}
                : { cacheWriteInputTokens: response.usage.cachedWriteTokens }),
            },
          });
        }
        switch (response.stopReason) {
          case "end_turn":
            terminal = {
              type: "done",
              finalText,
              stopReason: "complete",
              continuation,
            };
            break;
          case "max_tokens":
          case "max_turn_requests":
            terminal = {
              type: "done",
              finalText,
              stopReason: "length",
              continuation,
            };
            break;
          case "cancelled":
            terminal = {
              type: "cancelled",
              reason: "The delegated runtime turn was cancelled",
              continuation,
            };
            break;
          case "refusal":
            terminal = {
              type: "failed",
              failure: failure(
                "started",
                "runtime",
                "runtime_failed",
                "The delegated runtime refused the request",
              ),
              continuation,
            };
            break;
        }
      }

      if (callbackFailure !== null) throw callbackFailure;
      await boundedClose(
        connection,
        context,
        managed,
        sessionId,
        supportsClose && !request.signal.aborted,
        this.profile.bounds.shutdownTimeoutMs,
        true,
      );
      connection = null;
      context = null;
      managed = null;
      await withTimeout(
        callbackDrain,
        this.profile.bounds.cancelSettlementTimeoutMs,
        "cancel",
      );
      if (callbackFailure !== null) throw callbackFailure;
      if (!terminal) throw new AcpTransportError("ACP prompt ended without a terminal result");
      channel.finish(terminal, terminalBoundFallback());
    } catch (error) {
      promptActive = false;
      cancelApprovals();
      if (
        request.signal.aborted &&
        !promptIssued &&
        context !== null &&
        managed !== null &&
        sessionId !== null &&
        !(error instanceof RuntimeCancelledError)
      ) {
        await sendSessionCancellation(
          context,
          managed,
          sessionId,
          this.profile.bounds.cancelSettlementTimeoutMs,
        );
      }
      await boundedClose(
        connection,
        context,
        managed,
        sessionId,
        supportsClose && !request.signal.aborted,
        this.profile.bounds.shutdownTimeoutMs,
        false,
      );
      await withTimeout(
        callbackDrain,
        this.profile.bounds.cancelSettlementTimeoutMs,
        "cancel",
      ).catch(() => undefined);
      const mapped = request.signal.aborted && !promptIssued
        ? failure(
            "started",
            "runtime",
            "cancelled",
            "The delegated runtime was cancelled",
          )
        : mapFailure(error, "started");
      if (mapped.code === "cancelled") {
        channel.finish({
          type: "cancelled",
          reason: "The delegated runtime turn was cancelled",
          ...(continuation === undefined ? {} : { continuation }),
        }, terminalBoundFallback());
      } else {
        channel.finish({
          type: "failed",
          failure: mapped,
          ...(continuation === undefined ? {} : { continuation }),
        }, terminalBoundFallback());
      }
    } finally {
      request.signal.removeEventListener("abort", cancelApprovals);
    }
  }
}

async function withAcpInspectionConnection<T>(
  profileInput: AcpRuntimeProfile,
  signal: AbortSignal,
  operation: (
    context: ClientContext,
    initialized: InitializeResponse,
    process: ManagedAcpProcess,
  ) => Promise<T>,
): Promise<T> {
  const profile = createAcpRuntimeProfile(profileInput);
  if (signal.aborted) throw new AcpTransportError("ACP operation was cancelled");
  let managed: ManagedAcpProcess | null = null;
  let connection: ClientConnection | null = null;
  try {
    managed = await spawnManagedAcpProcess({
      command: profile.command,
      args: profile.args,
      allowedEnvironmentKeys: profile.allowedEnvironmentKeys,
      bounds: profile.bounds,
      signal,
    });
    const app = client({ name: "recurs" })
      .onRequest(methods.client.session.requestPermission, () => ({
        outcome: { outcome: "cancelled" },
      }))
      .onNotification(methods.client.session.update, () => undefined);
    connection = app.connect(sanitizeAcpStream(managed.stream, false));
    const initialized = await initializeConnection(connection.agent, profile, managed);
    return await operation(connection.agent, initialized, managed);
  } finally {
    connection?.close();
    if (managed) await managed.shutdown();
  }
}

function normalizePublicAcpError(error: unknown): unknown {
  if (error instanceof z.ZodError) {
    return new AcpOperationError("request_rejected");
  }
  if (!(error instanceof RequestError)) return error;
  if (error.code === -32000) return new AcpOperationError("authentication_required");
  if (error.code === -32800) return new AcpOperationError("cancelled");
  if (error.code === -32002) return new AcpOperationError("session_unavailable");
  return new AcpOperationError("request_rejected");
}

async function runPublicAcpOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw normalizePublicAcpError(error);
  }
}

export async function inspectAcpRuntime(
  profile: AcpRuntimeProfile,
  signal: AbortSignal,
): Promise<AcpRuntimeInspection> {
  return await runPublicAcpOperation(() =>
    withAcpInspectionConnection(
      profile,
      signal,
      async (_context, initialized) => inspectionFromInitialize(initialized),
    ),
  );
}

export async function authenticateAcpRuntime(
  profile: AcpRuntimeProfile,
  advertisedMethodId: string,
  signal: AbortSignal,
): Promise<AcpAuthenticationResult> {
  return await runPublicAcpOperation(() =>
    withAcpInspectionConnection(
      profile,
      signal,
      async (context, initialized, process) => {
        const inspection = inspectionFromInitialize(initialized);
        const method = (initialized.authMethods ?? []).find(
          (candidate: AuthMethod) => candidate.id === advertisedMethodId,
        );
        if (!method) {
          throw new TypeError("ACP authentication method was not advertised");
        }
        if ("type" in method) {
          throw new TypeError(
            "ACP authentication method requires an unsupported credential channel",
          );
        }
        const response = await raceTransport(
          withTimeout(
            context.request(methods.agent.authenticate, {
              methodId: advertisedMethodId,
            }),
            profile.bounds.promptTimeoutMs,
            "prompt",
          ),
          process,
        );
        authResponseSchema.parse(response);
        return deepFreeze({
          ...inspection,
          authenticatedMethodId: advertisedMethodId,
        });
      },
    ),
  );
}

export async function inspectAcpRuntimeExtension<T>(
  profile: AcpRuntimeProfile,
  method: string,
  parse: (value: unknown) => T,
  signal: AbortSignal,
): Promise<T> {
  if (
    !/^[a-z][a-z0-9._/-]{0,127}$/u.test(method) ||
    containsSecretCanary(method)
  ) {
    throw new TypeError("ACP extension method is invalid");
  }
  return await runPublicAcpOperation(() =>
    withAcpInspectionConnection(
      profile,
      signal,
      async (context, _initialized, process) => {
        const response = await raceTransport(
          withTimeout(
            context.request<unknown, Record<string, never>>(method, {}),
            profile.bounds.promptTimeoutMs,
            "prompt",
          ),
          process,
        );
        return parse(response);
      },
    ),
  );
}

export async function probeAcpRuntimeMapping(
  profile: AcpRuntimeProfile,
  cwd: string,
  selectMapping: (state: NewSessionResponse) => AcpSessionMapping,
  signal: AbortSignal,
): Promise<AcpSessionMapping> {
  if (!path.isAbsolute(cwd) || cwd.includes("\0")) {
    throw new TypeError("ACP probe cwd must be absolute");
  }
  return await runPublicAcpOperation(() =>
    withAcpInspectionConnection(
      profile,
      signal,
      async (context, initialized, process) => {
        const inspection = inspectionFromInitialize(initialized);
        if (!inspection.sessionCapabilities.close) {
          throw new RuntimePreflightError(
            "ACP probe requires session close capability",
          );
        }
        let sessionId: string | null = null;
        let operationError: unknown = null;
        let result: AcpSessionMapping | null = null;
        try {
          const response = await raceTransport(
            withTimeout(
              context.request(methods.agent.session.new, {
                cwd,
                additionalDirectories: [],
                mcpServers: [],
              }),
              profile.bounds.promptTimeoutMs,
              "prompt",
            ),
            process,
          );
          const state = newSessionResponseSchema.parse(response) as NewSessionResponse;
          sessionId = state.sessionId;
          process.detachAbortSignal();
          const selected = selectMapping(structuredClone(state));
          const reviewed = createAcpRuntimeProfile({
            ...profile,
            mappings: [selected],
          }).mappings[0];
          if (reviewed === undefined) {
            throw new RuntimePreflightError("ACP probe mapping is missing");
          }
          await enforceSessionMapping(
            context,
            sessionId,
            state,
            reviewed,
            process,
            profile.bounds.promptTimeoutMs,
            profile.bounds.cancelSettlementTimeoutMs,
            signal,
          );
          result = deepFreeze(structuredClone(reviewed));
        } catch (error) {
          operationError = error;
        }
        if (sessionId !== null && !signal.aborted) {
          try {
            const response = await raceTransport(
              withTimeout(
                context.request(methods.agent.session.close, { sessionId }),
                profile.bounds.shutdownTimeoutMs,
                "shutdown",
              ),
              process,
            );
            emptyResponseSchema.parse(response);
          } catch (error) {
            operationError ??= error;
          }
        }
        if (operationError !== null) throw operationError;
        if (result === null) {
          throw new RuntimePreflightError("ACP probe did not produce a mapping");
        }
        return result;
      },
    ),
  );
}
