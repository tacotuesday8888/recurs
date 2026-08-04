import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import {
  type EventSink,
  type LifecycleHookEvent,
  type RecursEvent,
} from "@recurs/core";
import { runProcess, ToolError, type ProcessResult } from "@recurs/tools";

import {
  PrivateUserConfigurationError,
  readPrivateUserConfiguration,
} from "./private-user-config.js";

const CONFIG_VERSION = 1;
const CONFIG_FILE = "hooks.json";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_HOOKS = 8;
const MAX_EVENTS_PER_HOOK = 11;
const MAX_ARGUMENT_BYTES = 4 * 1024;
const DEFAULT_TIMEOUT_MS = 2_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 5_000;
const MAX_EVENT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 8 * 1024;
const MAX_QUEUED_EVENTS = 64;
const MAX_SHUTDOWN_MS = 5_000;
const HOOK_ID = /^[a-z][a-z0-9_-]{0,63}$/u;

export const LIFECYCLE_HOOK_EVENTS = Object.freeze([
  "session.start",
  "turn.start",
  "turn.stop",
  "tool.start",
  "tool.stop",
  "permission.request",
  "permission.result",
  "agent.start",
  "agent.stop",
  "team.start",
  "team.stop",
] as const satisfies readonly LifecycleHookEvent[]);

const LIFECYCLE_HOOK_EVENT_SET = new Set<string>(LIFECYCLE_HOOK_EVENTS);

export interface LifecycleHookDefinition {
  readonly id: string;
  readonly events: readonly LifecycleHookEvent[];
  readonly command: string;
  readonly timeoutMs: number;
}

export interface LifecycleHookConfiguration {
  readonly version: 1;
  readonly hooks: readonly LifecycleHookDefinition[];
}

export interface LifecycleHookSummary {
  readonly id: string;
  readonly events: readonly LifecycleHookEvent[];
  readonly executable: string;
  readonly timeoutMs: number;
}

export interface LifecycleHookStatus {
  readonly version: 1;
  readonly type: "lifecycle_hooks";
  readonly configured: boolean;
  readonly configFile: "$RECURS_HOME/config/hooks.json";
  readonly hooks: readonly LifecycleHookSummary[];
}

export class LifecycleHookConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LifecycleHookConfigurationError";
  }
}

type HookProcessRunner = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof runProcess>[2],
) => Promise<ProcessResult>;

interface ExecutableIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mode: string;
  readonly uid: string;
  readonly nlink: string;
  readonly mtimeMs: string;
  readonly ctimeMs: string;
}

interface PreparedLifecycleHookDefinition extends LifecycleHookDefinition {
  readonly identity: ExecutableIdentity;
}

interface PreparedLifecycleHookConfiguration {
  readonly version: 1;
  readonly hooks: readonly PreparedLifecycleHookDefinition[];
}

export interface LifecycleHookHost {
  readonly events: EventSink;
  close(): Promise<void>;
}

interface HookPayload {
  readonly version: 1;
  readonly type: "recurs.lifecycle";
  readonly event: LifecycleHookEvent;
  readonly sourceType: RecursEvent["type"];
  readonly sessionId: string;
  readonly at: string;
  readonly details?: Readonly<Record<string, string | boolean>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function allowedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function validText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    !value.includes("\0") && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function parseDefinition(value: unknown): LifecycleHookDefinition {
  if (!isRecord(value) || !allowedKeys(value, [
    "id",
    "events",
    "command",
    "timeoutMs",
  ])) {
    throw new LifecycleHookConfigurationError("Each lifecycle hook must use the supported fields");
  }
  if (typeof value.id !== "string" || !HOOK_ID.test(value.id)) {
    throw new LifecycleHookConfigurationError("Each lifecycle hook needs a stable lowercase id");
  }
  if (
    !Array.isArray(value.events) || value.events.length === 0 ||
    value.events.length > MAX_EVENTS_PER_HOOK ||
    value.events.some((event) =>
      typeof event !== "string" || !LIFECYCLE_HOOK_EVENT_SET.has(event)
    ) || new Set(value.events).size !== value.events.length
  ) {
    throw new LifecycleHookConfigurationError("Each lifecycle hook needs unique supported events");
  }
  if (
    !validText(value.command, MAX_ARGUMENT_BYTES) ||
    !path.isAbsolute(value.command) || path.resolve(value.command) !== value.command
  ) {
    throw new LifecycleHookConfigurationError("Each lifecycle hook command must be one bounded absolute path");
  }
  const timeoutMs = value.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    (timeoutMs as number) < MIN_TIMEOUT_MS ||
    (timeoutMs as number) > MAX_TIMEOUT_MS
  ) {
    throw new LifecycleHookConfigurationError(
      `Lifecycle hook timeoutMs must be ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}`,
    );
  }
  return Object.freeze({
    id: value.id,
    events: Object.freeze([...(value.events as LifecycleHookEvent[])]),
    command: value.command,
    timeoutMs: timeoutMs as number,
  });
}

