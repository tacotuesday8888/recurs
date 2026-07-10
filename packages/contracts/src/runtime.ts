import type { BillingSelectionMode, SessionBackendPin } from "./connections.js";
import type { IntegrationFailure } from "./failures.js";
import type { JsonValue } from "./json.js";
import type { ModelProvider, ProviderUsage, ToolCall } from "./model.js";

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
  kind: "run";
  id: string;
  operation: "run" | "compact" | "runtime_reconcile";
  sessionId: string;
  operationId: string;
  turnId: string | null;
  connectionId: string;
  modelId: string;
  backendFingerprint: string;
  connectionRevision: number;
  policyRevision: string;
  billingMode: BillingSelectionMode;
  billingSelectionDigest: string;
  contextDigest: string;
  maxRequests: number;
  expiresAt: string;
}

export interface RuntimeContinuationHandle {
  kind: "runtime";
  id: string;
  storageClass: "persistent_broker" | "process_scoped";
  ownerInstanceId?: string;
  expiresAt?: string;
  recursSessionId: string;
  connectionId: string;
  adapterId: string;
  modelId: string;
  backendFingerprint: string;
  stateVersion: number;
  originTurnId: string;
  continuationSequence: number;
  status: "committed" | "uncertain";
  vendorTurnSequence: number;
}

export interface AgentRunRequest {
  sessionId: string;
  turnId: string;
  prompt: string;
  cwd: string;
  modelId: string;
  executionMode: "act" | "plan";
  permissionMode: "ask_always" | "approved_for_me" | "full_access";
  authorization: RunAuthorization;
  continuation: RuntimeContinuationHandle | null;
  signal: AbortSignal;
}

export interface RuntimeApprovalRequest {
  requestId: string;
  action:
    | "read"
    | "write"
    | "shell"
    | "network"
    | "external_path"
    | "sensitive"
    | "credential"
    | "deploy"
    | "unknown";
  resource: string;
  risk: "normal" | "elevated" | "destructive";
  summary: string;
  details?: Readonly<Record<string, JsonValue>>;
}

export type RuntimeApprovalDecision =
  | "allow_once"
  | "allow_session"
  | "deny"
  | "cancel";

export interface AgentRuntimeHost {
  requestApproval(request: RuntimeApprovalRequest): Promise<RuntimeApprovalDecision>;
  executeTool(call: ToolCall, signal: AbortSignal): Promise<{ output: string }>;
}

export type AgentRuntimeEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "usage"; usage: ProviderUsage }
  | { type: "done"; finalText: string; stopReason: "complete" | "length" }
  | { type: "cancelled"; reason: string }
  | { type: "failed"; failure: IntegrationFailure };

export interface AgentRuntime {
  readonly adapterId: string;
  readonly connectionId: string;
  run(
    request: AgentRunRequest,
    host: AgentRuntimeHost,
  ): AsyncIterable<AgentRuntimeEvent>;
}

export interface RunResult {
  finalText: string;
  usage: ProviderUsage | null;
  usageSource: "provider" | "runtime" | "unavailable";
  steps: number | null;
  changedFiles: readonly string[];
  changedFilesSource: "host_tools" | "runtime" | "workspace_diff";
  evidence: readonly string[];
  evidenceSource: "host_tools" | "runtime" | "independent_verification" | "none";
}

export type RunOutcome =
  | { ok: true; result: RunResult }
  | { ok: false; failure: IntegrationFailure };

export interface CoordinatedRunInput {
  sessionId: string;
  expectedSessionRecordSequence: number;
  prompt: string;
  invocation: HostInvocation;
  executionMode?: "act" | "plan";
  signal: AbortSignal;
}

export interface ResolvedBackendBase {
  pin: SessionBackendPin;
  authorization: RunAuthorization;
}

export type ResolvedBackend =
  | (ResolvedBackendBase & {
      kind: "direct";
      createProvider(signal: AbortSignal): Promise<ModelProvider>;
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
