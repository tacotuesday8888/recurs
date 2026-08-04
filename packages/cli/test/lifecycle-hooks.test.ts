import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RecursEvent } from "@recurs/core";
import { ToolError } from "@recurs/tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LifecycleHookConfigurationError,
  createLifecycleHookHost,
  inspectLifecycleHooks,
  lifecycleHookPayload,
  loadLifecycleHookConfiguration,
  renderLifecycleHookStatus,
} from "../src/lifecycle-hooks.js";

const directories: string[] = [];
const at = "2026-08-04T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function fixture(): Promise<{
  root: string;
  data: string;
  workspace: string;
  config: string;
}> {
  const created = await mkdtemp(path.join(tmpdir(), "recurs-lifecycle-hooks-"));
  directories.push(created);
  const root = await realpath(created);
  const data = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await Promise.all([
    mkdir(path.join(data, "config"), { recursive: true, mode: 0o700 }),
    mkdir(workspace, { mode: 0o700 }),
  ]);
  return { root, data, workspace, config: path.join(data, "config", "hooks.json") };
}

async function writeConfig(filename: string, value: unknown): Promise<void> {
  await writeFile(filename, JSON.stringify(value), { mode: 0o600 });
  await chmod(filename, 0o600);
}

async function writeExecutable(
  root: string,
  name: string,
  body = "#!/bin/sh\nexit 0\n",
): Promise<string> {
  const directory = path.join(root, "hooks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const command = path.join(directory, name);
  await writeFile(command, body, { mode: 0o700 });
  await chmod(command, 0o700);
  return command;
}

function collector(expectedCompletions: number): {
  readonly events: RecursEvent[];
  readonly sink: { emit(event: RecursEvent): Promise<void> };
  readonly completed: Promise<void>;
} {
  const events: RecursEvent[] = [];
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => { finish = resolve; });
  return {
    events,
    completed,
    sink: {
      async emit(event) {
        events.push(event);
        const count = events.filter((candidate) =>
          candidate.type === "lifecycle_hook_finished"
        ).length;
        if (count === expectedCompletions) finish();
      },
    },
  };
}

describe("lifecycle hook configuration", () => {
  it("loads a strict private user configuration and reports sanitized status", async () => {
    const { data, config } = await fixture();
    await writeConfig(config, {
      version: 1,
      hooks: [{
        id: "audit",
        events: ["turn.stop", "tool.stop"],
        command: "/opt/private/hooks/audit-recurs",
        timeoutMs: 750,
      }],
    });

    await expect(loadLifecycleHookConfiguration(data)).resolves.toEqual({
      version: 1,
      hooks: [{
        id: "audit",
        events: ["turn.stop", "tool.stop"],
        command: "/opt/private/hooks/audit-recurs",
        timeoutMs: 750,
      }],
    });
    const status = await inspectLifecycleHooks(data);
    expect(status).toEqual({
      version: 1,
      type: "lifecycle_hooks",
      configured: true,
      configFile: "$RECURS_HOME/config/hooks.json",
      hooks: [{
        id: "audit",
        events: ["turn.stop", "tool.stop"],
        executable: "audit-recurs",
        timeoutMs: 750,
      }],
    });
    expect(JSON.stringify(status)).not.toContain("/opt/private");
    expect(renderLifecycleHookStatus(status)).toContain(
      "Authority: observe-only · read-only workspace · network denied",
    );
  });

  it("rejects unknown fields, duplicate ids, relative commands, and public files", async () => {
    const { data, config } = await fixture();
    const invalid = [
      { version: 1, hooks: [], extra: true },
      { version: 1, hooks: [
        { id: "same", events: ["turn.start"], command: "/bin/true" },
        { id: "same", events: ["turn.stop"], command: "/bin/true" },
      ] },
      { version: 1, hooks: [
        { id: "relative", events: ["turn.start"], command: "hook" },
      ] },
      { version: 1, hooks: [
        { id: "arguments", events: ["turn.start"], command: "/bin/true", args: ["x"] },
      ] },
    ];
    for (const value of invalid) {
      await writeConfig(config, value);
      await expect(loadLifecycleHookConfiguration(data)).rejects.toBeInstanceOf(
        LifecycleHookConfigurationError,
      );
    }
    await writeConfig(config, { version: 1, hooks: [] });
    await chmod(config, 0o644);
    await expect(loadLifecycleHookConfiguration(data)).rejects.toThrow(
      "private, owned, single-link regular file",
    );
  });

  it("caps the aggregate timeout reserved by hooks for one event", async () => {
    const { data, config } = await fixture();
    await writeConfig(config, {
      version: 1,
      hooks: [
        { id: "first", events: ["turn.stop"], command: "/bin/true", timeoutMs: 3_000 },
        { id: "second", events: ["turn.stop"], command: "/bin/true", timeoutMs: 3_000 },
      ],
    });
    await expect(loadLifecycleHookConfiguration(data)).rejects.toThrow(
      "one event may reserve at most 5000ms",
    );
  });

  it("rejects symlinked configuration and non-private config directories", async () => {
    const { data, config } = await fixture();
    const target = path.join(path.dirname(config), "target.json");
    await writeConfig(target, { version: 1, hooks: [] });
    await symlink(target, config);
    await expect(loadLifecycleHookConfiguration(data)).rejects.toBeInstanceOf(
      LifecycleHookConfigurationError,
    );
    await rm(config);
    await writeConfig(config, { version: 1, hooks: [] });
    await chmod(path.dirname(config), 0o755);
    await expect(loadLifecycleHookConfiguration(data)).rejects.toThrow(
      "directory must be private, owned, and canonical",
    );
  });

  it("treats an absent configuration as a no-op host", async () => {
    const { data, workspace } = await fixture();
    const downstream = { emit: vi.fn(async () => {}) };
    const host = await createLifecycleHookHost({ dataDirectory: data, workspace, downstream });

    expect(host.events).toBe(downstream);
    await expect(host.close()).resolves.toBeUndefined();
    await expect(inspectLifecycleHooks(data)).resolves.toMatchObject({
      configured: false,
      hooks: [],
    });
  });
});

