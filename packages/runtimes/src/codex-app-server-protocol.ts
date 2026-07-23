import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";

export type CodexAppServerRequestId = number | string;

export interface CodexAppServerProcessBounds {
  readonly maxFrameBytes: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxFrames: number;
  readonly maxPendingRequests: number;
  readonly requestTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
}

export interface CodexAppServerProcessProfile {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly bounds: CodexAppServerProcessBounds;
}

export interface CodexAppServerMessage {
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexAppServerRequest extends CodexAppServerMessage {
  readonly id: CodexAppServerRequestId;
}

export type CodexAppServerProtocolErrorCode =
  | "invalid_profile"
  | "spawn_failed"
  | "protocol_invalid"
  | "protocol_limit"
  | "request_failed"
  | "timeout"
  | "cancelled"
  | "closed";

export class CodexAppServerProtocolError extends Error {
  readonly code: CodexAppServerProtocolErrorCode;

  constructor(code: CodexAppServerProtocolErrorCode, message: string) {
    super(message);
    this.name = "CodexAppServerProtocolError";
    this.code = code;
  }
}

export interface CodexAppServerClientHandlers {
  readonly onMessage?: (message: CodexAppServerMessage) => void | Promise<void>;
  readonly onRequest?: (request: CodexAppServerRequest) => unknown | Promise<unknown>;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: CodexAppServerProtocolError) => void;
  readonly timer: NodeJS.Timeout;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

interface JsonObject {
  readonly [key: string]: unknown;
}

const MAX_PROFILE_STRING_BYTES = 16 * 1_024;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validBound(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validateProfile(profile: CodexAppServerProcessProfile): void {
  if (
    !path.isAbsolute(profile.command) ||
    profile.command.includes("\0") ||
    profile.args.length > 64 ||
    profile.args.some((argument) =>
      typeof argument !== "string" ||
      argument.includes("\0") ||
      Buffer.byteLength(argument) > MAX_PROFILE_STRING_BYTES
    ) ||
    Object.entries(profile.environment).some(([key, value]) =>
      !/^[A-Z_][A-Z0-9_]*$/u.test(key) ||
      typeof value !== "string" ||
      value.includes("\0") ||
      Buffer.byteLength(value) > MAX_PROFILE_STRING_BYTES
    ) ||
    !validBound(profile.bounds.maxFrameBytes) ||
    !validBound(profile.bounds.maxStdoutBytes) ||
    !validBound(profile.bounds.maxStderrBytes) ||
    !validBound(profile.bounds.maxFrames) ||
    !validBound(profile.bounds.maxPendingRequests) ||
    !validBound(profile.bounds.requestTimeoutMs) ||
    !validBound(profile.bounds.shutdownTimeoutMs) ||
    profile.bounds.maxFrameBytes > profile.bounds.maxStdoutBytes
  ) {
    throw new CodexAppServerProtocolError(
      "invalid_profile",
      "Codex app-server process profile is invalid",
    );
  }
}

function protocolError(value: unknown): CodexAppServerProtocolError {
  const message = isObject(value) && typeof value.message === "string"
    ? value.message.slice(0, 512)
    : "Codex app-server request failed";
  return new CodexAppServerProtocolError("request_failed", message);
}

export class CodexAppServerClient {
  readonly closed: Promise<void>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #profile: CodexAppServerProcessProfile;
  readonly #handlers: CodexAppServerClientHandlers;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #resolveClosed: () => void;
  readonly #rejectClosed: (error: CodexAppServerProtocolError) => void;
  #nextRequestId = 1;
  #stdout = Buffer.alloc(0);
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #frameCount = 0;
  #closing = false;
  #settled = false;

  constructor(
    profile: CodexAppServerProcessProfile,
    handlers: CodexAppServerClientHandlers = {},
  ) {
    validateProfile(profile);
    this.#profile = profile;
    this.#handlers = handlers;
    let resolveClosed!: () => void;
    let rejectClosed!: (error: CodexAppServerProtocolError) => void;
    this.closed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    this.#resolveClosed = resolveClosed;
    this.#rejectClosed = rejectClosed;
    try {
      this.#child = spawn(profile.command, [...profile.args], {
        env: { ...profile.environment },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      throw new CodexAppServerProtocolError(
        "spawn_failed",
        "Codex app-server could not be started",
      );
    }
    this.#child.stdout.on("data", (chunk: Buffer) => this.#consumeStdout(chunk));
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrBytes += chunk.byteLength;
      if (this.#stderrBytes > profile.bounds.maxStderrBytes) {
        this.#fail(new CodexAppServerProtocolError(
          "protocol_limit",
          "Codex app-server exceeded its stderr limit",
        ));
      }
    });
    this.#child.on("error", () => this.#fail(new CodexAppServerProtocolError(
      "spawn_failed",
      "Codex app-server process failed",
    )));
    this.#child.on("exit", (code) => {
      if (this.#closing && code === 0) this.#settleClosed();
      else if (!this.#settled) {
        this.#fail(new CodexAppServerProtocolError(
          "closed",
          "Codex app-server exited before the operation completed",
        ));
      }
    });
  }

  request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.#settled || this.#closing) {
      return Promise.reject(new CodexAppServerProtocolError(
        "closed",
        "Codex app-server is closed",
      ));
    }
    if (
      typeof method !== "string" ||
      method.length === 0 ||
      method.length > 256 ||
      this.#pending.size >= this.#profile.bounds.maxPendingRequests
    ) {
      return Promise.reject(new CodexAppServerProtocolError(
        "protocol_limit",
        "Codex app-server request limit was exceeded",
      ));
    }
    if (signal?.aborted === true) {
      return Promise.reject(new CodexAppServerProtocolError(
        "cancelled",
        "Codex app-server request was cancelled",
      ));
    }
    const id = this.#nextRequestId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#removePending(id);
        reject(new CodexAppServerProtocolError(
          "timeout",
          "Codex app-server request timed out",
        ));
      }, this.#profile.bounds.requestTimeoutMs);
      const onAbort = signal === undefined ? undefined : () => {
        this.#removePending(id);
        reject(new CodexAppServerProtocolError(
          "cancelled",
          "Codex app-server request was cancelled",
        ));
      };
      this.#pending.set(id, {
        resolve,
        reject,
        timer,
        ...(signal === undefined || onAbort === undefined
          ? {}
          : { signal, onAbort }),
      });
      if (signal !== undefined && onAbort !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        this.#write({ id, method, params });
      } catch (error) {
        this.#removePending(id);
        reject(error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#settled || this.#closing || method.length === 0 || method.length > 256) {
      throw new CodexAppServerProtocolError(
        "closed",
        "Codex app-server cannot accept the notification",
      );
    }
    this.#write({ method, ...(params === undefined ? {} : { params }) });
  }

  async close(): Promise<void> {
    if (this.#settled) return;
    this.#closing = true;
    this.#rejectPending(new CodexAppServerProtocolError(
      "closed",
      "Codex app-server was closed",
    ));
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill("SIGKILL"),
      this.#profile.bounds.shutdownTimeoutMs);
    try {
      await this.closed.catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  #write(message: JsonObject): void {
    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame) > this.#profile.bounds.maxFrameBytes) {
      throw new CodexAppServerProtocolError(
        "protocol_limit",
        "Codex app-server outbound frame exceeded its limit",
      );
    }
    this.#child.stdin.write(frame);
  }

  #consumeStdout(chunk: Buffer): void {
    if (this.#settled) return;
    this.#stdoutBytes += chunk.byteLength;
    if (this.#stdoutBytes > this.#profile.bounds.maxStdoutBytes) {
      this.#fail(new CodexAppServerProtocolError(
        "protocol_limit",
        "Codex app-server exceeded its stdout limit",
      ));
      return;
    }
    this.#stdout = Buffer.concat([this.#stdout, chunk]);
    while (true) {
      const newline = this.#stdout.indexOf(0x0a);
      if (newline === -1) {
        if (this.#stdout.byteLength > this.#profile.bounds.maxFrameBytes) {
          this.#fail(new CodexAppServerProtocolError(
            "protocol_limit",
            "Codex app-server frame exceeded its limit",
          ));
        }
        return;
      }
      const frame = this.#stdout.subarray(0, newline);
      this.#stdout = this.#stdout.subarray(newline + 1);
      if (frame.byteLength === 0) continue;
      if (
        frame.byteLength > this.#profile.bounds.maxFrameBytes ||
        ++this.#frameCount > this.#profile.bounds.maxFrames
      ) {
        this.#fail(new CodexAppServerProtocolError(
          "protocol_limit",
          "Codex app-server frame limit was exceeded",
        ));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(frame.toString("utf8")) as unknown;
      } catch {
        this.#fail(new CodexAppServerProtocolError(
          "protocol_invalid",
          "Codex app-server emitted invalid JSON",
        ));
        return;
      }
      void this.#dispatch(value);
    }
  }

  async #dispatch(value: unknown): Promise<void> {
    if (!isObject(value)) {
      this.#fail(new CodexAppServerProtocolError(
        "protocol_invalid",
        "Codex app-server emitted an invalid message",
      ));
      return;
    }
    if (typeof value.id === "number" && ("result" in value || "error" in value)) {
      const pending = this.#pending.get(value.id);
      if (pending === undefined) return;
      this.#removePending(value.id);
      if ("error" in value) pending.reject(protocolError(value.error));
      else pending.resolve(value.result);
      return;
    }
    if (typeof value.method !== "string" || value.method.length === 0) {
      this.#fail(new CodexAppServerProtocolError(
        "protocol_invalid",
        "Codex app-server emitted an invalid message",
      ));
      return;
    }
    if (typeof value.id === "number" || typeof value.id === "string") {
      const request: CodexAppServerRequest = {
        id: value.id,
        method: value.method,
        ...(value.params === undefined ? {} : { params: value.params }),
      };
      try {
        if (this.#handlers.onRequest === undefined) {
          throw new CodexAppServerProtocolError(
            "protocol_invalid",
            "Codex app-server requested an unsupported client operation",
          );
        }
        const result = await this.#handlers.onRequest(request);
        this.#write({ id: request.id, result });
      } catch {
        this.#write({
          id: request.id,
          error: { code: -32_000, message: "Recurs rejected the client operation" },
        });
      }
      return;
    }
    try {
      await this.#handlers.onMessage?.({
        method: value.method,
        ...(value.params === undefined ? {} : { params: value.params }),
      });
    } catch {
      this.#fail(new CodexAppServerProtocolError(
        "protocol_invalid",
        "Recurs could not process a Codex app-server notification",
      ));
    }
  }

  #removePending(id: number): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    this.#pending.delete(id);
  }

  #rejectPending(error: CodexAppServerProtocolError): void {
    for (const [id, pending] of this.#pending) {
      this.#removePending(id);
      pending.reject(error);
    }
  }

  #fail(error: CodexAppServerProtocolError): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#closing = true;
    this.#rejectPending(error);
    this.#child.kill("SIGKILL");
    this.#rejectClosed(error);
  }

  #settleClosed(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolveClosed();
  }
}

export function createCodexAppServerClient(
  profile: CodexAppServerProcessProfile,
  handlers: CodexAppServerClientHandlers = {},
): CodexAppServerClient {
  return new CodexAppServerClient(profile, handlers);
}
