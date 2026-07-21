import type { BillingSelectionMode, SessionBackendPin } from "./connections.js";
import type { IntegrationFailure } from "./failures.js";
import type { JsonValue } from "./json.js";
import type {
  ConnectionBoundModelProvider,
  ModelImageInput,
  ProviderUsage,
  ToolCall,
} from "./model.js";

const hostInvocationBrand: unique symbol = Symbol("HostInvocation");

export interface HostInvocationInput {
  invocation: "repl" | "one_shot" | "goal";
  userPresent: boolean;
  remote: boolean;
  scripted: boolean;
  embedding: "cli" | "desktop" | "sdk" | "ci";
}

export interface HostInvocation extends HostInvocationInput {
  readonly [hostInvocationBrand]: true;
}

export interface TrustedRunContext {
  invocation: "repl" | "one_shot" | "goal";
  presence: "present" | "unattended";
  location: "local" | "remote";
  automation: "manual" | "scripted";
  embedding: "cli" | "desktop" | "sdk" | "ci";
}

export function createHostInvocation(input: HostInvocationInput): HostInvocation {
  return Object.freeze({ ...input, [hostInvocationBrand]: true as const });
}

export function deriveTrustedRunContext(
  input: HostInvocation,
): TrustedRunContext {
  if (input[hostInvocationBrand] !== true) {
    throw new TypeError("Run context must come from a trusted host invocation");
  }
  return Object.freeze({
    invocation: input.invocation,
    presence: input.userPresent ? "present" : "unattended",
    location: input.remote ? "remote" : "local",
    automation: input.scripted ? "scripted" : "manual",
    embedding: input.embedding,
  });
}

export interface RunAuthorization {
  readonly kind: "run";
  readonly id: string;
  readonly operation: "run" | "compact" | "runtime_reconcile";
  readonly sessionId: string;
  readonly operationId: string;
  readonly turnId: string | null;
  readonly connectionId: string;
  readonly modelId: string;
  readonly backendFingerprint: string;
  readonly connectionRevision: number;
  readonly policyRevision: string;
  readonly billingMode: BillingSelectionMode;
  readonly billingSelectionDigest: string;
  readonly contextDigest: string;
  readonly maxRequests: number;
  readonly expiresAt: string;
}

export interface RuntimeContinuationHandle {
  readonly kind: "runtime";
  readonly id: string;
  readonly storageClass: "persistent_broker" | "process_scoped";
  readonly ownerInstanceId?: string;
  readonly expiresAt?: string;
  readonly recursSessionId: string;
  readonly connectionId: string;
  readonly adapterId: string;
  readonly modelId: string;
  readonly backendFingerprint: string;
  readonly stateVersion: number;
  readonly originTurnId: string;
  readonly continuationSequence: number;
  readonly status: "committed" | "uncertain";
  readonly vendorTurnSequence: number;
}

export interface ContinuationWriteCapability {
  readonly id: string;
  readonly expiresAt: string;
}

export interface ContinuationReadCapability {
  readonly id: string;
  readonly expiresAt: string;
}

export interface RuntimeContinuationWriterRequest {
  readonly authorization: RunAuthorization;
  readonly pin: SessionBackendPin & { readonly kind: "agent_runtime" };
  readonly expectedSessionRecordSequence: number;
  readonly previous: RuntimeContinuationHandle | null;
  readonly stateVersion: number;
}

export interface RuntimeContinuationReaderRequest {
  readonly authorization: RunAuthorization;
  readonly pin: SessionBackendPin & { readonly kind: "agent_runtime" };
  readonly expectedSessionRecordSequence: number;
  readonly purpose: "run" | "reconcile";
  readonly activeHandles: readonly RuntimeContinuationHandle[];
}

export type RuntimeContinuationFinalizationOutcome = "committed" | "gone";

export interface RuntimeContinuationFinalizationReceipt {
  readonly kind: "runtime_continuation_finalization";
  readonly id: string;
  readonly ownerInstanceId: string;
  readonly authorizationId: string;
  readonly sessionId: string;
  readonly backendFingerprint: string;
  readonly continuationId: string;
  readonly continuationSequence: number;
  readonly expectedSessionRecordSequence: number;
  readonly outcome: RuntimeContinuationFinalizationOutcome;
  readonly expiresAt: string;
}

export interface RuntimeContinuationFinalization {
  readonly receipt: RuntimeContinuationFinalizationReceipt;
  readonly activeHandle: RuntimeContinuationHandle | null;
}