function parseConfiguration(value: unknown): LifecycleHookConfiguration {
  if (
    !isRecord(value) || !exactKeys(value, ["version", "hooks"]) ||
    value.version !== CONFIG_VERSION || !Array.isArray(value.hooks) ||
    value.hooks.length > MAX_HOOKS
  ) {
    throw new LifecycleHookConfigurationError(
      `Lifecycle hook configuration must be version ${CONFIG_VERSION} with at most ${MAX_HOOKS} hooks`,
    );
  }
  const hooks = value.hooks.map(parseDefinition);
  if (new Set(hooks.map((hook) => hook.id)).size !== hooks.length) {
    throw new LifecycleHookConfigurationError("Lifecycle hook ids must be unique");
  }
  for (const event of LIFECYCLE_HOOK_EVENTS) {
    const timeoutMs = hooks.reduce(
      (total, hook) => total + (hook.events.includes(event) ? hook.timeoutMs : 0),
      0,
    );
    if (timeoutMs > MAX_EVENT_TIMEOUT_MS) {
      throw new LifecycleHookConfigurationError(
        `Lifecycle hooks for one event may reserve at most ${MAX_EVENT_TIMEOUT_MS}ms`,
      );
    }
  }
  return Object.freeze({ version: 1, hooks: Object.freeze(hooks) });
}

export async function loadLifecycleHookConfiguration(
  dataDirectory: string,
): Promise<LifecycleHookConfiguration> {
  let contents: string | null;
  try {
    contents = await readPrivateUserConfiguration({
      dataDirectory,
      filename: CONFIG_FILE,
      label: "Lifecycle hook configuration",
      maximumBytes: MAX_CONFIG_BYTES,
    });
  } catch (error) {
    if (error instanceof PrivateUserConfigurationError) {
      throw new LifecycleHookConfigurationError(error.message, { cause: error });
    }
    throw error;
  }
  if (contents === null) return Object.freeze({ version: 1, hooks: Object.freeze([]) });
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new LifecycleHookConfigurationError(
      "Lifecycle hook configuration is not valid JSON",
      { cause: error },
    );
  }
  return parseConfiguration(value);
}

export async function inspectLifecycleHooks(
  dataDirectory: string,
): Promise<LifecycleHookStatus> {
  const configuration = await loadLifecycleHookConfiguration(dataDirectory);
  return Object.freeze({
    version: 1,
    type: "lifecycle_hooks",
    configured: configuration.hooks.length > 0,
    configFile: "$RECURS_HOME/config/hooks.json",
    hooks: Object.freeze(configuration.hooks.map((hook) => Object.freeze({
      id: hook.id,
      events: hook.events,
      executable: path.basename(hook.command),
      timeoutMs: hook.timeoutMs,
    }))),
  });
}