describe("lifecycle hook event boundary", () => {
  it("removes private fields and maps only canonical agent lifecycle events", () => {
    const turn = lifecycleHookPayload({
      type: "turn_started",
      sessionId: "session-1",
      at,
      turnId: "turn-1",
      prompt: "PROMPT_CANARY",
    });
    const tool = lifecycleHookPayload({
      type: "tool_started",
      sessionId: "session-1",
      at,
      call: { id: "call-1", name: "run_command", arguments: "ARGUMENT_CANARY" },
    });
    const failed = lifecycleHookPayload({
      type: "tool_failed",
      sessionId: "session-1",
      at,
      callId: "call-1",
      error: { code: "execution_failed", message: "ERROR_CANARY", retryable: false },
    });
    const companyAssignment = lifecycleHookPayload({
      type: "company_assignment_started",
      sessionId: "session-1",
      at,
      parentAgentId: "parent",
      goalRunId: "goal",
      assignmentId: "assignment",
      parentAssignmentId: null,
      departmentId: "engineering",
      roleId: "implement",
      roleName: "Implement",
      profileId: "implement_v2",
      childAgentId: "child",
      childSessionId: "child-session",
    });
    const companyGoal = lifecycleHookPayload({
      type: "company_goal_completed",
      sessionId: "session-1",
      at,
      parentAgentId: "parent",
      goalRunId: "goal-run-1",
      status: "completed",
      evidence: [],
      workflow: {
        childrenStarted: 1,
        maxChildren: 2,
        requestsReserved: 2,
        requestsUsed: 2,
        maxRequests: 4,
        reportedCostUsd: 0,
        maxReportedCostUsd: 1,
      },
    });

    expect(JSON.stringify([turn, tool, failed])).not.toMatch(
      /PROMPT_CANARY|ARGUMENT_CANARY|ERROR_CANARY/u,
    );
    expect(tool).toMatchObject({
      event: "tool.start",
      details: { toolName: "run_command", callId: "call-1" },
    });
    expect(failed).toMatchObject({
      event: "tool.stop",
      details: { outcome: "failed", errorCode: "execution_failed", retryable: false },
    });
    expect(companyAssignment).toBeNull();
    expect(companyGoal).toMatchObject({
      event: "team.stop",
      details: { outcome: "completed", goalRunId: "goal-run-1" },
    });
  });

  it("queues matching hooks without blocking the agent event path and preserves order", async () => {
    const { root, data, workspace, config } = await fixture();
    const first = await writeExecutable(root, "first");
    const second = await writeExecutable(root, "second");
    await writeConfig(config, {
      version: 1,
      hooks: [
        { id: "first", events: ["turn.start"], command: first, timeoutMs: 500 },
        { id: "second", events: ["turn.start"], command: second, timeoutMs: 600 },
      ],
    });
    const output = collector(2);
    const launches: Array<{ command: string; stdin: string; options: unknown }> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const runner = vi.fn(async (command: string, args: readonly string[], options: {
      stdin?: string;
      sandbox?: unknown;
      timeoutMs?: number;
      signal?: AbortSignal;
    }) => {
      launches.push({ command, stdin: options.stdin ?? "", options });
      expect(args).toEqual([]);
      if (launches.length === 1) {
        started();
        await gate;
      }
      return { stdout: "ignored", stderr: "", exitCode: 0 };
    });
    const host = await createLifecycleHookHost({
      dataDirectory: data,
      workspace,
      downstream: output.sink,
      processRunner: runner,
      now: () => new Date(at),
    });

    await host.events.emit({
      type: "turn_started",
      sessionId: "session-1",
      at,
      turnId: "turn-1",
      prompt: "PRIVATE_PROMPT",
    });
    await firstStarted;
    expect(output.events.map((event) => event.type)).toEqual(["turn_started"]);
    release();
    await output.completed;

    expect(launches.map((launch) => launch.command)).toEqual([first, second]);
    expect(launches[0]?.options).toMatchObject({
      cwd: workspace,
      timeoutMs: 500,
      maxOutputBytes: 8 * 1024,
      sandbox: { mode: "workspace", network: "deny", workspaceAccess: "read_only" },
    });
    expect(launches[0]?.stdin).not.toContain("PRIVATE_PROMPT");
    expect(JSON.parse(launches[0]!.stdin)).toMatchObject({
      version: 1,
      type: "recurs.lifecycle",
      event: "turn.start",
      sourceType: "turn_started",
      sessionId: "session-1",
    });
    expect(output.events.slice(1)).toMatchObject([
      { hookId: "first", outcome: "completed", at },
      { hookId: "second", outcome: "completed", at },
    ]);
    await host.close();
  });

  it("reports timeout safely without failing or recursively invoking the source event", async () => {
    const { root, data, workspace, config } = await fixture();
    const command = await writeExecutable(root, "slow");
    await writeConfig(config, {
      version: 1,
      hooks: [{ id: "slow", events: ["turn.stop"], command, timeoutMs: 50 }],
    });
    const output = collector(1);
    const runner = vi.fn(async () => {
      throw new ToolError("command_timeout", "PRIVATE_COMMAND_PATH timed out");
    });
    const host = await createLifecycleHookHost({
      dataDirectory: data,
      workspace,
      downstream: output.sink,
      processRunner: runner,
    });

    await expect(host.events.emit({
      type: "turn_completed",
      sessionId: "session-1",
      at,
      usage: null,
      evidence: ["PRIVATE_EVIDENCE"],
    })).resolves.toBeUndefined();
    await output.completed;

    expect(output.events.at(-1)).toMatchObject({
      type: "lifecycle_hook_finished",
      hookId: "slow",
      lifecycleEvent: "turn.stop",
      outcome: "timed_out",
      errorCode: "execution_failed",
    });
    expect(JSON.stringify(output.events.at(-1))).not.toContain("PRIVATE_COMMAND_PATH");
    expect(JSON.stringify(runner.mock.calls[0])).not.toContain("PRIVATE_EVIDENCE");
    await host.close();
  });

  it("fails closed when an executable changes after startup", async () => {
    const { root, data, workspace, config } = await fixture();
    const command = await writeExecutable(root, "mutable");
    await writeConfig(config, {
      version: 1,
      hooks: [{ id: "mutable", events: ["turn.start"], command, timeoutMs: 500 }],
    });
    const output = collector(1);
    const runner = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const host = await createLifecycleHookHost({
      dataDirectory: data,
      workspace,
      downstream: output.sink,
      processRunner: runner,
    });
    await writeFile(command, "#!/bin/sh\nexit 1\n# changed\n", { mode: 0o700 });

    await host.events.emit({
      type: "turn_started",
      sessionId: "session-1",
      at,
      turnId: "turn-1",
      prompt: "inspect",
    });
    await output.completed;

    expect(runner).not.toHaveBeenCalled();
    expect(output.events.at(-1)).toMatchObject({
      hookId: "mutable",
      outcome: "failed",
      errorCode: "execution_failed",
    });
    await host.close();
  });

  it("cancels a running hook during host shutdown", async () => {
    const { root, data, workspace, config } = await fixture();
    const command = await writeExecutable(root, "running");
    await writeConfig(config, {
      version: 1,
      hooks: [{ id: "running", events: ["turn.start"], command, timeoutMs: 500 }],
    });
    const output = collector(1);
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const runner = vi.fn(async (_command: string, _args: readonly string[], options: {
      signal?: AbortSignal;
    }) => {
      started();
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          reject(new ToolError("cancelled", "cancelled"));
        }, { once: true });
      });
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const host = await createLifecycleHookHost({
      dataDirectory: data,
      workspace,
      downstream: output.sink,
      processRunner: runner,
      shutdownTimeoutMs: 10,
    });
    await host.events.emit({
      type: "turn_started",
      sessionId: "session-1",
      at,
      turnId: "turn-1",
      prompt: "inspect",
    });
    await didStart;
    await host.close();
    await output.completed;

    expect(output.events.at(-1)).toMatchObject({
      hookId: "running",
      outcome: "failed",
      errorCode: "cancelled",
    });
  });

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "denies workspace mutation in the real hook sandbox",
    async () => {
      const { root, data, workspace, config } = await fixture();
      const target = path.join(workspace, "hook-mutation");
      const command = await writeExecutable(root, "mutation", "#!/bin/sh\ntouch \"$PWD/hook-mutation\"\n");
      await writeConfig(config, {
        version: 1,
        hooks: [{ id: "mutation", events: ["turn.start"], command, timeoutMs: 5_000 }],
      });
      const output = collector(1);
      const host = await createLifecycleHookHost({
        dataDirectory: data,
        workspace,
        downstream: output.sink,
      });

      await host.events.emit({
        type: "turn_started",
        sessionId: "session-1",
        at,
        turnId: "turn-1",
        prompt: "inspect only",
      });
      await output.completed;

      await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(output.events.at(-1)).toMatchObject({
        type: "lifecycle_hook_finished",
        hookId: "mutation",
        outcome: "failed",
        errorCode: "execution_failed",
      });
      await host.close();
    },
  );
});