export interface RuntimeContinuationAuthority {
  readonly ownerInstanceId: string;
  mintWriter(
    input: RuntimeContinuationWriterRequest,
  ): Promise<ContinuationWriteCapability>;
  mintReader(
    input: RuntimeContinuationReaderRequest,
  ): Promise<ContinuationReadCapability>;
  recoverStaged(input: {
    readonly authorization: RunAuthorization;
    readonly writer: ContinuationWriteCapability;
  }): Promise<RuntimeContinuationHandle | null>;
  prepareFinalization(input: {
    readonly authorization: RunAuthorization;
    readonly handle: RuntimeContinuationHandle;
    readonly outcome: RuntimeContinuationFinalizationOutcome;
    readonly expectedSessionRecordSequence: number;
  }): Promise<RuntimeContinuationFinalization>;
  acknowledgeFinalization(input: {
    readonly authorization: RunAuthorization;
    readonly receipt: RuntimeContinuationFinalizationReceipt;
    readonly durableSessionRecordSequence: number;
  }): Promise<void>;
  release(
    capability: ContinuationReadCapability | ContinuationWriteCapability,
  ): Promise<void>;
}

export interface RuntimeContinuationStore {
  put(input: {
    readonly writer: ContinuationWriteCapability;
    readonly payload: Uint8Array;
  }): Promise<RuntimeContinuationHandle>;
  load(input: {
    readonly reader: ContinuationReadCapability;
    readonly handle: RuntimeContinuationHandle;
  }): Promise<Uint8Array>;
}

export interface AgentRunRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly modelId: string;
  readonly executionMode: "act" | "plan";
  readonly permissionMode: "ask_always" | "approved_for_me" | "full_access";
  readonly authorization: RunAuthorization;
  readonly continuationReader: ContinuationReadCapability | null;
  readonly continuationWriter: ContinuationWriteCapability;
  readonly continuation: RuntimeContinuationHandle | null;
  readonly signal: AbortSignal;
}

export interface RuntimeApprovalOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind:
    | "allow_once"
    | "allow_always"
    | "reject_once"
    | "reject_always";
}