export function renderLifecycleHookStatus(status: LifecycleHookStatus): string {
  if (!status.configured) {
    return `Lifecycle hooks: none\nConfig: ${status.configFile}`;
  }
  return [
    `Lifecycle hooks: ${status.hooks.length}`,
    ...status.hooks.map((hook) =>
      `${hook.id} · ${hook.events.join(", ")} · ${hook.executable} · ${hook.timeoutMs}ms`
    ),
    `Config: ${status.configFile}`,
    "Authority: observe-only · read-only workspace · network denied",
  ].join("\n");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function identityOf(
  details: Awaited<ReturnType<typeof lstat>>,
): ExecutableIdentity {
  return Object.freeze({
    dev: String(details.dev),
    ino: String(details.ino),
    size: String(details.size),
    mode: String(details.mode),
    uid: String(details.uid),
    nlink: String(details.nlink),
    mtimeMs: String(details.mtimeMs),
    ctimeMs: String(details.ctimeMs),
  });
}

function sameIdentity(
  left: ExecutableIdentity,
  right: ExecutableIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mode === right.mode &&
    left.uid === right.uid && left.nlink === right.nlink &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function inspectExecutable(
  command: string,
  workspace: string,
): Promise<ExecutableIdentity> {
  let details: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  try {
    [details, canonical] = await Promise.all([lstat(command), realpath(command)]);
  } catch (error) {
    throw new LifecycleHookConfigurationError(
      "Lifecycle hook command could not be inspected safely",
      { cause: error },
    );
  }
  const owned = typeof process.getuid !== "function" || details.uid === process.getuid();
  const privateMode = process.platform === "win32" || (details.mode & 0o022) === 0;
  const executable = process.platform === "win32" || (details.mode & 0o111) !== 0;
  if (
    !details.isFile() || details.isSymbolicLink() || details.nlink !== 1 ||
    !owned || !privateMode || !executable || canonical !== command ||
    isWithin(workspace, command)
  ) {
    throw new LifecycleHookConfigurationError(
      "Lifecycle hook commands must be immutable, owned executables outside the workspace",
    );
  }
  return identityOf(details);
}

async function prepareConfiguration(
  configuration: LifecycleHookConfiguration,
  workspace: string,
): Promise<PreparedLifecycleHookConfiguration> {
  const canonicalWorkspace = await realpath(workspace);
  const hooks: PreparedLifecycleHookDefinition[] = [];
  for (const hook of configuration.hooks) {
    hooks.push(Object.freeze({
      ...hook,
      identity: await inspectExecutable(hook.command, canonicalWorkspace),
    }));
  }
  return Object.freeze({ version: 1, hooks: Object.freeze(hooks) });
}

function errorDetails(event: Extract<RecursEvent, { error: unknown }>): HookPayload["details"] {
  return { errorCode: event.error.code, retryable: event.error.retryable };
}

export function lifecycleHookPayload(event: RecursEvent): HookPayload | null {
  let lifecycleEvent: LifecycleHookEvent;
  let details: HookPayload["details"];
  switch (event.type) {
    case "session_created": lifecycleEvent = "session.start"; break;
    case "turn_started": lifecycleEvent = "turn.start"; details = { turnId: event.turnId }; break;
    case "turn_completed": lifecycleEvent = "turn.stop"; details = { outcome: "completed" }; break;
    case "turn_cancelled": lifecycleEvent = "turn.stop"; details = { outcome: "cancelled", turnId: event.turnId }; break;
    case "turn_failed": lifecycleEvent = "turn.stop"; details = { outcome: "failed", ...errorDetails(event) }; break;
    case "tool_started": lifecycleEvent = "tool.start"; details = { toolName: event.call.name, callId: event.call.id }; break;
    case "tool_completed": lifecycleEvent = "tool.stop"; details = { outcome: "completed", callId: event.callId }; break;
    case "tool_failed": lifecycleEvent = "tool.stop"; details = { outcome: "failed", callId: event.callId, ...errorDetails(event) }; break;
    case "tool_denied": lifecycleEvent = "tool.stop"; details = { outcome: "denied", callId: event.callId }; break;
    case "permission_requested": lifecycleEvent = "permission.request"; details = { category: event.intent.category }; break;
    case "permission_resolved": lifecycleEvent = "permission.result"; details = { category: event.intent.category, decision: event.decision }; break;
    case "agent_started": lifecycleEvent = "agent.start"; details = { agentId: event.childAgentId }; break;
    case "agent_completed": lifecycleEvent = "agent.stop"; details = { outcome: "completed", agentId: event.childAgentId }; break;
    case "agent_failed": lifecycleEvent = "agent.stop"; details = { outcome: "failed", agentId: event.childAgentId }; break;
    case "agent_cancelled": lifecycleEvent = "agent.stop"; details = { outcome: "cancelled", agentId: event.childAgentId }; break;
    case "agent_team_started": lifecycleEvent = "team.start"; details = { teamId: event.teamId }; break;
    case "agent_team_completed": lifecycleEvent = "team.stop"; details = { outcome: "completed", teamId: event.teamId }; break;
    case "agent_team_failed": lifecycleEvent = "team.stop"; details = { outcome: "failed", teamId: event.teamId }; break;
    case "agent_team_cancelled": lifecycleEvent = "team.stop"; details = { outcome: "cancelled", teamId: event.teamId }; break;
    case "company_goal_started": lifecycleEvent = "team.start"; details = { goalRunId: event.goalRunId }; break;
    case "company_goal_completed": lifecycleEvent = "team.stop"; details = { outcome: "completed", goalRunId: event.goalRunId }; break;
    case "company_goal_failed": lifecycleEvent = "team.stop"; details = { outcome: "failed", goalRunId: event.goalRunId }; break;
    case "company_goal_cancelled": lifecycleEvent = "team.stop"; details = { outcome: "cancelled", goalRunId: event.goalRunId }; break;
    case "company_goal_interrupted": lifecycleEvent = "team.stop"; details = { outcome: "interrupted", goalRunId: event.goalRunId }; break;
    default: return null;
  }
  return Object.freeze({
    version: 1,
    type: "recurs.lifecycle",
    event: lifecycleEvent,
    sourceType: event.type,
    sessionId: event.sessionId,
    at: event.at,
    ...(details === undefined ? {} : { details: Object.freeze(details) }),
  });
}

function failureOutcome(error: unknown): Pick<
  Extract<RecursEvent, { type: "lifecycle_hook_finished" }>,
  "outcome" | "errorCode"
> {
  if (error instanceof ToolError && error.code === "command_timeout") {
    return { outcome: "timed_out", errorCode: "execution_failed" };
  }
  return {
    outcome: "failed",
    errorCode: error instanceof ToolError && error.code === "cancelled"
      ? "cancelled"
      : "execution_failed",
  };
}

class LifecycleHookEventSink implements EventSink {
  readonly #abort = new AbortController();
  #closed = false;
  #closePromise: Promise<void> | null = null;
  #pendingEvents = 0;
  #hookTail: Promise<void> = Promise.resolve();
  #downstreamTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly downstream: EventSink,
    private readonly workspace: string,
    private readonly configuration: PreparedLifecycleHookConfiguration,
    private readonly processRunner: HookProcessRunner = runProcess,
    private readonly now: () => Date = () => new Date(),
    private readonly shutdownTimeoutMs = MAX_SHUTDOWN_MS,
  ) {}

  #send(event: RecursEvent): Promise<void> {
    const operation = this.#downstreamTail.then(() => this.downstream.emit(event));
    this.#downstreamTail = operation.catch(() => {});
    return operation;
  }

  #result(
    event: RecursEvent,
    hook: PreparedLifecycleHookDefinition,
    payload: HookPayload,
    outcome: Pick<
      Extract<RecursEvent, { type: "lifecycle_hook_finished" }>,
      "outcome" | "errorCode"
    >,
  ): Extract<RecursEvent, { type: "lifecycle_hook_finished" }> {
    return {
      type: "lifecycle_hook_finished",
      sessionId: event.sessionId,
      at: this.now().toISOString(),
      hookId: hook.id,
      lifecycleEvent: payload.event,
      ...outcome,
    };
  }

  async #runHooks(
    event: RecursEvent,
    payload: HookPayload,
    hooks: readonly PreparedLifecycleHookDefinition[],
  ): Promise<void> {
    const stdin = `${JSON.stringify(payload)}\n`;
    for (const hook of hooks) {
      if (this.#abort.signal.aborted) return;
      let result: Extract<RecursEvent, { type: "lifecycle_hook_finished" }>;
      try {
        const identity = await inspectExecutable(hook.command, this.workspace);
        if (!sameIdentity(identity, hook.identity)) {
          throw new LifecycleHookConfigurationError(
            "Lifecycle hook command changed after configuration was loaded",
          );
        }
        await this.processRunner(hook.command, [], {
          cwd: this.workspace,
          stdin,
          signal: this.#abort.signal,
          timeoutMs: hook.timeoutMs,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          sandbox: {
            mode: "workspace",
            network: "deny",
            workspaceAccess: "read_only",
          },
        });
        result = this.#result(event, hook, payload, { outcome: "completed" });
      } catch (error) {
        result = this.#result(event, hook, payload, failureOutcome(error));
      }
      await this.#send(result);
    }
  }

  readonly emit = async (event: RecursEvent): Promise<void> => {
    await this.#send(event);
    if (this.#closed) return;
    const payload = lifecycleHookPayload(event);
    if (payload === null) return;
    const hooks = this.configuration.hooks.filter((hook) =>
      hook.events.includes(payload.event)
    );
    if (hooks.length === 0) return;
    if (this.#pendingEvents >= MAX_QUEUED_EVENTS) {
      for (const hook of hooks) {
        void this.#send(this.#result(event, hook, payload, {
          outcome: "failed",
          errorCode: "execution_failed",
        })).catch(() => {});
      }
      return;
    }
    this.#pendingEvents += 1;
    const operation = this.#hookTail.then(() => this.#runHooks(event, payload, hooks));
    this.#hookTail = operation
      .catch(() => {})
      .finally(() => { this.#pendingEvents -= 1; });
  };

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    const timeout = setTimeout(() => this.#abort.abort(), this.shutdownTimeoutMs);
    timeout.unref();
    this.#closePromise = this.#hookTail
      .then(() => this.#downstreamTail)
      .catch(() => {})
      .finally(() => clearTimeout(timeout));
    return this.#closePromise;
  }
}

export async function createLifecycleHookHost(input: {
  readonly dataDirectory: string;
  readonly workspace: string;
  readonly downstream: EventSink;
  readonly processRunner?: HookProcessRunner;
  readonly now?: () => Date;
  readonly shutdownTimeoutMs?: number;
}): Promise<LifecycleHookHost> {
  const configuration = await loadLifecycleHookConfiguration(input.dataDirectory);
  if (configuration.hooks.length === 0) {
    return Object.freeze({
      events: input.downstream,
      close: async () => {},
    });
  }
  const workspace = await realpath(input.workspace);
  const sink = new LifecycleHookEventSink(
    input.downstream,
    workspace,
    await prepareConfiguration(configuration, workspace),
    input.processRunner,
    input.now,
    input.shutdownTimeoutMs,
  );
  return Object.freeze({ events: sink, close: () => sink.close() });
}
