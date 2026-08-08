import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import type {
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentRuntimeHost,
  IntegrationFailure,
  ModelReasoningEffort,
  RuntimeCapabilities,
  ToolDefinition,
} from "@recurs/contracts";

import {
  GitHubCopilotSdkInstallationError,
  githubCopilotRuntimeHome,
  resolveGitHubCopilotSdk,
} from "./github-copilot-sdk-installation.js";

export const GITHUB_COPILOT_ADAPTER_ID = "github-copilot-sdk";
export const GITHUB_COPILOT_PROFILE_REVISION =
  "github-copilot-sdk-1.0.8-host-tools-v1";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SAFE_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;
const MAX_TOOLS = 128;
const MAX_TEXT_BYTES = 4 * 1_024 * 1_024;
const MAX_TOOL_OUTPUT_BYTES = 4 * 1_024 * 1_024;
const MAX_TOOL_ARGUMENT_BYTES = 1 * 1_024 * 1_024;
const MAX_SDK_EVENTS = 4_096;
const MAX_MODELS = 256;
const CLEANUP_GRACE_MILLISECONDS = 1_000;
type GitHubCopilotReasoningEffort = Extract<
  ModelReasoningEffort,
  "low" | "medium" | "high" | "xhigh"
>;
const ALLOWED_REASONING_EFFORTS = new Set<GitHubCopilotReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
]);
function isGitHubCopilotReasoningEffort(
  value: string,
): value is GitHubCopilotReasoningEffort {
  return ALLOWED_REASONING_EFFORTS.has(value as GitHubCopilotReasoningEffort);
}
const SAFE_ENVIRONMENT_KEYS = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
]);

type AuthType = "user" | "gh-cli" | "env" | "hmac" | "api-key" | "token";

export interface GitHubCopilotAuthStatus {
  readonly isAuthenticated: boolean;
  readonly authType?: AuthType;
  readonly host?: string;
  readonly login?: string;
}

export interface GitHubCopilotModel {
  readonly id: string;
  readonly name: string;
  readonly capabilities: {
    readonly supports: { readonly vision: boolean; readonly reasoningEffort: boolean };
    readonly limits: { readonly max_context_window_tokens: number };
  };
  readonly policy?: { readonly state: "enabled" | "disabled" | "unconfigured"; readonly terms: string };
  readonly billing?: { readonly multiplier?: number };
  readonly supportedReasoningEfforts?: readonly string[];
  readonly defaultReasoningEffort?: string;
}

export interface GitHubCopilotToolInvocation {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: unknown;
}

export interface GitHubCopilotTool {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Record<string, unknown>;
  readonly handler: (
    arguments_: unknown,
    invocation: unknown,
  ) => Promise<unknown>;
  readonly overridesBuiltInTool: true;
  readonly skipPermission: true;
  readonly defer: "never";
}

export interface GitHubCopilotSessionEvent {
  readonly type: string;
  readonly agentId?: string;
  readonly data: Record<string, unknown>;
}

export interface GitHubCopilotSessionConfig {
  readonly model: string;
  readonly reasoningEffort?: GitHubCopilotReasoningEffort;
  readonly streaming: true;
  readonly workingDirectory: string;
  readonly systemMessage: { readonly mode: "replace"; readonly content: string };
  readonly tools: readonly GitHubCopilotTool[];
  readonly availableTools: readonly string[];
  readonly excludedTools: readonly string[];
  readonly enableConfigDiscovery: false;
  readonly requestCanvasRenderer: false;
  readonly requestExtensions: false;
  readonly enableMcpApps: false;
  readonly includeSubAgentStreamingEvents: false;
  readonly mcpOAuthTokenStorage: "in-memory";
  readonly mcpServers: Readonly<Record<string, never>>;
  readonly customAgents: readonly [];
  readonly skillDirectories: readonly [];
  readonly pluginDirectories: readonly [];
  readonly instructionDirectories: readonly [];
  readonly skipCustomInstructions: true;
  readonly customAgentsLocalOnly: true;
  readonly coauthorEnabled: false;
  readonly manageScheduleEnabled: false;
  readonly enableSessionTelemetry: false;
  readonly infiniteSessions: { readonly enabled: false };
  readonly memory: { readonly enabled: false };
  readonly enableManagedSettings: false;
  readonly skipEmbeddingRetrieval: true;
  readonly embeddingCacheStorage: "in-memory";
  readonly enableOnDemandInstructionDiscovery: false;
  readonly enableFileHooks: false;
  readonly enableHostGitOperations: false;
  readonly enableSessionStore: false;
  readonly enableSkills: false;
  readonly remoteSession: "off";
  readonly onPermissionRequest: (
    request: unknown,
    context: unknown,
  ) => Promise<{ readonly kind: "denied-by-rules" }>;
  readonly onEvent: (event: GitHubCopilotSessionEvent) => void;
}

