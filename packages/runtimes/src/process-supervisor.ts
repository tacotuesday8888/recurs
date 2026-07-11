import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

export interface AcpProcessBounds {
  readonly maxFrameBytes: number;
  readonly maxStdinBytes: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxFrames: number;
  readonly maxInboundQueueMessages: number;
  readonly maxInboundQueueBytes: number;
  readonly startupTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
}

export interface SpawnManagedAcpProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly allowedEnvironmentKeys: readonly string[];
  readonly bounds: AcpProcessBounds;
  readonly signal?: AbortSignal;
}

export interface ManagedAcpProcessExit {
  readonly exited: boolean;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ManagedAcpProcess {
  readonly pid: number;
  readonly stream: Stream;
  readonly environmentKeys: readonly string[];
  readonly exited: Promise<ManagedAcpProcessExit>;
  readonly failure: Promise<Error>;
  shutdown(): Promise<void>;
}

export class AcpTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpTransportError";
  }
}

type InboundItem = { readonly message: AnyMessage; readonly bytes: number };

const forbiddenEnvironmentKey =
  /(api.?key|token|secret|password|credential|cookie|auth|proxy|certificate|private.?key)/iu;
const hazardousEnvironmentKey =
  /^(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|SHELLOPTS|PROMPT_COMMAND|IFS|DYLD_.+|LD_.+)$/u;
const secretEnvironmentValue =
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{8,}|\b(?:api[_ -]?key|token|secret|password|credential|cookie)\s*[:=])/iu;

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

export function validateAcpProcessBounds(bounds: AcpProcessBounds): void {
  assertPositiveSafeInteger(bounds.maxFrameBytes, "maxFrameBytes");
  assertPositiveSafeInteger(bounds.maxStdinBytes, "maxStdinBytes");
  assertPositiveSafeInteger(bounds.maxStdoutBytes, "maxStdoutBytes");
  assertPositiveSafeInteger(bounds.maxStderrBytes, "maxStderrBytes");
  assertPositiveSafeInteger(bounds.maxFrames, "maxFrames");
  assertPositiveSafeInteger(
    bounds.maxInboundQueueMessages,
    "maxInboundQueueMessages",
  );
  assertPositiveSafeInteger(
    bounds.maxInboundQueueBytes,
    "maxInboundQueueBytes",
  );
  assertPositiveSafeInteger(bounds.startupTimeoutMs, "startupTimeoutMs");
  assertPositiveSafeInteger(bounds.shutdownTimeoutMs, "shutdownTimeoutMs");
  if (bounds.maxFrameBytes > bounds.maxStdoutBytes) {
    throw new TypeError("maxFrameBytes cannot exceed maxStdoutBytes");
  }
  if (bounds.maxFrameBytes > bounds.maxStdinBytes) {
    throw new TypeError("maxFrameBytes cannot exceed maxStdinBytes");
  }
}

function validateSpawnOptions(options: SpawnManagedAcpProcessOptions): void {
  if (!path.isAbsolute(options.command) || options.command.includes("\0")) {
    throw new TypeError("ACP command must be an absolute executable path");
  }
  if (options.args.length > 128) {
    throw new TypeError("ACP argument count exceeds the supported limit");
  }
  for (const argument of options.args) {
    if (
      argument.includes("\0") ||
      Buffer.byteLength(argument) > 8_192 ||
      secretEnvironmentValue.test(argument)
    ) {
      throw new TypeError("ACP argument is invalid or oversized");
    }
  }
  const uniqueKeys = new Set<string>();
  for (const key of options.allowedEnvironmentKeys) {
    if (
      !/^[A-Z_][A-Z0-9_]*$/u.test(key) ||
      forbiddenEnvironmentKey.test(key) ||
      hazardousEnvironmentKey.test(key) ||
      uniqueKeys.has(key)
    ) {
      throw new TypeError("ACP environment allowlist contains an unsafe key");
    }
    uniqueKeys.add(key);
  }
  validateAcpProcessBounds(options.bounds);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateId(value: unknown): value is string | number {
  return (
    (typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value) <= 128 &&
      ![...value].some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      })) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function idKey(value: string | number): string {
  return `${typeof value}:${String(value)}`;
}

