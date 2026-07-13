import { spawn } from "node:child_process";

import { createIsolatedProcessEnvironment } from "./process-environment.js";
import { ToolError } from "./types.js";

const PROCESS_GROUP_TERM_GRACE_MS = 250;
const PROCESS_GROUP_KILL_WAIT_MS = 1_000;
const PROCESS_GROUP_POLL_MS = 10;
const PROCESS_PIPE_DRAIN_GRACE_MS = 250;

export const TOOL_CHILD_STDIO = Object.freeze([
  "pipe",
  "pipe",
  "pipe",
] as const);

export function assertToolChildStdio(stdio: readonly unknown[]): void {
  if (
    stdio.length !== TOOL_CHILD_STDIO.length ||
    stdio.some((descriptor, index) => descriptor !== TOOL_CHILD_STDIO[index])
  ) {
    throw new ToolError(
      "process_failed",
      "The tool child stdio boundary is invalid",
    );
  }
}

function createToolChildStdio(): ["pipe", "pipe", "pipe"] {
  const stdio: ["pipe", "pipe", "pipe"] = [...TOOL_CHILD_STDIO];
  assertToolChildStdio(stdio);
  return stdio;
}

export interface RunProcessOptions {
  cwd: string;
  stdin?: string;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  acceptableExitCodes?: readonly number[];
  timeoutMs?: number;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function assertSupportedProcessPlatform(
  platform: NodeJS.Platform,
): void {
  if (platform !== "darwin" && platform !== "linux") {
    throw new ToolError(
      "unsupported_platform",
      `Subprocesses are unsupported on ${platform}`,
    );
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isNoSuchProcess(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ESRCH"
  );
}

function isPermissionDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EPERM"
  );
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
): boolean {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) {
      return false;
    }
    throw new ToolError(
      "process_failed",
      "The child process group could not be terminated",
    );
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) {
      return false;
    }
    if (isPermissionDenied(error)) {
      return true;
    }
    throw new ToolError(
      "process_failed",
      "The child process group could not be inspected",
    );
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs?: number,
): Promise<boolean> {
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  while (processGroupExists(processGroupId)) {
    if (deadline !== undefined && Date.now() >= deadline) {
      return false;
    }
    const waitMs = deadline === undefined
      ? PROCESS_GROUP_POLL_MS
      : Math.max(1, Math.min(PROCESS_GROUP_POLL_MS, deadline - Date.now()));
    await delay(waitMs);
  }
  return true;
}

async function terminateProcessGroup(processGroupId: number): Promise<void> {
  if (!signalProcessGroup(processGroupId, "SIGTERM")) {
    return;
  }
  if (
    await waitForProcessGroupExit(
      processGroupId,
      PROCESS_GROUP_TERM_GRACE_MS,
    )
  ) {
    return;
  }
  if (!signalProcessGroup(processGroupId, "SIGKILL")) {
    return;
  }
  const exitedAfterKill = await waitForProcessGroupExit(
    processGroupId,
    PROCESS_GROUP_KILL_WAIT_MS,
  );
  if (!exitedAfterKill) {
    throw new ToolError(
      "process_failed",
      "The child process group did not exit after forced termination",
    );
  }
}

