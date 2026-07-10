import { spawn } from "node:child_process";

import { ToolError } from "./types.js";

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

export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<ProcessResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 512 * 1024;
  const acceptableExitCodes = options.acceptableExitCodes ?? [0];
  if (options.signal?.aborted === true) {
    throw new ToolError("cancelled", `${command} was cancelled`);
  }

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputExceeded = false;
    let settled = false;
    let terminating = false;
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) {
        return;
      }
      try {
        if (process.platform === "win32") {
          child.kill(signal);
        } else {
          process.kill(-child.pid, signal);
        }
      } catch {
        child.kill(signal);
      }
    };

    const terminate = (): void => {
      if (terminating) {
        return;
      }
      terminating = true;
      kill("SIGTERM");
      forceKillTimer = setTimeout(() => kill("SIGKILL"), 250);
      forceKillTimer.unref();
    };

    const onAbort = (): void => {
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          terminate();
        }, options.timeoutMs);
    timeout?.unref();

    const capture = (target: Buffer[], chunk: Buffer): void => {
      if (outputExceeded) {
        return;
      }
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        outputExceeded = true;
        terminate();
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        clearTimeout(forceKillTimer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(
          new ToolError("process_failed", `Failed to start ${command}`, {
            cause: error,
          }),
        );
      }
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted === true) {
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
            `${command} exited with ${exitCode}: ${result.stderr.trim()}`,
          ),
        );
        return;
      }
      resolve(result);
    });

    child.stdin.on("error", () => {
      // Process exit handling reports the useful failure.
    });
    child.stdin.end(options.stdin ?? "");
  });
}
