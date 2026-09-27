import { constants } from "node:os";
import process from "node:process";

export type TerminationSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

export interface TerminationCleanup {
  /** Close this resource before the process exits on a termination signal. */
  register(close: () => Promise<unknown>): void;
  dispose(): void;
}

interface ErrorSource {
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface TerminationCleanupOptions {
  readonly signals: readonly TerminationSignal[];
  /** Stop the terminal interface before closing resources. */
  readonly restoreTerminal?: () => void;
  readonly deadlineMs?: number;
  readonly exit?: (code: number) => void;
  readonly target?: Pick<NodeJS.Process, "on" | "removeListener">;
  readonly outputs?: readonly ErrorSource[];
}

const ignore = (): void => {};

/**
 * Node exits immediately on these signals by default. That leaves command
 * process groups Recurs detached from its own group running after the
 * terminal closes, and leaves the terminal in raw, mouse-reporting mode.
 * Restore the terminal, close owned resources, and exit with 128 + signal.
 * A second signal, or the deadline, exits without waiting further.
 */
export function installTerminationCleanup(
  options: TerminationCleanupOptions,
): TerminationCleanup {
  const target = options.target ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const closers = new Set<() => Promise<unknown>>();
  let terminating = false;
  const handlers = new Map<TerminationSignal, () => void>();
  const terminate = (signal: TerminationSignal): void => {
    const code = 128 + constants.signals[signal];
    if (terminating) {
      exit(code);
      return;
    }
    terminating = true;
    // A closed terminal fails writes with EIO or EPIPE; cleanup must continue.
    const outputs: readonly ErrorSource[] = options.outputs ?? [process.stdout, process.stderr];
    for (const output of outputs) output.on("error", ignore);
    try {
      options.restoreTerminal?.();
    } catch {
      // The terminal may already be gone.
    }
    const deadline = setTimeout(() => exit(code), options.deadlineMs ?? 5_000);
    void Promise.allSettled([...closers].map(async (close) => await close()))
      .then(() => {
        clearTimeout(deadline);
        exit(code);
      });
  };
  for (const signal of options.signals) {
    const handler = (): void => terminate(signal);
    handlers.set(signal, handler);
    target.on(signal, handler);
  }
  return {
    register(close) {
      closers.add(close);
    },
    dispose() {
      for (const [signal, handler] of handlers) target.removeListener(signal, handler);
      handlers.clear();
    },
  };
}