export interface GitHubCopilotSession {
  readonly sessionId: string;
  send(input: { readonly prompt: string }): Promise<unknown>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface GitHubCopilotClient {
  start(): Promise<void>;
  getAuthStatus(): Promise<GitHubCopilotAuthStatus>;
  listModels(): Promise<readonly GitHubCopilotModel[]>;
  createSession(config: GitHubCopilotSessionConfig): Promise<GitHubCopilotSession>;
  stop(): Promise<unknown>;
  forceStop(): Promise<void>;
}

export interface GitHubCopilotClientConfig {
  readonly mode: "empty";
  readonly baseDirectory: string;
  readonly workingDirectory?: string;
  readonly useLoggedInUser: true;
  readonly logLevel: "none";
  readonly env: Readonly<Record<string, string>>;
}

export type GitHubCopilotClientFactory = (
  config: GitHubCopilotClientConfig,
) => GitHubCopilotClient | Promise<GitHubCopilotClient>;

export class GitHubCopilotRuntimeError extends Error {
  constructor(
    readonly code:
      | "sdk_unavailable"
      | "authentication_required"
      | "wrong_authentication_method"
      | "account_mismatch"
      | "cancelled"
      | "invalid_response",
    message: string,
  ) {
    super(message);
    this.name = "GitHubCopilotRuntimeError";
  }
}

export interface GitHubCopilotSubscriptionInspection {
  readonly accountLogin: string;
  readonly accountSubjectFingerprint: string;
  readonly authentication: "stored_oauth" | "gh_cli";
  readonly models: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly maxContextTokens: number;
    readonly supportsReasoningEffort: boolean;
    readonly reasoningEfforts: readonly string[];
    readonly defaultReasoningEffort?: string;
    readonly billingMultiplier?: number;
  }[];
}

class EventQueue implements AsyncIterable<AgentRuntimeEvent> {
  readonly #events: AgentRuntimeEvent[] = [];
  readonly #waiters: Array<() => void> = [];
  #closed = false;

  push(event: AgentRuntimeEvent): void {
    if (this.#closed) return;
    this.#events.push(event);
    this.#waiters.shift()?.();
  }

  close(): void {
    this.#closed = true;
    while (this.#waiters.length > 0) this.#waiters.shift()?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent> {
    while (!this.#closed || this.#events.length > 0) {
      const event = this.#events.shift();
      if (event !== undefined) {
        yield event;
      } else {
        await new Promise<void>((resolve) => this.#waiters.push(resolve));
      }
    }
  }
}

class BoundaryError extends Error {
  constructor(readonly boundary: "runtime" | "tool") {
    super("GitHub Copilot runtime boundary exceeded");
  }
}

function cancellationBoundary(
  signal: AbortSignal | undefined,
  onAbort: () => void,
): {
  readonly race: <T>(operation: Promise<T>) => Promise<T>;
  readonly dispose: () => void;
} {
  let rejectAbort!: (error: GitHubCopilotRuntimeError) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  void aborted.catch(() => undefined);
  let settled = false;
  const abort = (): void => {
    if (settled) return;
    settled = true;
    onAbort();
    rejectAbort(new GitHubCopilotRuntimeError(
      "cancelled",
      "GitHub Copilot operation was cancelled",
    ));
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  return {
    race: async <T>(operation: Promise<T>) => await Promise.race([operation, aborted]),
    dispose: () => signal?.removeEventListener("abort", abort),
  };
}

async function boundedClientCleanup(
  client: GitHubCopilotClient,
  session?: GitHubCopilotSession | null,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), CLEANUP_GRACE_MILLISECONDS);
    timer.unref?.();
  });
  const graceful = (async () => {
    await session?.disconnect().catch(() => undefined);
    await client.stop().catch(() => undefined);
    return "graceful" as const;
  })();
  const result = await Promise.race([graceful, timedOut]);
  if (timer !== undefined) clearTimeout(timer);
  if (result === "timeout") void client.forceStop().catch(() => undefined);
}

function sanitizedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.length <= 4_096) output[key] = value;
  }
  return Object.freeze(output);
}

export function githubCopilotAccountFingerprint(login: string, host: string): string {
  if (!SAFE_LOGIN.test(login) || host !== "github.com") {
    throw new GitHubCopilotRuntimeError("invalid_response", "GitHub returned an invalid account identity");
  }
  return `sha256:${createHash("sha256")
    .update(`github-copilot-subscription\0${host}\0${login.toLocaleLowerCase("en-US")}`)
    .digest("hex")}`;
}

async function defaultClientFactory(
  config: GitHubCopilotClientConfig,
  dataDirectory: string,
): Promise<GitHubCopilotClient> {
  const resolution = await resolveGitHubCopilotSdk({
    dataDirectory,
  });
  if (resolution.status === "unavailable") {
    throw new GitHubCopilotRuntimeError(
      "sdk_unavailable",
      "GitHub Copilot support requires @github/copilot-sdk@1.0.8",
    );
  }
  return new resolution.module.CopilotClient(config) as GitHubCopilotClient;
}

function containedBy(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function prepareGitHubCopilotRuntimeHome(dataDirectory: string): Promise<string> {
  const root = path.resolve(dataDirectory);
  const home = githubCopilotRuntimeHome(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const realRoot = await realpath(root);
  const runtimeDirectory = path.join(root, "runtimes");
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const realRuntimeDirectory = await realpath(runtimeDirectory);
  if (!containedBy(realRoot, realRuntimeDirectory)) {
    throw new GitHubCopilotRuntimeError("invalid_response", "GitHub Copilot storage is invalid");
  }
  await mkdir(home, { recursive: true, mode: 0o700 });
  const realHome = await realpath(home);
  if (!containedBy(realRuntimeDirectory, realHome)) {
    throw new GitHubCopilotRuntimeError("invalid_response", "GitHub Copilot storage is invalid");
  }
  await chmod(realHome, 0o700);
  return realHome;
}

async function createClient(
  input: GitHubCopilotInspectionInput,
): Promise<GitHubCopilotClient> {
  const environment = input.environment ?? process.env;
  const baseDirectory = await prepareGitHubCopilotRuntimeHome(input.dataDirectory);
  const config: GitHubCopilotClientConfig = {
    mode: "empty",
    baseDirectory,
    ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory }),
    useLoggedInUser: true,
    logLevel: "none",
    env: sanitizedEnvironment(environment),
  };
  return input.createClient === undefined
    ? await defaultClientFactory(config, input.dataDirectory)
    : await input.createClient(config);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkedAuth(status: unknown): {
  readonly login: string;
  readonly host: "github.com";
  readonly authentication: "stored_oauth" | "gh_cli";
} {
  if (!isRecord(status) || typeof status.isAuthenticated !== "boolean") {
    throw new GitHubCopilotRuntimeError(
      "invalid_response",
      "GitHub returned an invalid authentication status",
    );
  }
  if (!status.isAuthenticated) {
    throw new GitHubCopilotRuntimeError(
      "authentication_required",
      "GitHub Copilot requires signed-in-user authentication",
    );
  }
  if (status.authType !== "user" && status.authType !== "gh-cli") {
    throw new GitHubCopilotRuntimeError(
      "wrong_authentication_method",
      "GitHub Copilot must use an explicit signed-in-user account",
    );
  }
  if (status.host !== "github.com") {
    throw new GitHubCopilotRuntimeError(
      "account_mismatch",
      "GitHub Copilot is signed in to an unsupported host",
    );
  }
  if (typeof status.login !== "string" || !SAFE_LOGIN.test(status.login)) {
    throw new GitHubCopilotRuntimeError(
      "invalid_response",
      "GitHub returned an invalid account identity",
    );
  }
  return {
    login: status.login,
    host: "github.com",
    authentication: status.authType === "gh-cli" ? "gh_cli" : "stored_oauth",
  };
}

export interface GitHubCopilotInspectionInput {
  readonly dataDirectory: string;
  readonly workingDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly createClient?: GitHubCopilotClientFactory;
  readonly signal?: AbortSignal;
}

export async function inspectGitHubCopilotSubscription(
  input: GitHubCopilotInspectionInput,
): Promise<GitHubCopilotSubscriptionInspection> {
  if (input.signal?.aborted) {
    throw new GitHubCopilotRuntimeError("cancelled", "GitHub Copilot inspection was cancelled");
  }
  let client: GitHubCopilotClient | undefined;
  const cancellation = cancellationBoundary(input.signal, () => {
    void client?.forceStop().catch(() => undefined);
  });
  try {
    const clientCreation = createClient(input);
    void clientCreation.then((created) => {
      if (input.signal?.aborted && client !== created) {
        void created.forceStop().catch(() => undefined);
      }
    }, () => undefined);
    client = await cancellation.race(clientCreation);
    await cancellation.race(client.start());
    const auth = checkedAuth(await cancellation.race(client.getAuthStatus()));
    const models = await cancellation.race(client.listModels());
    return {
      accountLogin: auth.login,
      accountSubjectFingerprint: githubCopilotAccountFingerprint(auth.login, auth.host),
      authentication: auth.authentication,
      models: checkedModels(models).map((model) => ({
          id: model.id,
          displayName: model.name,
          maxContextTokens: model.capabilities.limits.max_context_window_tokens,
          supportsReasoningEffort: model.capabilities.supports.reasoningEffort,
          reasoningEfforts: [...(model.supportedReasoningEfforts ?? [])],
          ...(model.defaultReasoningEffort === undefined
            ? {}
            : { defaultReasoningEffort: model.defaultReasoningEffort }),
          ...(model.billing?.multiplier === undefined
            ? {}
            : { billingMultiplier: model.billing.multiplier }),
        })),
    };
  } finally {
    cancellation.dispose();
    if (client !== undefined) await boundedClientCleanup(client);
  }
}

function checkedModels(models: unknown): readonly GitHubCopilotModel[] {
  if (!Array.isArray(models) || models.length > MAX_MODELS) {
    throw new GitHubCopilotRuntimeError(
      "invalid_response",
      "GitHub returned an invalid model catalog",
    );
  }
  for (const value of models) {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      typeof value.name !== "string" ||
      !isRecord(value.capabilities) ||
      !isRecord(value.capabilities.supports) ||
      typeof value.capabilities.supports.vision !== "boolean" ||
      typeof value.capabilities.supports.reasoningEffort !== "boolean" ||
      !isRecord(value.capabilities.limits) ||
      typeof value.capabilities.limits.max_context_window_tokens !== "number" ||
      (value.policy !== undefined &&
        (!isRecord(value.policy) ||
          !["enabled", "disabled", "unconfigured"].includes(
            value.policy.state as string,
          ) || typeof value.policy.terms !== "string")) ||
      (value.billing !== undefined &&
        (!isRecord(value.billing) ||
          (value.billing.multiplier !== undefined &&
            typeof value.billing.multiplier !== "number"))) ||
      (value.supportedReasoningEfforts !== undefined &&
        (!Array.isArray(value.supportedReasoningEfforts) ||
          !value.supportedReasoningEfforts.every((effort) =>
            typeof effort === "string"
          ))) ||
      (value.defaultReasoningEffort !== undefined &&
        typeof value.defaultReasoningEffort !== "string")
    ) {
      throw new GitHubCopilotRuntimeError(
        "invalid_response",
        "GitHub returned invalid model metadata",
      );
    }
  }
  const ids = new Set<string>();
  for (const model of models as readonly GitHubCopilotModel[]) {
    const efforts = model.supportedReasoningEfforts ?? [];
    const multiplier = model.billing?.multiplier;
    const ready = model.policy === undefined || model.policy.state === "enabled";
    if (
      !SAFE_ID.test(model.id) ||
      model.name.length < 1 ||
      model.name.length > 256 ||
      model.name.trim() !== model.name ||
      [...model.name].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || code === 127;
      }) ||
      ids.has(model.id) ||
      !Number.isSafeInteger(model.capabilities.limits.max_context_window_tokens) ||
      model.capabilities.limits.max_context_window_tokens <= 0 ||
      model.capabilities.limits.max_context_window_tokens > 100_000_000 ||
      efforts.some((effort) => !isGitHubCopilotReasoningEffort(effort)) ||
      new Set(efforts).size !== efforts.length ||
      (ready &&
        (model.capabilities.supports.reasoningEffort ? efforts.length === 0 : efforts.length !== 0)) ||
      (model.defaultReasoningEffort !== undefined &&
        !efforts.includes(model.defaultReasoningEffort)) ||
      (multiplier !== undefined &&
        (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 1_000_000))
    ) {
      throw new GitHubCopilotRuntimeError(
        "invalid_response",
        "GitHub returned invalid model metadata",
      );
    }
    ids.add(model.id);
  }
  return (models as readonly GitHubCopilotModel[]).filter((model) =>
    model.policy === undefined || model.policy.state === "enabled"
  );
}

