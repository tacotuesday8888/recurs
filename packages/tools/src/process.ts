import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";

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
  sandbox?: {
    readonly mode: "workspace";
    readonly network: "allow" | "deny";
  };
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessSessionOptions {
  cwd: string;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  timeoutMs?: number;
  sandbox?: {
    readonly mode: "workspace";
    readonly network: "allow" | "deny";
  };
}

export interface ProcessSession {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly completion: Promise<number>;
  close(): Promise<void>;
}

interface ProcessLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

const DARWIN_SANDBOX_PROFILE = [
  "(version 1)",
  "(deny default)",
  "(allow process-exec process-fork)",
  "(allow process-info* (target same-sandbox))",
  "(allow signal (target same-sandbox))",
  "(allow sysctl-read)",
  "(allow sysctl-write (sysctl-name \"kern.grade_cputype\"))",
  "(allow mach-lookup)",
  "(allow ipc-posix*)",
  "(allow iokit-open)",
  "(allow pseudo-tty)",
  "(allow file-ioctl)",
  "(allow user-preference-read)",
  "(allow file-read*",
  "  (require-all",
  '    (subpath "/")',
  '    (require-not (literal (param "HOME_SSH")))',
  '    (require-not (subpath (param "HOME_SSH")))',
  '    (require-not (literal (param "HOME_AWS")))',
  '    (require-not (subpath (param "HOME_AWS")))',
  '    (require-not (literal (param "HOME_GCLOUD")))',
  '    (require-not (subpath (param "HOME_GCLOUD")))',
  '    (require-not (literal (param "HOME_KUBE")))',
  '    (require-not (subpath (param "HOME_KUBE")))',
  '    (require-not (literal (param "HOME_DOCKER")))',
  '    (require-not (subpath (param "HOME_DOCKER")))',
  '    (require-not (literal (param "HOME_KEYCHAINS")))',
  '    (require-not (subpath (param "HOME_KEYCHAINS")))',
  '    (require-not (literal (param "HOME_NETRC")))',
  '    (require-not (literal (param "HOME_NPMRC")))',
  '    (require-not (literal (param "HOME_GIT_CREDENTIALS")))',
  "  )",
  ")",
  '(allow file-write* (subpath (param "WORKSPACE")))',
  '(allow file-write* (subpath (param "PRIVATE_ROOT")))',
  '(allow file-write-data (literal "/dev/null"))',
].join("\n");

