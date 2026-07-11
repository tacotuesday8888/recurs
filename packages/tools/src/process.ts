import { spawn } from "node:child_process";

import { createIsolatedProcessEnvironment } from "./process-environment.js";
import { ToolError } from "./types.js";

const PROCESS_GROUP_TERM_GRACE_MS = 250;
const PROCESS_GROUP_KILL_WAIT_MS = 1_000;
const PROCESS_GROUP_POLL_MS = 10;

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
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        detached: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let outputExceeded = false;
      let settlementStarted = false;
      let timedOut = false;
      let terminationPromise: Promise<void> | undefined;

      const startTermination = (): Promise<void> => {
        if (terminationPromise === undefined) {
          terminationPromise = child.pid === undefined
            ? Promise.resolve()
            : terminateProcessGroup(child.pid);
          void terminationPromise.catch(() => {});
        }
        return terminationPromise;
      };

      const onAbort = (): void => {
        void startTermination();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            void startTermination();
          }, options.timeoutMs);
      timeout?.unref();

      const capture = (target: Buffer[], chunk: Buffer): void => {
        if (outputExceeded) {
          return;
        }
        outputBytes += chunk.byteLength;
        if (outputBytes > maxOutputBytes) {
          outputExceeded = true;
          void startTermination();
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
      child.on("exit", () => {
        void startTermination();
      });
      child.on("error", () => {
        if (settlementStarted) {
          return;
        }
        settlementStarted = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        void (async () => {
          try {
            await startTermination();
          } catch {
            reject(
              new ToolError(
                "process_failed",
                "The child process group could not be cleaned up",
              ),
            );
            return;
          }
          reject(
            new ToolError("process_failed", `Failed to start ${command}`),
          );
        })();
      });
      child.on("close", (code) => {
        if (settlementStarted) {
          return;
        }
        settlementStarted = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        void (async () => {
          try {
            await startTermination();
          } catch {
            reject(
              new ToolError(
                "process_failed",
                "The child process group could not be cleaned up",
              ),
            );
            return;
          }
          if (isAborted(options.signal)) {
            reject(new ToolError("cancelled", `${command} was cancelled`));
            return;
          }
          if (timedOut) {
            reject(
              new ToolError(
                "command_timeout",
                `${command} exceeded the ${options.timeoutMs ?? 0}ms timeout`,
              ),
            );
            return;
          }
          if (outputExceeded) {
            reject(
              new ToolError(
                "output_limit",
                `${command} exceeded the ${maxOutputBytes}-byte output limit`,
              ),
            );
            return;
          }
          const exitCode = code ?? -1;
          const result = {
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            exitCode,
          };
          if (!acceptableExitCodes.includes(exitCode)) {
            reject(
              new ToolError(
                "process_failed",
                `${command} exited with ${exitCode}`,
              ),
            );
            return;
          }
          resolve(result);
        })();
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