function validateErrorPayload(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !["code", "message", "data"].includes(key))) {
    return false;
  }
  return (
    typeof value.code === "number" &&
    Number.isSafeInteger(value.code) &&
    typeof value.message === "string" &&
    Buffer.byteLength(value.message) <= 4_096
  );
}

function validateEnvelope(value: unknown): AnyMessage {
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    throw new AcpTransportError("ACP agent sent an invalid JSON-RPC envelope");
  }
  const allowed = new Set(["jsonrpc", "id", "method", "params", "result", "error"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AcpTransportError("ACP agent sent an invalid JSON-RPC envelope");
  }
  const hasMethod = hasOwn(value, "method");
  const hasId = hasOwn(value, "id");
  const hasResult = hasOwn(value, "result");
  const hasError = hasOwn(value, "error");

  if (hasMethod) {
    if (
      typeof value.method !== "string" ||
      value.method.length === 0 ||
      Buffer.byteLength(value.method) > 256 ||
      hasResult ||
      hasError ||
      (hasId && !validateId(value.id))
    ) {
      throw new AcpTransportError("ACP agent sent an invalid JSON-RPC request");
    }
    return value as AnyMessage;
  }

  if (
    !hasId ||
    !validateId(value.id) ||
    hasResult === hasError ||
    (hasError && !validateErrorPayload(value.error))
  ) {
    throw new AcpTransportError("ACP agent sent an invalid JSON-RPC response");
  }
  return value as AnyMessage;
}

class BoundedInboundQueue {
  readonly stream: ReadableStream<AnyMessage>;
  private controller: ReadableStreamDefaultController<AnyMessage> | null = null;
  private readonly queue: InboundItem[] = [];
  private queuedBytes = 0;
  private demand = 0;
  private closed = false;
  private closeWhenDrained = false;

  constructor(private readonly bounds: AcpProcessBounds) {
    this.stream = new ReadableStream<AnyMessage>(
      {
        start: (controller) => {
          this.controller = controller;
        },
        pull: () => {
          this.demand += 1;
          this.flush();
        },
        cancel: () => {
          this.closed = true;
          this.queue.length = 0;
          this.queuedBytes = 0;
        },
      },
      { highWaterMark: 0 },
    );
  }

  pushMany(items: readonly InboundItem[]): void {
    if (this.closed) {
      throw new AcpTransportError("ACP agent sent traffic after transport close");
    }
    const addedBytes = items.reduce((sum, item) => sum + item.bytes, 0);
    if (this.queue.length + items.length > this.bounds.maxInboundQueueMessages) {
      throw new AcpTransportError("ACP inbound queue count limit exceeded");
    }
    if (this.queuedBytes + addedBytes > this.bounds.maxInboundQueueBytes) {
      throw new AcpTransportError("ACP inbound queue byte limit exceeded");
    }
    this.queue.push(...items);
    this.queuedBytes += addedBytes;
    this.flush();
  }

  finish(): void {
    if (this.closed) return;
    this.closeWhenDrained = true;
    this.flush();
  }

  fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.controller?.error(error);
  }

  private flush(): void {
    if (this.closed || !this.controller) return;
    while (this.demand > 0 && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;
      this.queuedBytes -= item.bytes;
      this.demand -= 1;
      this.controller.enqueue(item.message);
    }
    if (this.closeWhenDrained && this.queue.length === 0) {
      this.closed = true;
      this.controller.close();
    }
  }
}

class ManagedProcessImpl implements ManagedAcpProcess {
  readonly pid: number;
  readonly stream: Stream;
  readonly environmentKeys: readonly string[];
  readonly exited: Promise<ManagedAcpProcessExit>;
  readonly failure: Promise<Error>;

