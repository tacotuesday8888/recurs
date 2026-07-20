import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OwnedProcessManager,
  type CheckpointStore,
  PermissionEngine,
  ToolRegistry,
  createProcessSessionTool,
  createRunCommandTool,
  type ApprovalHandler,
  type ToolContext,
} from "../src/index.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "recurs-process-session-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const deny: ApprovalHandler = {
  async request() {
    return "deny";
  },
};

function context(
  sessionId = "owner-1",
  signal = new AbortController().signal,
): ToolContext {
  return {
    sessionId,
    cwd,
    signal,
    executionMode: "act",
    readRevisions: new Map(),
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

async function invoke(
  registry: ToolRegistry,
  name: string,
  arguments_: unknown,
  toolContext = context(),
) {
  return registry.invoke(
    { id: `${name}-call`, name, arguments: arguments_ },
    toolContext,
    new PermissionEngine("full_access"),
    deny,
  );
}

describe("owned process sessions", () => {
  it("runs, resizes, and owns an injected interactive terminal session", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const resize = vi.fn();
    let resolveCompletion: (exitCode: number) => void = () => {};
    const completion = new Promise<number>((resolve) => {
      resolveCompletion = resolve;
    });
    const startTerminalSession = vi.fn(async () => ({
      stdin,
      stdout,
      stderr: new PassThrough(),
      completion,
      resize,
      async close() {
        resolveCompletion(0);
      },
    }));
    const processes = new OwnedProcessManager({ startTerminalSession });
    const registry = new ToolRegistry([
      createRunCommandTool(processes),
      createProcessSessionTool(processes),
    ]);

    try {
      stdout.write("ready\n");
      const started = await invoke(registry, "run_command", {
        command: "interactive-command",
        tty: true,
        timeoutMs: 5_000,
        yieldTimeMs: 250,
      });
      expect(startTerminalSession).toHaveBeenCalledWith(
        "/bin/sh",
        ["-c", "interactive-command"],
        expect.objectContaining({ cwd }),
        { columns: 120, rows: 30 },
      );
      expect(started.metadata).toMatchObject({
        status: "running",
        terminal: true,
      });
      expect(started.output).toContain("ready");

      const resized = await invoke(registry, "process_session", {
        action: "resize",
        sessionId: started.metadata?.sessionId,
        columns: 132,
        rows: 42,
      });
      expect(resize).toHaveBeenCalledWith(132, 42);
      expect(resized.metadata).toMatchObject({ terminal: true });

      await expect(invoke(registry, "process_session", {
        action: "write",
        sessionId: started.metadata?.sessionId,
        closeStdin: true,
      })).rejects.toMatchObject({
        code: "invalid_input",
        message: expect.stringContaining("do not support closing stdin"),
      });
    } finally {
      await processes.close();
    }
  });

  it("fails closed when an interactive terminal driver is unavailable", async () => {
    const startSession = vi.fn();
    const processes = new OwnedProcessManager({ startSession });
    const registry = new ToolRegistry([createRunCommandTool(processes)]);
    try {
      await expect(invoke(registry, "run_command", {
        command: "interactive-command",
        tty: true,
        yieldTimeMs: 250,
      })).rejects.toMatchObject({
        code: "tool_unavailable",
        message: expect.stringContaining("terminal sessions are unavailable"),
      });
      expect(startSession).not.toHaveBeenCalled();
    } finally {
      await processes.close();
    }
  });

  it("yields a running command and returns only new output until exit", async () => {
    const processes = new OwnedProcessManager();
    const registry = new ToolRegistry([
      createRunCommandTool(processes),
      createProcessSessionTool(processes),
    ]);

    try {
      const started = await invoke(registry, "run_command", {
        command: `${process.execPath} -e 'process.stdout.write("ready\\n"); process.stdin.once("data", value => { process.stdout.write("done:" + value); })' # test`,
        timeoutMs: 5_000,
        yieldTimeMs: 250,
      });
      expect(started.output).toMatch(/ready[\s\S]*Process session [0-9a-f-]+ is running/u);
      const sessionId = started.metadata?.sessionId;
      expect(sessionId).toEqual(expect.any(String));

      const written = await invoke(registry, "process_session", {
        action: "write",
        sessionId,
        input: "hello\\n",
        closeStdin: true,
        yieldTimeMs: 5_000,
      });
      expect(written.output).toContain("done:hello");
      expect(written.output).not.toContain("ready");
      const finished = written.metadata?.status === "running"
        ? await invoke(registry, "process_session", {
            action: "poll",
            sessionId,
            yieldTimeMs: 5_000,
          })
        : written;
      expect(finished.output).toContain("Process exited with code 0.");
      expect(finished.metadata).toMatchObject({ status: "exited", exitCode: 0 });
      expect(finished.metadata?.evidence).toEqual([
        expect.stringMatching(/# test exited 0$/u),
      ]);
    } finally {
      await processes.close();
    }
  });

  it("does not let another agent inspect or control a process", async () => {
    const processes = new OwnedProcessManager();
    const registry = new ToolRegistry([
      createRunCommandTool(processes),
      createProcessSessionTool(processes),
    ]);

    try {
      const started = await invoke(registry, "run_command", {
        command: `${process.execPath} -e 'process.stdin.resume()'`,
        timeoutMs: 5_000,
        yieldTimeMs: 250,
      });

      await expect(invoke(
        registry,
        "process_session",
        {
          action: "poll",
          sessionId: started.metadata?.sessionId,
        },
        context("owner-2"),
      )).rejects.toMatchObject({
        code: "not_found",
        message: "Process session not found",
      });
    } finally {
      await processes.close();
    }
  });

  it("lists owner-scoped sessions without consuming buffered output", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let resolveCompletion: (exitCode: number) => void = () => {};
    const completion = new Promise<number>((resolve) => {
      resolveCompletion = resolve;
    });
    const processes = new OwnedProcessManager({
      createId: () => "process-1",
      startSession: async () => ({
        stdin,
        stdout,
        stderr: new PassThrough(),
        completion,
        async close() {
          resolveCompletion(0);
        },
      }),
    });

    try {
      await processes.start({
        ownerId: "owner-1",
        command: "command",
        args: [],
        options: { cwd },
        yieldTimeMs: 0,
      });
      stdout.write("later");

      expect(processes.list("owner-2")).toEqual([]);
      expect(processes.list("owner-1")).toEqual([{
        sessionId: "process-1",
        status: "running",
        terminal: false,
        bufferedOutputBytes: 5,
      }]);
      expect(processes.list("owner-1")[0]?.bufferedOutputBytes).toBe(5);

      const polled = await processes.interact({
        ownerId: "owner-1",
        sessionId: "process-1",
        yieldTimeMs: 0,
      });
      expect(polled.output).toBe("later");
      expect(processes.list("owner-1")[0]?.bufferedOutputBytes).toBe(0);

      resolveCompletion(0);
      const finished = await processes.interact({
        ownerId: "owner-1",
        sessionId: "process-1",
        yieldTimeMs: 5_000,
      });
      expect(finished).toMatchObject({ status: "exited", exitCode: 0 });
      expect(processes.list("owner-1")).toEqual([]);
    } finally {
      await processes.close();
    }
  });

  it("enforces the active-session limit and releases capacity after stop", async () => {
    const processes = new OwnedProcessManager({ maxActiveSessions: 1 });
    const registry = new ToolRegistry([
      createRunCommandTool(processes),
      createProcessSessionTool(processes),
    ]);

    try {
      const first = await invoke(registry, "run_command", {
        command: `${process.execPath} -e 'process.stdin.resume()'`,
        timeoutMs: 5_000,
        yieldTimeMs: 250,
      });
      await expect(invoke(registry, "run_command", {
        command: `${process.execPath} -e 'process.stdin.resume()'`,
        timeoutMs: 5_000,
        yieldTimeMs: 250,
      })).rejects.toMatchObject({
        code: "execution_failed",
        message: "The active process session limit has been reached",
      });

      await expect(invoke(registry, "process_session", {
        action: "stop",
        sessionId: first.metadata?.sessionId,
      })).resolves.toMatchObject({
        metadata: { status: "exited" },
      });
      await expect(invoke(registry, "run_command", {
        command: `${process.execPath} -e 'process.stdin.resume()'`,
        timeoutMs: 5_000,
        yieldTimeMs: 250,
      })).resolves.toMatchObject({
        metadata: { status: "running" },
      });
    } finally {
      await processes.close();
    }
  });

  it("bounds completed sessions until their final output is collected", async () => {
    let resolveFirst: (exitCode: number) => void = () => {};
    const firstCompletion = new Promise<number>((resolve) => {
      resolveFirst = resolve;
    });
    let starts = 0;
    const processes = new OwnedProcessManager({
      maxActiveSessions: 1,
      startSession: vi.fn(async () => {
        const stdin = new PassThrough();
        return {
          stdin,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          completion: starts++ === 0
            ? firstCompletion
            : Promise.resolve(0),
          async close() {
            stdin.end();
          },
        };
      }),
    });

    try {
      const first = await processes.start({
        ownerId: "owner-1",
        command: "command",
        args: [],
        options: { cwd },
        yieldTimeMs: 0,
      });
      resolveFirst(0);
      await new Promise<void>((resolve) => setImmediate(resolve));

      await expect(processes.start({
        ownerId: "owner-1",
        command: "command",
        args: [],
        options: { cwd },
        yieldTimeMs: 0,
      })).rejects.toMatchObject({
        code: "execution_failed",
        message: "The active process session limit has been reached",
      });
      await expect(processes.interact({
        ownerId: "owner-1",
        sessionId: first.sessionId,
        yieldTimeMs: 0,
      })).resolves.toMatchObject({ status: "exited", exitCode: 0 });
      await expect(processes.start({
        ownerId: "owner-1",
        command: "command",
        args: [],
        options: { cwd },
        yieldTimeMs: 0,
      })).resolves.toMatchObject({ status: "exited", exitCode: 0 });
    } finally {
      await processes.close();
    }
  });

  it("reports timeout as a tool failure and releases the session", async () => {
    const processes = new OwnedProcessManager({ maxActiveSessions: 1 });
    const registry = new ToolRegistry([
      createRunCommandTool(processes),
      createProcessSessionTool(processes),
    ]);

    try {
      await expect(invoke(registry, "run_command", {
        command: `${process.execPath} -e 'process.stdin.resume()'`,
        timeoutMs: 25,
        yieldTimeMs: 250,
      })).rejects.toMatchObject({ code: "command_timeout" });
      await expect(invoke(registry, "run_command", {
        command: "printf recovered",
        timeoutMs: 1_000,
        yieldTimeMs: 1_000,
      })).resolves.toMatchObject({
        output: "recovered\nProcess exited with code 0.",
        metadata: { status: "exited", exitCode: 0 },
      });
    } finally {
      await processes.close();
    }
  });

  it("reports immediate and yielded nonzero exits as typed terminal failures", async () => {
    const processes = new OwnedProcessManager();
    const registry = new ToolRegistry([
      createRunCommandTool(processes),
      createProcessSessionTool(processes),
    ]);
    const canary = "RECURS_PROCESS_SESSION_STDERR_CANARY";

    try {
      let immediateFailure: unknown;
      try {
        await invoke(registry, "run_command", {
          command: `printf '%s' '${canary}' >&2; exit 23`,
          timeoutMs: 1_000,
          yieldTimeMs: 1_000,
        });
      } catch (error) {
        immediateFailure = error;
      }
      expect(immediateFailure).toMatchObject({
        code: "process_failed",
        message: "Process exited with 23",
      });
      expect(String((immediateFailure as Error).message)).not.toContain(canary);

      const started = await invoke(registry, "run_command", {
        command: `${process.execPath} -e 'process.stdout.write("ready"); process.stdin.once("data", () => { process.stderr.write("${canary}"); process.exit(29); })'`,
        timeoutMs: 5_000,
        yieldTimeMs: 250,
      });
      expect(started.metadata).toMatchObject({ status: "running" });
      let thrown: unknown;
      try {
        const written = await invoke(registry, "process_session", {
          action: "write",
          sessionId: started.metadata?.sessionId,
          input: "finish\\n",
          closeStdin: true,
          yieldTimeMs: 5_000,
        });
        if (written.metadata?.status === "running") {
          await invoke(registry, "process_session", {
            action: "poll",
            sessionId: started.metadata?.sessionId,
            yieldTimeMs: 5_000,
          });
        }
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        code: "process_failed",
        message: "Process exited with 29",
      });
      expect(String((thrown as Error).message)).not.toContain(canary);
    } finally {
      await processes.close();
    }
  });

  it("terminates every owned process when the manager closes", async () => {
    const processes = new OwnedProcessManager();
    const registry = new ToolRegistry([createRunCommandTool(processes)]);
    const pidPath = path.join(cwd, "owned.pid");
    const script = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
      "process.stdout.write('ready');",
      "process.stdin.resume();",
    ].join("");
    let pid: number | undefined;
    try {
      const started = await invoke(registry, "run_command", {
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
        timeoutMs: 5_000,
        yieldTimeMs: 250,
      });
      expect(started.metadata).toMatchObject({ status: "running" });
      expect(started.output).toContain("ready");
      pid = Number.parseInt(await readFile(pidPath, "utf8"), 10);
      expect(processExists(pid)).toBe(true);

      await processes.close();
      expect(processExists(pid)).toBe(false);

      await expect(invoke(registry, "run_command", {
        command: "printf never",
        yieldTimeMs: 250,
      })).rejects.toMatchObject({
        code: "tool_unavailable",
        message: "Process sessions are closed",
      });
    } finally {
      await processes.close().catch(() => {});
      if (pid !== undefined && processExists(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("keeps a workspace checkpoint open for the full process lifetime", async () => {
    const checkpoint = {
      id: "checkpoint-1",
      sessionId: "owner-1",
      toolCallId: "process-1",
      before: {},
    };
    const checkpoints = {
      captureBefore: vi.fn(async () => checkpoint),
      captureAfter: vi.fn(async () => ({ ...checkpoint, after: {} })),
    } as unknown as CheckpointStore;
    const processes = new OwnedProcessManager({
      checkpoints,
      createId: () => "process-1",
    });
    const registry = new ToolRegistry([
      createRunCommandTool(processes),
      createProcessSessionTool(processes),
    ]);

    try {
      const started = await invoke(registry, "run_command", {
        command: `${process.execPath} -e 'process.stdout.write("ready"); process.stdin.resume()'`,
        timeoutMs: 5_000,
        yieldTimeMs: 250,
      });
      expect(started.metadata).toMatchObject({ status: "running" });
      expect(checkpoints.captureBefore).toHaveBeenCalledWith(
        "owner-1",
        "process-1",
        cwd,
      );
      expect(checkpoints.captureAfter).not.toHaveBeenCalled();

      const stopped = await invoke(registry, "process_session", {
        action: "stop",
        sessionId: "process-1",
      });
      expect(stopped.metadata).toMatchObject({ checkpointId: "checkpoint-1" });
      expect(checkpoints.captureAfter).toHaveBeenCalledOnce();
      expect(checkpoints.captureAfter).toHaveBeenCalledWith(checkpoint, cwd);
    } finally {
      await processes.close();
    }
  });

  it("validates process actions before touching the manager", async () => {
    const processes = new OwnedProcessManager();
    const registry = new ToolRegistry([createProcessSessionTool(processes)]);
    try {
      await expect(invoke(registry, "process_session", {
        action: "write",
        sessionId: "session-1",
        input: "x".repeat(65_537),
      })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(invoke(registry, "process_session", {
        action: "poll",
        sessionId: "session-1",
        input: "unexpected",
      })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(invoke(registry, "process_session", {
        action: "resize",
        sessionId: "session-1",
        columns: 10,
        rows: 40,
      })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(invoke(registry, "process_session", {
        action: "poll",
        sessionId: "session-1",
        columns: 80,
        rows: 24,
      })).rejects.toMatchObject({ code: "invalid_input" });
      expect(registry.definitions("plan").map((tool) => tool.name)).toEqual([
        "process_session",
      ]);
      await expect(invoke(
        registry,
        "process_session",
        { action: "write", sessionId: "session-1", input: "x" },
        { ...context(), executionMode: "plan" },
      )).rejects.toMatchObject({ code: "plan_mode_denied" });
    } finally {
      await processes.close();
    }
  });
});