function failure(
  phase: "preflight" | "started",
  domain: IntegrationFailure["domain"],
  code: IntegrationFailure["code"],
  safeMessage: string,
): IntegrationFailure {
  return {
    phase,
    domain,
    code,
    safeMessage,
    diagnosticId: randomUUID(),
    retryable: code === "transport" || code === "timeout" || code === "rate_limited",
    ...(code === "authentication_required" ? { action: "reauthenticate" as const } : {}),
    ...(code === "account_mismatch" ? { action: "select_connection" as const } : {}),
  };
}

function mapFailure(error: unknown, phase: "preflight" | "started"): IntegrationFailure {
  if (error instanceof BoundaryError) {
    return error.boundary === "tool"
      ? failure(phase, "tool", "tool_failed", "A Recurs tool call failed")
      : failure(phase, "runtime", "invalid_response", "GitHub Copilot exceeded a runtime response limit");
  }
  if (error instanceof GitHubCopilotSdkInstallationError) {
    return failure(phase, "runtime", "adapter_unavailable", "The installed GitHub Copilot SDK is invalid");
  }
  if (error instanceof GitHubCopilotRuntimeError) {
    if (error.code === "account_mismatch") {
      return failure(phase, "auth", "account_mismatch", "The signed-in GitHub account does not match this Copilot connection");
    }
    if (error.code === "authentication_required" || error.code === "wrong_authentication_method") {
      return failure(phase, "auth", "authentication_required", "The GitHub Copilot connection requires sign-in");
    }
    if (error.code === "sdk_unavailable") {
      return failure(phase, "runtime", "adapter_unavailable", "GitHub Copilot support is not installed");
    }
    return failure(phase, "runtime", "invalid_response", "GitHub Copilot returned an invalid response");
  }
  return failure(phase, "runtime", "runtime_failed", "The GitHub Copilot runtime failed");
}