  private readonly inbound: BoundedInboundQueue;
  private readonly outstandingOutbound = new Map<string, string>();
  private readonly seenOutboundIds = new Set<string>();
  private readonly outstandingInbound = new Set<string>();
  private readonly seenInboundIds = new Set<string>();
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly startupTimer: ReturnType<typeof setTimeout>;
  private stdoutBuffer = Buffer.alloc(0);
  private stdoutBytes = 0;
  private stdinBytes = 0;
  private stderrBytes = 0;
  private frameCount = 0;
  private promptResponded = false;
  private state: "starting" | "open" | "closing" | "closed" | "failed" =
    "starting";
  private failedError: Error | null = null;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private externalSignal: AbortSignal | null = null;
  private externalAbort: (() => void) | null = null;
  private resolveExit!: (exit: ManagedAcpProcessExit) => void;
  private resolveFailure!: (error: Error) => void;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly bounds: AcpProcessBounds,
    environmentKeys: readonly string[],
    externalSignal?: AbortSignal,
  ) {
    if (child.pid === undefined) {
      throw new AcpTransportError("ACP process did not receive a process ID");
    }
    this.pid = child.pid;
    this.environmentKeys = Object.freeze([...environmentKeys]);
    this.inbound = new BoundedInboundQueue(bounds);
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.failure = new Promise((resolve) => {
      this.resolveFailure = resolve;
    });
    this.startupTimer = setTimeout(() => {
      this.fail(new AcpTransportError("ACP startup timeout exceeded"));
    }, bounds.startupTimeoutMs);
    this.startupTimer.unref?.();

    this.stream = {
      readable: this.inbound.stream,
      writable: new WritableStream<AnyMessage>({
        write: async (message) => {
          await this.write(message);
        },
        close: async () => {
          this.child.stdin.end();
        },
        abort: () => {
          this.fail(new AcpTransportError("ACP transport writer aborted"));
        },
      }),
    };

    child.stdout.on("data", (chunk: Buffer) => this.receiveStdout(chunk));
    child.stdout.on("end", () => this.stdoutEnded());
    child.stderr.on("data", (chunk: Buffer) => this.receiveStderr(chunk));
    child.stdin.on("error", () => {
      if (!this.shuttingDown) {
        this.fail(new AcpTransportError("ACP stdin transport failed"));
      }
    });
    child.on("error", () => {
      this.fail(new AcpTransportError("ACP process could not be started"));
    });
    child.once("close", (code, signal) => {
      this.removeExternalAbortListener();
      clearTimeout(this.startupTimer);
      this.resolveExit({ exited: true, code, signal });
      if (!this.shuttingDown && !this.failedError) {
        this.fail(new AcpTransportError("ACP process exited unexpectedly"), false);
      } else if (
        !this.failedError &&
        (this.outstandingOutbound.size > 0 || this.outstandingInbound.size > 0)
      ) {
        this.fail(new AcpTransportError("ACP process exited with unsettled requests"), false);
      } else if (!this.failedError) {
        this.state = "closed";
        this.inbound.finish();
      }
    });

    if (externalSignal) {
      if (externalSignal.aborted) {
        this.fail(new AcpTransportError("ACP process start was cancelled"));
      } else {
        this.externalSignal = externalSignal;
        this.externalAbort = () => {
          this.fail(new AcpTransportError("ACP process was cancelled"));
        };
        externalSignal.addEventListener(
          "abort",
          this.externalAbort,
          { once: true },
        );
      }
    }
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  private async write(message: AnyMessage): Promise<void> {
    if (this.failedError) throw this.failedError;
    if (this.state === "closing" || this.state === "closed") {
      throw new AcpTransportError("ACP transport is closing");
    }
    const validated = validateEnvelope(message);
    const bytes = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
    if (bytes.byteLength - 1 > this.bounds.maxFrameBytes) {
      const error = new AcpTransportError("ACP outbound frame limit exceeded");
      this.fail(error);
      throw error;
    }
    if (this.stdinBytes + bytes.byteLength > this.bounds.maxStdinBytes) {
      const error = new AcpTransportError("ACP stdin limit exceeded");
      this.fail(error);
      throw error;
    }
    try {
      this.trackOutbound(validated);
    } catch (error) {
      const safeError = error instanceof Error
        ? error
        : new AcpTransportError("ACP outbound validation failed");
      this.fail(safeError);
      throw safeError;
    }
    this.stdinBytes += bytes.byteLength;
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(bytes, (error) => {
        if (error) reject(new AcpTransportError("ACP stdin transport failed"));
        else resolve();
      });
    });
  }

  private trackOutbound(message: AnyMessage): void {
    const record = message as unknown as Record<string, unknown>;
    if (this.state === "starting" && record.method !== "initialize") {
      throw new AcpTransportError("ACP initialize must be the first request");
    }
    if (this.state === "open" && record.method === "initialize") {
      throw new AcpTransportError("ACP initialize request was repeated");
    }
    if (typeof record.method === "string" && hasOwn(record, "id")) {
      if (!validateId(record.id)) {
        throw new AcpTransportError("ACP client produced an invalid request ID");
      }
      const key = idKey(record.id);
      if (this.seenOutboundIds.has(key)) {
        throw new AcpTransportError("ACP client reused a JSON-RPC request ID");
      }
      this.seenOutboundIds.add(key);
      this.outstandingOutbound.set(key, record.method);
      return;
    }
    if (!hasOwn(record, "method") && hasOwn(record, "id")) {
      if (!validateId(record.id)) {
        throw new AcpTransportError("ACP client produced an invalid response ID");
      }
      const key = idKey(record.id);
      if (!this.outstandingInbound.delete(key)) {
        throw new AcpTransportError("ACP client responded to an unknown request");
      }
    }
  }

  private receiveStdout(chunk: Buffer): void {
    if (this.failedError) return;
    this.stdoutBytes += chunk.byteLength;
    if (this.stdoutBytes > this.bounds.maxStdoutBytes) {
      this.fail(new AcpTransportError("ACP stdout limit exceeded"));
      return;
    }
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    const items: InboundItem[] = [];
    try {
      let newline = this.stdoutBuffer.indexOf(0x0a);
      while (newline >= 0) {
        let frame = this.stdoutBuffer.subarray(0, newline);
        this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
        if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
        if (frame.byteLength === 0) {
          throw new AcpTransportError("ACP agent sent an empty JSON-RPC frame");
        }
        if (frame.byteLength > this.bounds.maxFrameBytes) {
          throw new AcpTransportError("ACP frame limit exceeded");
        }
        this.frameCount += 1;
        if (this.frameCount > this.bounds.maxFrames) {
          throw new AcpTransportError("ACP frame count limit exceeded");
        }
        let text: string;
        try {
          text = this.decoder.decode(frame);
        } catch {
          throw new AcpTransportError("ACP agent sent invalid UTF-8");
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          throw new AcpTransportError("ACP agent sent invalid JSON");
        }
        const message = validateEnvelope(parsed);
        this.trackInbound(message);
        items.push({ message, bytes: frame.byteLength });
        newline = this.stdoutBuffer.indexOf(0x0a);
      }
      if (this.stdoutBuffer.byteLength > this.bounds.maxFrameBytes) {
        throw new AcpTransportError("ACP frame limit exceeded");
      }
      if (items.length > 0) this.inbound.pushMany(items);
    } catch (error) {
      this.fail(
        error instanceof Error
          ? error
          : new AcpTransportError("ACP transport validation failed"),
      );
    }
  }

  private trackInbound(message: AnyMessage): void {
    const record = message as unknown as Record<string, unknown>;
    if (typeof record.method === "string") {
      if (this.state !== "open") {
        throw new AcpTransportError("ACP agent sent traffic outside the open state");
      }
      if (record.method === "session/update" && this.promptResponded) {
        throw new AcpTransportError("ACP agent sent traffic after prompt completion");
      }
      const allowed = record.method === "session/update" ||
        record.method === "session/request_permission" ||
        record.method === "$/cancel_request";
      if (!allowed) {
        throw new AcpTransportError("ACP agent sent an unsupported inbound method");
      }
      if (hasOwn(record, "id")) {
        if (!validateId(record.id)) {
          throw new AcpTransportError("ACP agent sent an invalid request ID");
        }
        const key = idKey(record.id);
        if (this.seenInboundIds.has(key)) {
          throw new AcpTransportError("ACP agent reused a JSON-RPC request ID");
        }
        this.seenInboundIds.add(key);
        this.outstandingInbound.add(key);
      }
      return;
    }
    if (!validateId(record.id)) {
      throw new AcpTransportError("ACP agent sent an invalid response ID");
    }
    const key = idKey(record.id);
    const method = this.outstandingOutbound.get(key);
    if (!method) {
      throw new AcpTransportError("ACP agent sent an unknown response ID");
    }
    this.outstandingOutbound.delete(key);
    if (method === "initialize") {
      clearTimeout(this.startupTimer);
      if (this.state !== "starting") {
        throw new AcpTransportError("ACP initialize response arrived in the wrong state");
      }
      this.state = "open";
    }
    if (method === "session/prompt") this.promptResponded = true;
  }

  private receiveStderr(chunk: Buffer): void {
    if (this.failedError) return;
    this.stderrBytes += chunk.byteLength;
    if (this.stderrBytes > this.bounds.maxStderrBytes) {
      this.fail(new AcpTransportError("ACP stderr limit exceeded"));
    }
  }

  private stdoutEnded(): void {
    if (this.stdoutBuffer.byteLength > 0 && !this.failedError) {
      this.fail(new AcpTransportError("ACP stdout ended with a partial frame"));
    }
  }

  private fail(error: Error, terminate = true): void {
    if (this.failedError) return;
    this.failedError = error;
    this.state = "failed";
    clearTimeout(this.startupTimer);
    this.resolveFailure(error);
    this.inbound.fail(error);
    if (terminate) void this.terminateGroup("SIGTERM");
  }

  private async performShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.state !== "failed" && this.state !== "closed") {
      this.state = "closing";
    }
    this.removeExternalAbortListener();
    clearTimeout(this.startupTimer);
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    const slice = Math.max(10, Math.floor(this.bounds.shutdownTimeoutMs / 3));
    if (await this.waitForExit(slice)) {
      // The group leader may exit after stdin closes while descendants remain.
      this.terminateGroup("SIGTERM");
      this.throwIfFailed();
      return;
    }
    this.terminateGroup("SIGTERM");
    if (await this.waitForExit(slice)) {
      this.throwIfFailed();
      return;
    }
    this.terminateGroup("SIGKILL");
    if (!(await this.waitForExit(slice))) {
      throw new AcpTransportError("ACP process did not exit after bounded shutdown");
    }
    this.throwIfFailed();
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    return await Promise.race([
      this.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  private terminateGroup(signal: NodeJS.Signals): void {
    try {
      if (process.platform === "win32") this.child.kill(signal);
      else process.kill(-this.pid, signal);
    } catch {
      // The process may already have exited between the bounded checks.
    }
  }

  private removeExternalAbortListener(): void {
    if (this.externalSignal && this.externalAbort) {
      this.externalSignal.removeEventListener("abort", this.externalAbort);
    }
    this.externalSignal = null;
    this.externalAbort = null;
  }

  private throwIfFailed(): void {
    if (this.failedError) throw this.failedError;
  }
}

function buildEnvironment(keys: readonly string[]): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  for (const key of [...keys].sort()) {
    const value = process.env[key];
    if (value !== undefined) {
      if (
        value.includes("\0") ||
        Buffer.byteLength(value) > 4_096 ||
        secretEnvironmentValue.test(value)
      ) {
        throw new TypeError("ACP allowlisted environment value is unsafe");
      }
      environment[key] = value;
    }
  }
  return environment;
}

export async function spawnManagedAcpProcess(
  options: SpawnManagedAcpProcessOptions,
): Promise<ManagedAcpProcess> {
  validateSpawnOptions(options);
  if (options.signal?.aborted) {
    throw new AcpTransportError("ACP process start was cancelled");
  }
  const environmentKeys = [...new Set(options.allowedEnvironmentKeys)].sort();
  const child = spawn(options.command, [...options.args], {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env: buildEnvironment(environmentKeys),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      child.off("error", onError);
      resolve();
    };
    const onError = (): void => {
      child.off("spawn", onSpawn);
      reject(new AcpTransportError("ACP process could not be started"));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });

  return new ManagedProcessImpl(
    child,
    options.bounds,
    environmentKeys,
    options.signal,
  );
}