export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  assertSupportedProcessPlatform(process.platform);
  const maxOutputBytes = options.maxOutputBytes ?? 512 * 1024;
  const acceptableExitCodes = options.acceptableExitCodes ?? [0];
  if (isAborted(options.signal)) {
    throw new ToolError("cancelled", `${command} was cancelled`);
  }
  const isolatedEnvironment = await createIsolatedProcessEnvironment(
    options.cwd,
  );

  try {
    if (isAborted(options.signal)) {
      throw new ToolError("cancelled", `${command} was cancelled`);
    }
    return await new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: isolatedEnvironment.environment,
        shell: false,
        stdio: createToolChildStdio(),
        windowsHide: true,
        detached: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let outputExceeded = false;
      let timedOut = false;
      let spawnFailed = false;
      let streamFailed = false;
      let exitCode: number | undefined;
      let stdoutClosed = false;
      let stderrClosed = false;
      let finalizationStarted = false;
      let terminationPromise: Promise<void> | undefined;
      let resolveOutputPipesClosed: () => void = () => {};
      const outputPipesClosed = new Promise<void>((resolvePipes) => {
        resolveOutputPipesClosed = resolvePipes;
      });

      const startTermination = (): Promise<void> => {
        if (terminationPromise === undefined) {
          terminationPromise = child.pid === undefined
            ? Promise.resolve()
            : terminateProcessGroup(child.pid);
          void terminationPromise.catch(() => {});
        }
        return terminationPromise;
      };

      const destroyPipes = (): void => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      };

      const markOutputPipeClosed = (pipe: "stdout" | "stderr"): void => {
        if (pipe === "stdout") {
          stdoutClosed = true;
        } else {
          stderrClosed = true;
        }
        if (stdoutClosed && stderrClosed) {
          resolveOutputPipesClosed();
        }
      };

      const waitForPipeDrain = async (): Promise<void> => {
        if (stdoutClosed && stderrClosed) {
          return;
        }
        await new Promise<void>((resolveDrain) => {
          const drainTimeout = setTimeout(
            resolveDrain,
            PROCESS_PIPE_DRAIN_GRACE_MS,
          );
          void outputPipesClosed.then(() => {
            clearTimeout(drainTimeout);
            resolveDrain();
          });
        });
      };

      const finalize = async (): Promise<ProcessResult> => {
        let cleanupFailed = false;
        try {
          await startTermination();
        } catch {
          cleanupFailed = true;
        }
        try {
          await waitForPipeDrain();
        } finally {
          destroyPipes();
          clearTimeout(timeout);
          options.signal?.removeEventListener("abort", onAbort);
        }

        if (cleanupFailed) {
          throw new ToolError(
            "process_failed",
            "The child process group could not be cleaned up",
          );
        }
        if (spawnFailed) {
          throw new ToolError(
            "process_failed",
            `Failed to start ${command}`,
          );
        }
        if (isAborted(options.signal)) {
          throw new ToolError("cancelled", `${command} was cancelled`);
        }
        if (timedOut) {
          throw new ToolError(
            "command_timeout",
            `${command} exceeded the ${options.timeoutMs ?? 0}ms timeout`,
          );
        }
        if (outputExceeded) {
          throw new ToolError(
            "output_limit",
            `${command} exceeded the ${maxOutputBytes}-byte output limit`,
          );
        }
        if (streamFailed) {
          throw new ToolError(
            "process_failed",
            `${command} output could not be read`,
          );
        }

        const completedExitCode = exitCode ?? -1;
        const result = {
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode: completedExitCode,
        };
        if (!acceptableExitCodes.includes(completedExitCode)) {
          throw new ToolError(
            "process_failed",
            `${command} exited with ${completedExitCode}`,
          );
        }
        return result;
      };

      const beginFinalization = (): void => {
        if (finalizationStarted) {
          return;
        }
        finalizationStarted = true;
        void finalize().then(resolve, (error: unknown) => {
          reject(
            error instanceof ToolError
              ? error
              : new ToolError(
                  "process_failed",
                  "The child process could not be finalized",
                ),
          );
        });
      };

      function onAbort(): void {
        beginFinalization();
      }

      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            beginFinalization();
          }, options.timeoutMs);
      timeout?.unref();
      if (isAborted(options.signal)) {
        beginFinalization();
      }

      const capture = (target: Buffer[], chunk: Buffer): void => {
        if (outputExceeded) {
          return;
        }
        outputBytes += chunk.byteLength;
        if (outputBytes > maxOutputBytes) {
          outputExceeded = true;
          beginFinalization();
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      child.stdout.once("close", () => markOutputPipeClosed("stdout"));
      child.stderr.once("close", () => markOutputPipeClosed("stderr"));
      child.stdout.on("error", () => {
        streamFailed = true;
        beginFinalization();
      });
      child.stderr.on("error", () => {
        streamFailed = true;
        beginFinalization();
      });
      child.on("exit", (code) => {
        exitCode = code ?? -1;
        beginFinalization();
      });
      child.on("error", () => {
        spawnFailed = true;
        beginFinalization();
      });
      child.on("close", (code) => {
        exitCode ??= code ?? -1;
        beginFinalization();
      });

      child.stdin.on("error", () => {
        // Process exit handling reports the useful failure.
      });
      child.stdin.end(options.stdin ?? "");
    });
  } finally {
    await isolatedEnvironment.cleanup();
  }
}