function validateTools(tools: readonly ToolDefinition[] | undefined): readonly ToolDefinition[] {
  const definitions = tools ?? [];
  const names = new Set<string>();
  if (
    definitions.length > MAX_TOOLS ||
    definitions.some((tool) =>
      !SAFE_ID.test(tool.name) ||
      tool.description.length > 4_096 ||
      names.has(tool.name) ||
      (names.add(tool.name), false)
    )
  ) {
    throw new TypeError("GitHub Copilot host tools are invalid");
  }
  return definitions;
}

function systemInstructions(executionMode: "act" | "plan"): string {
  return [
    "You are running inside the Recurs harness.",
    "Use only the custom tools supplied by Recurs for this turn.",
    "Built-in tools, MCP, plugins, skills, custom agents, hooks, memory, and ambient instructions are disabled.",
    "Never claim an action or verification unless a Recurs tool returned evidence.",
    executionMode === "plan"
      ? "Plan mode is active: inspect and propose only; do not mutate the project."
      : "Act mode is active: remain within the assigned task and Recurs permissions.",
  ].join("\n");
}

interface Terminal {
  readonly kind: "idle" | "abort" | "error" | "boundary";
  readonly errorType?: string;
}

export interface CreateGitHubCopilotRuntimeInput extends GitHubCopilotInspectionInput {
  readonly connectionId: string;
  readonly modelId: string;
  readonly expectedAccountSubjectFingerprint: string;
  readonly reasoningEffort?: GitHubCopilotReasoningEffort;
}

class GitHubCopilotRuntime implements AgentRuntime {
  readonly adapterId = GITHUB_COPILOT_ADAPTER_ID;
  readonly connectionId: string;
  readonly capabilityProfileRevision = GITHUB_COPILOT_PROFILE_REVISION;
  readonly capabilities: RuntimeCapabilities = Object.freeze({
    resume: false,
    cancellation: "protocol",
    fileEvents: false,
    usageEvents: true,
    supportedPermissionModes: Object.freeze(["ask_always", "approved_for_me", "full_access"] as const),
    approvalControl: "host",
    planMode: "enforced",
    toolExecution: "host_tools",
    checkpointing: "host_tools",
  });
  readonly #input: CreateGitHubCopilotRuntimeInput;