export interface RuntimeApprovalRequest {
  readonly requestId: string;
  readonly action:
    | "read"
    | "write"
    | "shell"
    | "network"
    | "external_path"
    | "sensitive"
    | "credential"
    | "deploy"
    | "unknown";
  readonly resource: string;
  readonly risk: "normal" | "elevated" | "destructive";
  readonly summary: string;
  readonly options: readonly RuntimeApprovalOption[];
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export type RuntimeApprovalDecision =
  | { readonly outcome: "selected"; readonly optionId: string }
  | { readonly outcome: "cancelled" };

export interface AgentRuntimeHost {
  requestApproval?(request: RuntimeApprovalRequest): Promise<RuntimeApprovalDecision>;
  executeTool?(call: ToolCall, signal: AbortSignal): Promise<{ output: string }>;
}

export interface RuntimeCapabilities {
  readonly resume: boolean;
  readonly cancellation: "protocol" | "os_containment" | "unsupported";
  readonly fileEvents: boolean;
  readonly usageEvents: boolean;
  readonly supportedPermissionModes: readonly (
    | "ask_always"
    | "approved_for_me"
    | "full_access"
  )[];
  readonly approvalControl: "host" | "recurs_policy_bridge" | "none";
  readonly planMode: "enforced" | "advisory" | "unsupported";
  readonly toolExecution: "host_tools" | "recurs_os_containment" | "opaque";
  readonly checkpointing: "host_tools" | "turn_snapshot" | "none";
  readonly containmentProfileId?: string;
}

export interface RuntimeActivity {
  readonly id: string;
  readonly kind: "tool" | "command" | "file_change" | "subagent" | "other";
  readonly name: string;
  readonly status: "started" | "running" | "completed" | "failed" | "declined";
  readonly summary?: string;
}

export type AgentRuntimeEvent =
  | {
      readonly type: "continuation_updated";
      readonly continuation: RuntimeContinuationHandle;
    }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { readonly type: "activity"; readonly activity: RuntimeActivity }
  | { readonly type: "files_changed"; readonly paths: readonly string[] }
  | { readonly type: "evidence"; readonly items: readonly string[] }
  | { readonly type: "usage"; readonly usage: ProviderUsage }
  | {
      readonly type: "done";
      readonly finalText: string;
      readonly stopReason: "complete" | "length";
      readonly continuation?: RuntimeContinuationHandle;
    }
  | {
      readonly type: "cancelled";
      readonly reason: string;
      readonly continuation?: RuntimeContinuationHandle;
    }
  | {
      readonly type: "failed";
      readonly failure: IntegrationFailure;
      readonly continuation?: RuntimeContinuationHandle;
    };

export interface AgentRuntime {
  readonly adapterId: string;
  readonly connectionId: string;
  readonly capabilities: RuntimeCapabilities;
  readonly capabilityProfileRevision: string;
  run(
    request: AgentRunRequest,
    host: AgentRuntimeHost,
  ): AsyncIterable<AgentRuntimeEvent>;
  reconcile(input: {
    readonly continuation: RuntimeContinuationHandle;
    readonly reader: ContinuationReadCapability;
    readonly authorization: RunAuthorization & {
      readonly operation: "runtime_reconcile";
      readonly turnId: null;
    };
    readonly expectedSessionRecordSequence: number;
    readonly signal: AbortSignal;
  }): Promise<"committed" | "uncertain" | "gone">;
}

export interface RunResult {
  finalText: string;
  usage: ProviderUsage | null;
  usageSource: "provider" | "runtime" | "unavailable";
  steps: number | null;
  changedFiles: readonly string[];
  changedFilesSource: "host_tools" | "runtime" | "mixed" | "workspace_diff" | "none";
  evidence: readonly string[];
  evidenceSource:
    | "host_tools"
    | "runtime"
    | "mixed"
    | "independent_verification"
    | "none";
}

export type RunOutcome =
  | { ok: true; result: RunResult }
  | { ok: false; failure: IntegrationFailure };

export interface TurnSteeringInput {
  id: string;
  prompt: string;
  at: string;
}

export interface TurnSteeringDrain {
  inputs: readonly TurnSteeringInput[];
  closed: boolean;
}

/**
 * A synchronous mailbox owned by one active direct-provider turn. The terminal
 * drain closes the mailbox only when it is empty, preventing a completion race
 * from accepting input that the turn can no longer consume.
 */
export interface TurnSteeringSource {
  readonly turnId: string;
  drain(): readonly TurnSteeringInput[];
  drainOrClose(): TurnSteeringDrain;
  close(): readonly TurnSteeringInput[];
}

export interface QueuedTurnInput {
  id: string;
  prompt: string;
  at: string;
}

export const MAX_PENDING_QUEUED_TURNS = 4;
export const MAX_QUEUED_TURN_BYTES = 16 * 1024;
export const MAX_PENDING_QUEUED_TURN_BYTES = 32 * 1024;

export interface QueuedTurnDrain {
  inputs: readonly QueuedTurnInput[];
  closed: boolean;
}

export interface QueuedTurnSource {
  readonly turnId: string;
  drain(): readonly QueuedTurnInput[];
  drainOrClose(): QueuedTurnDrain;
  persisted(id: string): void;
  rejected(id: string, reason: string): void;
  close(reason?: string): readonly QueuedTurnInput[];
}

export interface CoordinatedRunInput {
  sessionId: string;
  expectedSessionRecordSequence: number;
  prompt: string;
  images?: readonly ModelImageInput[];
  invocation: HostInvocation;
  executionMode?: "act" | "plan";
  steering?: TurnSteeringSource;
  queuedTurns?: QueuedTurnSource;
  queuedInputId?: string;
  signal: AbortSignal;
}

export interface ResolvedBackendBase {
  pin: SessionBackendPin;
  authorization: RunAuthorization;
}

export type ResolvedBackend =
  | (ResolvedBackendBase & {
      kind: "direct";
      createProvider(signal: AbortSignal): Promise<ConnectionBoundModelProvider>;
    })
  | (ResolvedBackendBase & {
      kind: "delegated";
      createRuntime(signal: AbortSignal): Promise<AgentRuntime>;
    });

export interface BackendResolver {
  resolve(input: {
    operation: "run" | "compact" | "runtime_reconcile";
    operationId: string;
    sessionId: string;
    turnId: string | null;
    pin: SessionBackendPin;
    context: TrustedRunContext;
    signal: AbortSignal;
  }): Promise<ResolvedBackend>;
}

export interface CoordinatedRun {
  events: AsyncIterable<unknown>;
  outcome: Promise<RunOutcome>;
}

export interface RunCoordinator {
  start(input: CoordinatedRunInput): Promise<CoordinatedRun>;
}