function sandboxLaunch(
  command: string,
  args: readonly string[],
  options: NonNullable<RunProcessOptions["sandbox"]>,
  environment: Awaited<ReturnType<typeof createIsolatedProcessEnvironment>>,
): ProcessLaunch {
  if (process.platform !== "darwin") {
    throw new ToolError(
      "sandbox_unavailable",
      `Workspace sandboxing is unavailable on ${process.platform}`,
    );
  }
  const configuredHostHome = process.env.HOME;
  if (configuredHostHome === undefined || !path.isAbsolute(configuredHostHome)) {
    throw new ToolError(
      "sandbox_unavailable",
      "Workspace sandboxing requires a canonical host home",
    );
  }
  let hostHome: string;
  let workspaceRoot: string;
  let privateRoot: string;
  try {
    hostHome = realpathSync(configuredHostHome);
    workspaceRoot = realpathSync(environment.workspaceRoot);
    privateRoot = realpathSync(environment.privateRoot);
  } catch (error) {
    throw new ToolError(
      "sandbox_unavailable",
      "Workspace sandboxing could not canonicalize its filesystem roots",
      { cause: error },
    );
  }
  const profile = options.network === "deny"
    ? DARWIN_SANDBOX_PROFILE
    : `${DARWIN_SANDBOX_PROFILE}\n(allow network*)`;
  const definitions = [
    ["WORKSPACE", workspaceRoot],
    ["PRIVATE_ROOT", privateRoot],
    ["HOME_SSH", path.join(hostHome, ".ssh")],
    ["HOME_AWS", path.join(hostHome, ".aws")],
    ["HOME_GCLOUD", path.join(hostHome, ".config", "gcloud")],
    ["HOME_KUBE", path.join(hostHome, ".kube")],
    ["HOME_DOCKER", path.join(hostHome, ".docker")],
    ["HOME_KEYCHAINS", path.join(hostHome, "Library", "Keychains")],
    ["HOME_NETRC", path.join(hostHome, ".netrc")],
    ["HOME_NPMRC", path.join(hostHome, ".npmrc")],
    ["HOME_GIT_CREDENTIALS", path.join(hostHome, ".git-credentials")],
  ] as const;
  return {
    command: "/usr/bin/sandbox-exec",
    args: [
      "-p",
      profile,
      ...definitions.flatMap(([key, value]) => ["-D", `${key}=${value}`]),
      command,
      ...args,
    ],
  };
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

export async function startProcessSession(
  command: string,
  args: readonly string[],
  options: ProcessSessionOptions,
): Promise<ProcessSession> {
  assertSupportedProcessPlatform(process.platform);
  if (isAborted(options.signal)) {
    throw new ToolError("cancelled", `${command} was cancelled`);
  }
  const maxOutputBytes = options.maxOutputBytes ?? 512 * 1024;
  const isolatedEnvironment = await createIsolatedProcessEnvironment(
    options.cwd,
    process.env,
  );
  let child: ReturnType<typeof spawn>;
  try {
    const launch = options.sandbox === undefined
      ? { command, args }
      : sandboxLaunch(command, args, options.sandbox, isolatedEnvironment);
    child = spawn(launch.command, [...launch.args], {
      cwd: options.cwd,
      env: isolatedEnvironment.environment,
      shell: false,
      stdio: createToolChildStdio(),
      windowsHide: true,
      detached: true,
    });
  } catch (error) {
    await isolatedEnvironment.cleanup();
    throw new ToolError("process_failed", `Failed to start ${command}`, {
      cause: error,
    });
  }
  const childStdin = child.stdin;
  const childStdout = child.stdout;
  const childStderr = child.stderr;
  if (childStdin === null || childStdout === null || childStderr === null) {
    if (child.pid !== undefined) await terminateProcessGroup(child.pid).catch(() => {});
    await isolatedEnvironment.cleanup();
    throw new ToolError("process_failed", "The tool child stdio boundary is invalid");
  }

  let outputBytes = 0;
  const sessionStdout = new PassThrough();
  const sessionStderr = new PassThrough();
  let failure: ToolError | undefined;
  let cleanupFailed = false;
  let terminationPromise: Promise<void> | undefined;
  let settlementPromise: Promise<void> | undefined;
  let resolveExit: (exitCode: number) => void = () => {};
  let rejectExit: (error: ToolError) => void = () => {};
  const completion = new Promise<number>((resolve, reject) => {
    resolveExit = resolve;
    rejectExit = reject;
  });
  void completion.catch(() => {});

  const setFailure = (error: ToolError): void => {
    failure ??= error;
  };
  const startTermination = (): Promise<void> => {
    terminationPromise ??= child.pid === undefined
      ? Promise.resolve()
      : terminateProcessGroup(child.pid);
    void terminationPromise.catch(() => {});
    return terminationPromise;
  };
  const settle = (exitCode: number): Promise<void> => {
    settlementPromise ??= (async () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      try {
        await isolatedEnvironment.cleanup();
      } catch {
        cleanupFailed = true;
        setFailure(new ToolError(
          "process_failed",
          "The isolated process environment could not be cleaned up",
        ));
      }
      if (failure === undefined) {
        resolveExit(exitCode);
      } else {
        rejectExit(failure);
      }
    })();
    return settlementPromise;
  };
  const terminateFor = (error: ToolError): void => {
    setFailure(error);
    void startTermination().then(
      () => {},
      () => {
        cleanupFailed = true;
        setFailure(new ToolError(
          "process_failed",
          "The child process group could not be cleaned up",
        ));
      },
    );
  };
  function onAbort(): void {
    terminateFor(new ToolError("cancelled", `${command} was cancelled`));
  }

  const timeout = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
        terminateFor(new ToolError(
          "command_timeout",
          `${command} exceeded the ${options.timeoutMs}ms timeout`,
        ));
      }, options.timeoutMs);
  timeout?.unref();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (isAborted(options.signal)) onAbort();

  const forwardOutput = (target: PassThrough, chunk: Buffer): void => {
    outputBytes += chunk.byteLength;
    if (outputBytes > maxOutputBytes) {
      terminateFor(new ToolError(
        "output_limit",
        `${command} exceeded the ${maxOutputBytes}-byte output limit`,
      ));
      return;
    }
    target.write(chunk);
  };
  childStdout.on("data", (chunk: Buffer) => forwardOutput(sessionStdout, chunk));
  childStderr.on("data", (chunk: Buffer) => forwardOutput(sessionStderr, chunk));
  childStdout.once("close", () => sessionStdout.end());
  childStderr.once("close", () => sessionStderr.end());
  childStdout.once("error", () => terminateFor(new ToolError(
    "process_failed",
    `${command} output could not be read`,
  )));
  childStderr.once("error", () => terminateFor(new ToolError(
    "process_failed",
    `${command} output could not be read`,
  )));
  childStdin.on("error", () => {
    // Exit and protocol handling provide the useful failure.
  });
  child.once("error", () => {
    setFailure(new ToolError("process_failed", `Failed to start ${command}`));
  });
  child.once("close", (code) => {
    void settle(code ?? -1);
  });

  await new Promise<void>((resolve, reject) => {
    if (child.pid !== undefined) {
      resolve();
      return;
    }
    child.once("spawn", resolve);
    child.once("error", () => reject(
      new ToolError("process_failed", `Failed to start ${command}`),
    ));
  }).catch(async (error: unknown) => {
    await startTermination().catch(() => {});
    await isolatedEnvironment.cleanup();
    throw error;
  });

  return {
    stdin: childStdin,
    stdout: sessionStdout,
    stderr: sessionStderr,
    completion,
    async close() {
      childStdin.end();
      try {
        await startTermination();
      } catch {
        cleanupFailed = true;
        setFailure(new ToolError(
          "process_failed",
          "The child process group could not be cleaned up",
        ));
      }
      await completion.then(() => {}, () => {});
      if (cleanupFailed) {
        throw new ToolError(
          "process_failed",
          "The child process session could not be cleaned up",
        );
      }
    },
  };
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
    process.env,
    {
      seedAppleDeveloperToolCache:
        command === "git" || command === "/usr/bin/git",
    },
  );

  try {
    if (isAborted(options.signal)) {
      throw new ToolError("cancelled", `${command} was cancelled`);
    }
    const launch = options.sandbox === undefined
      ? { command, args }
      : sandboxLaunch(command, args, options.sandbox, isolatedEnvironment);
    return await new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(launch.command, [...launch.args], {
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