  constructor(input: CreateGitHubCopilotRuntimeInput) {
    if (
      !SAFE_ID.test(input.connectionId) ||
      !SAFE_ID.test(input.modelId) ||
      !FINGERPRINT.test(input.expectedAccountSubjectFingerprint) ||
      (input.reasoningEffort !== undefined &&
        !isGitHubCopilotReasoningEffort(input.reasoningEffort))
    ) {
      throw new TypeError("GitHub Copilot runtime binding is invalid");
    }
    this.connectionId = input.connectionId;
    this.#input = input;
  }

  run(request: AgentRunRequest, host: AgentRuntimeHost): AsyncIterable<AgentRuntimeEvent> {
    const queue = new EventQueue();
    void this.#execute(request, host, queue).finally(() => queue.close());
    return queue;
  }

  async reconcile(): Promise<"gone"> {
    return "gone";
  }

  async #execute(
    request: AgentRunRequest,
    host: AgentRuntimeHost,
    queue: EventQueue,
  ): Promise<void> {
    let phase: "preflight" | "started" = "preflight";
    let client: GitHubCopilotClient | null = null;
    let session: GitHubCopilotSession | null = null;
    let sessionCreation: Promise<GitHubCopilotSession> | null = null;
    let finalText = "";
    let emittedTextBytes = 0;
    let sdkEvents = 0;
    let toolFailure = false;
    let usageComplete = true;
    let usageFlushed = false;
    const pendingUsage: Array<Extract<AgentRuntimeEvent, { readonly type: "usage" }>> = [];
    const flushUsage = (): void => {
      if (!usageComplete || usageFlushed) return;
      usageFlushed = true;
      for (const usage of pendingUsage) queue.push(usage);
    };
    let terminalResolve!: (terminal: Terminal) => void;
    const terminal = new Promise<Terminal>((resolve) => { terminalResolve = resolve; });
    let terminalSeen = false;
    const finish = (value: Terminal): void => {
      if (terminalSeen) return;
      terminalSeen = true;
      terminalResolve(value);
    };
    const cancellation = cancellationBoundary(request.signal, () => {
      finish({ kind: "abort" });
      if (session !== null) {
        void session.abort().catch(() => undefined);
      } else {
        void sessionCreation?.then(
          (created) => created.abort().catch(() => undefined),
          () => undefined,
        );
      }
      void client?.forceStop().catch(() => undefined);
    });

    try {
      if (request.signal.aborted) {
        queue.push({
          type: "cancelled",
          reason: "GitHub Copilot turn was interrupted",
        });
        return;
      }
      if (
        request.modelId !== this.#input.modelId ||
        request.authorization.connectionId !== this.connectionId ||
        request.authorization.modelId !== this.#input.modelId ||
        request.continuation !== null ||
        request.continuationReader !== null
      ) {
        queue.push({
          type: "failed",
          failure: failure("preflight", "runtime", "runtime_capability_missing", "GitHub Copilot cannot run this bound request"),
        });
        return;
      }
      const tools = validateTools(host.tools);
      const clientCreation = createClient({
        ...this.#input,
        workingDirectory: request.cwd,
      });
      void clientCreation.then((created) => {
        if (request.signal.aborted && client !== created) {
          void created.forceStop().catch(() => undefined);
        }
      }, () => undefined);
      client = await cancellation.race(clientCreation);
      await cancellation.race(client.start());
      const auth = checkedAuth(await cancellation.race(client.getAuthStatus()));
      if (githubCopilotAccountFingerprint(auth.login, auth.host) !== this.#input.expectedAccountSubjectFingerprint) {
        throw new GitHubCopilotRuntimeError("account_mismatch", "GitHub account binding changed");
      }
      const model = checkedModels(await cancellation.race(client.listModels())).find(
        (candidate) => candidate.id === this.#input.modelId,
      );
      if (
        model === undefined ||
        (model.capabilities.supports.reasoningEffort
          ? this.#input.reasoningEffort === undefined ||
            !(model.supportedReasoningEfforts ?? []).includes(this.#input.reasoningEffort)
          : this.#input.reasoningEffort !== undefined)
      ) {
        throw new GitHubCopilotRuntimeError("invalid_response", "GitHub Copilot model binding changed");
      }
      const onEvent = (event: unknown): void => {
        if (terminalSeen) return;
        sdkEvents += 1;
        if (
          sdkEvents > MAX_SDK_EVENTS ||
          !isRecord(event) ||
          typeof event.type !== "string" ||
          !isRecord(event.data) ||
          event.agentId !== undefined
        ) {
          finish({ kind: "boundary" });
          return;
        }
        if (event.type === "assistant.message_delta" || event.type === "assistant.reasoning_delta") {
          const text = event.data.deltaContent;
          const textBytes = typeof text === "string" ? Buffer.byteLength(text) : MAX_TEXT_BYTES + 1;
          if (
            typeof text !== "string" ||
            textBytes > MAX_TEXT_BYTES ||
            emittedTextBytes + textBytes > MAX_TEXT_BYTES
          ) {
            finish({ kind: "boundary" });
            return;
          }
          emittedTextBytes += textBytes;
          if (event.type === "assistant.message_delta") {
            finalText += text;
            queue.push({ type: "text_delta", text });
          } else {
            queue.push({ type: "reasoning_delta", text });
          }
          return;
        }
        if (event.type === "assistant.usage") {
          const {
            model,
            inputTokens,
            outputTokens,
            reasoningTokens,
            cacheReadTokens,
            cacheWriteTokens,
          } = event.data;
          if (model !== this.#input.modelId ||
            ![inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens]
            .every((value) => value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0))) {
            finish({ kind: "boundary" });
            return;
          }
          if (inputTokens === undefined || outputTokens === undefined) {
            usageComplete = false;
            pendingUsage.length = 0;
          } else if (usageComplete) {
            pendingUsage.push({
              type: "usage",
              usage: {
                inputTokens: Number(inputTokens),
                outputTokens: Number(outputTokens),
                ...(reasoningTokens === undefined
                  ? {}
                  : { reasoningTokens: Number(reasoningTokens) }),
                ...(cacheReadTokens === undefined
                  ? {}
                  : { cachedInputTokens: Number(cacheReadTokens) }),
                ...(cacheWriteTokens === undefined
                  ? {}
                  : { cacheWriteInputTokens: Number(cacheWriteTokens) }),
              },
            });
          }
          return;
        }
        if (event.type === "session.idle") {
          if (event.data.aborted !== undefined && typeof event.data.aborted !== "boolean") {
            finish({ kind: "boundary" });
          } else {
            finish({ kind: event.data.aborted === true ? "abort" : "idle" });
          }
        }
        if (event.type === "abort") finish({ kind: "abort" });
        if (event.type === "session.error") {
          const errorType = event.data.errorType;
          finish(typeof errorType === "string"
            ? { kind: "error", errorType }
            : { kind: "boundary" });
        }
      };
      const customTools: readonly GitHubCopilotTool[] = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema as Record<string, unknown>,
        overridesBuiltInTool: true,
        skipPermission: true,
        defer: "never",
        handler: async (arguments_, invocation) => {
          let serializedArguments: string;
          try {
            serializedArguments = JSON.stringify(arguments_);
          } catch {
            toolFailure = true;
            finish({ kind: "error", errorType: "tool_execution" });
            throw new BoundaryError("tool");
          }
          if (
            session === null ||
            !isRecord(invocation) ||
            typeof invocation.sessionId !== "string" ||
            typeof invocation.toolName !== "string" ||
            typeof invocation.toolCallId !== "string" ||
            invocation.sessionId !== session.sessionId ||
            invocation.toolName !== tool.name ||
            !SAFE_ID.test(invocation.toolCallId) ||
            request.signal.aborted ||
            host.executeTool === undefined ||
            serializedArguments === undefined ||
            Buffer.byteLength(serializedArguments) > MAX_TOOL_ARGUMENT_BYTES
          ) {
            toolFailure = true;
            finish({ kind: "error", errorType: "tool_execution" });
            throw new BoundaryError("tool");
          }
          queue.push({
            type: "activity",
            activity: {
              id: invocation.toolCallId,
              kind: "tool",
              name: invocation.toolName,
              status: "started",
            },
          });
          try {
            const result = await host.executeTool({
              id: invocation.toolCallId,
              name: invocation.toolName,
              arguments: arguments_,
            }, request.signal);
            if (
              typeof result.output !== "string" ||
              Buffer.byteLength(result.output) > MAX_TOOL_OUTPUT_BYTES
            ) {
              throw new BoundaryError("tool");
            }
            queue.push({
              type: "activity",
              activity: {
                id: invocation.toolCallId,
                kind: "tool",
                name: invocation.toolName,
                status: "completed",
              },
            });
            return result.output;
          } catch {
            toolFailure = true;
            finish({ kind: "error", errorType: "tool_execution" });
            queue.push({
              type: "activity",
              activity: {
                id: invocation.toolCallId,
                kind: "tool",
                name: invocation.toolName,
                status: "failed",
              },
            });
            throw new BoundaryError("tool");
          }
        },
      }));
      sessionCreation = client.createSession({
        model: this.#input.modelId,
        ...(this.#input.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: this.#input.reasoningEffort }),
        streaming: true,
        workingDirectory: request.cwd,
        systemMessage: { mode: "replace", content: systemInstructions(request.executionMode) },
        tools: customTools,
        availableTools: customTools.map((tool) => `custom:${tool.name}`),
        excludedTools: ["builtin:*", "mcp:*"],
        enableConfigDiscovery: false,
        requestCanvasRenderer: false,
        requestExtensions: false,
        enableMcpApps: false,
        includeSubAgentStreamingEvents: false,
        mcpOAuthTokenStorage: "in-memory",
        mcpServers: {},
        customAgents: [],
        skillDirectories: [],
        pluginDirectories: [],
        instructionDirectories: [],
        skipCustomInstructions: true,
        customAgentsLocalOnly: true,
        coauthorEnabled: false,
        manageScheduleEnabled: false,
        enableSessionTelemetry: false,
        infiniteSessions: { enabled: false },
        memory: { enabled: false },
        enableManagedSettings: false,
        skipEmbeddingRetrieval: true,
        embeddingCacheStorage: "in-memory",
        enableOnDemandInstructionDiscovery: false,
        enableFileHooks: false,
        enableHostGitOperations: false,
        enableSessionStore: false,
        enableSkills: false,
        remoteSession: "off",
        onPermissionRequest: async () => ({ kind: "denied-by-rules" }),
        onEvent,
      });
      if (request.signal.aborted) {
        void sessionCreation.then(
          (created) => created.abort().catch(() => undefined),
          () => undefined,
        );
      }
      session = await cancellation.race(sessionCreation);
      phase = "started";
      if (request.signal.aborted) {
        finish({ kind: "abort" });
      } else {
        await cancellation.race(session.send({ prompt: request.prompt }));
      }
      const completed = await terminal;
      if (completed.kind !== "boundary") flushUsage();
      if (request.signal.aborted || completed.kind === "abort") {
        queue.push({ type: "cancelled", reason: "GitHub Copilot turn was interrupted" });
      } else if (completed.kind === "boundary") {
        throw new BoundaryError("runtime");
      } else if (completed.kind === "error") {
        if (toolFailure || completed.errorType === "tool_execution") throw new BoundaryError("tool");
        const mapped = completed.errorType === "authentication"
          ? failure("started", "auth", "authentication_required", "The GitHub Copilot connection requires sign-in")
          : completed.errorType === "authorization"
          ? failure("started", "auth", "authorization_denied", "GitHub Copilot denied this request")
          : completed.errorType === "quota"
          ? failure("started", "provider", "quota_exhausted", "The GitHub Copilot allowance or quota is exhausted")
          : completed.errorType === "rate_limit"
          ? failure("started", "provider", "rate_limited", "GitHub Copilot is rate limited")
          : completed.errorType === "context_limit"
          ? failure("started", "provider", "context_overflow", "The GitHub Copilot context limit was exceeded")
          : failure("started", "runtime", "runtime_failed", "The GitHub Copilot runtime failed");
        queue.push({ type: "failed", failure: mapped });
      } else {
        queue.push({ type: "done", finalText, stopReason: "complete" });
      }
    } catch (error) {
      if (!(error instanceof BoundaryError)) flushUsage();
      if (
        request.signal.aborted ||
        (error instanceof GitHubCopilotRuntimeError && error.code === "cancelled")
      ) {
        queue.push({ type: "cancelled", reason: "GitHub Copilot turn was interrupted" });
      } else {
        queue.push({ type: "failed", failure: mapFailure(error, phase) });
      }
    } finally {
      cancellation.dispose();
      if (client !== null) await boundedClientCleanup(client, session);
    }
  }
}

export function createGitHubCopilotRuntime(
  input: CreateGitHubCopilotRuntimeInput,
): AgentRuntime {
  return new GitHubCopilotRuntime(input);
}
