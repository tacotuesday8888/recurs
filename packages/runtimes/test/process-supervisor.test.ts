import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  spawnManagedAcpProcess,
  type AcpProcessBounds,
  type ManagedAcpProcess,
} from "../src/process-supervisor.js";

const fixture = fileURLToPath(
  new URL("./fixtures/fake-acp-agent.mjs", import.meta.url),
);

const bounds: AcpProcessBounds = {
  maxFrameBytes: 8_192,
  maxStdinBytes: 64 * 1_024,
  maxStdoutBytes: 64 * 1_024,
  maxStderrBytes: 1_024,
  maxFrames: 128,
  maxInboundQueueMessages: 16,
  maxInboundQueueBytes: 32 * 1_024,
  startupTimeoutMs: 1_000,
  shutdownTimeoutMs: 300,
};

const processes: ManagedAcpProcess[] = [];

afterEach(async () => {
  await Promise.all(processes.splice(0).map(async (process) => {
    await process.shutdown().catch(() => undefined);
  }));
});

async function spawnScenario(
  scenario: string,
  overrides: Partial<AcpProcessBounds> = {},
): Promise<ManagedAcpProcess> {
  const managed = await spawnManagedAcpProcess({
    command: process.execPath,
    args: [fixture, "--scenario", scenario],
    allowedEnvironmentKeys: [],
    bounds: { ...bounds, ...overrides },
  });
  processes.push(managed);
  return managed;
}

async function initialize(process: ManagedAcpProcess): Promise<unknown> {
  const writer = process.stream.writable.getWriter();
  const reader = process.stream.readable.getReader();
  await writer.write({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: 1 },
  });
  return (await reader.read()).value;
}

async function initializationFailure(process: ManagedAcpProcess): Promise<unknown> {
  try {
    await initialize(process);
    return await Promise.race([
      process.failure,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("expected ACP process failure")),
          500,
        );
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    return error;
  }
}

describe("bounded ACP process supervision", () => {
  it("accepts fragmented CRLF frames after validating the envelope", async () => {
    const process = await spawnScenario("fragmented");
    await expect(initialize(process)).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1 },
    });
  });

  it("enforces the initialize-to-open transport state transition", async () => {
    const first = await spawnScenario("happy");
    const firstWriter = first.stream.writable.getWriter();
    await expect(firstWriter.write({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "early" },
    })).rejects.toThrow("initialize must be the first request");

    const repeated = await spawnScenario("happy");
    const writer = repeated.stream.writable.getWriter();
    const reader = repeated.stream.readable.getReader();
    await writer.write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1 },
    });
    await reader.read();
    await expect(writer.write({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: 1 },
    })).rejects.toThrow("initialize request was repeated");
  });

  it.each([
    ["invalid-utf8", "invalid UTF-8"],
    ["malformed-json", "invalid JSON"],
    ["invalid-envelope", "invalid JSON-RPC"],
    ["unknown-response", "unknown response"],
    ["duplicate-response", "unknown response"],
    ["fractional-id", "invalid JSON-RPC response"],
    ["null-id", "invalid JSON-RPC response"],
    ["result-and-error", "invalid JSON-RPC response"],
    ["unknown-method", "unsupported inbound method"],
    ["request-shaped-update", "invalid method shape"],
    ["notification-shaped-permission", "invalid method shape"],
    ["request-shaped-cancel", "invalid method shape"],
    ["partial-frame", "partial frame"],
  ])("fails closed for %s without returning raw bytes", async (scenario, safeText) => {
    const process = await spawnScenario(scenario);
    expect(String(await initializationFailure(process))).toContain(safeText);
  });

  it("enforces independent frame and stdout bounds", async () => {
    const frame = await spawnScenario("oversized-frame", { maxFrameBytes: 128 });
    await expect(initialize(frame)).rejects.toThrow("frame limit");

    const stdout = await spawnScenario("oversized-frame", {
      maxFrameBytes: 128,
      maxStdoutBytes: 128,
    });
    await expect(initialize(stdout)).rejects.toThrow("stdout limit");
  });

  it("enforces frame-count and queued-message bounds before delivery", async () => {
    const frames = await spawnScenario("frame-burst", { maxFrames: 2 });
    await expect(initialize(frames)).rejects.toThrow("frame count limit");

    const queue = await spawnScenario("frame-burst", { maxInboundQueueMessages: 2 });
    await expect(initialize(queue)).rejects.toThrow("queue count limit");

    const queueBytes = await spawnScenario("frame-burst", {
      maxInboundQueueBytes: 256,
    });
    await expect(initialize(queueBytes)).rejects.toThrow("queue byte limit");
  });

  it("bounds outbound frames before writing them to the child", async () => {
    const managed = await spawnScenario("happy", { maxFrameBytes: 256 });
    const writer = managed.stream.writable.getWriter();
    await expect(writer.write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { padding: "x".repeat(512) },
    })).rejects.toThrow("outbound frame limit");

    const total = await spawnScenario("happy", {
      maxFrameBytes: 1_024,
      maxStdinBytes: 1_200,
    });
    const totalWriter = total.stream.writable.getWriter();
    const totalReader = total.stream.readable.getReader();
    await totalWriter.write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1 },
    });
    await totalReader.read();
    await totalWriter.write({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { padding: "x".repeat(500) },
    });
    await expect(totalWriter.write({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { padding: "x".repeat(500) },
    })).rejects.toThrow("stdin limit");
  });

  it("counts stderr but never exposes its contents", async () => {
    const process = await spawnScenario("stderr-canary", { maxStderrBytes: 8 });
    let caught: unknown;
    try {
      await initialize(process);
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("stderr limit");
    expect(String(caught)).not.toContain("SUPER_SECRET_CANARY_VALUE");
  });

  it("reports early exit and startup timeout safely", async () => {
    const exited = await spawnScenario("early-exit");
    await expect(initialize(exited)).rejects.toThrow("exited unexpectedly");

    const hung = await spawnScenario("hang", { startupTimeoutMs: 30 });
    await expect(initialize(hung)).rejects.toThrow("startup timeout");
  });

  it("passes only explicitly allowlisted host environment variables", async () => {
    const previousAllowed = process.env.RECURS_SAFE_TEST_ENV;
    const previousBlocked = process.env.RECURS_BLOCKED_TEST_ENV;
    process.env.RECURS_SAFE_TEST_ENV = "visible";
    process.env.RECURS_BLOCKED_TEST_ENV = "must-not-leak";
    try {
      const managed = await spawnManagedAcpProcess({
        command: process.execPath,
        args: [
          fixture,
          "--scenario",
          "happy",
          "--expect-env",
          "RECURS_SAFE_TEST_ENV",
        ],
        allowedEnvironmentKeys: ["RECURS_SAFE_TEST_ENV"],
        bounds,
      });
      processes.push(managed);
      await expect(initialize(managed)).resolves.toMatchObject({
        result: { protocolVersion: 1 },
      });
      expect(managed.environmentKeys).toEqual(["RECURS_SAFE_TEST_ENV"]);
    } finally {
      if (previousAllowed === undefined) delete process.env.RECURS_SAFE_TEST_ENV;
      else process.env.RECURS_SAFE_TEST_ENV = previousAllowed;
      if (previousBlocked === undefined) delete process.env.RECURS_BLOCKED_TEST_ENV;
      else process.env.RECURS_BLOCKED_TEST_ENV = previousBlocked;
    }
  });

  it("rejects hazardous keys and secret-shaped allowlisted values", async () => {
    await expect(spawnManagedAcpProcess({
      command: process.execPath,
      args: [fixture, "--auth", "token=must-not-leak"],
      allowedEnvironmentKeys: [],
      bounds,
    })).rejects.toThrow("argument is invalid");

    await expect(spawnManagedAcpProcess({
      command: process.execPath,
      args: [fixture, "--api-key", "opaque-value"],
      allowedEnvironmentKeys: [],
      bounds,
    })).rejects.toThrow("argument is invalid");

    await expect(spawnManagedAcpProcess({
      command: process.execPath,
      args: [fixture, "--scenario", "happy"],
      allowedEnvironmentKeys: ["NODE_OPTIONS"],
      bounds,
    })).rejects.toThrow("unsafe key");

    await expect(spawnManagedAcpProcess({
      command: process.execPath,
      args: [fixture, "--scenario", "happy"],
      allowedEnvironmentKeys: ["PYTHONPATH"],
      bounds,
    })).rejects.toThrow("unsafe key");

    const previous = process.env.RECURS_SAFE_TEST_ENV;
    process.env.RECURS_SAFE_TEST_ENV = "token=must-not-leak";
    try {
      await expect(spawnManagedAcpProcess({
        command: process.execPath,
        args: [fixture, "--scenario", "happy"],
        allowedEnvironmentKeys: ["RECURS_SAFE_TEST_ENV"],
        bounds,
      })).rejects.toThrow("environment value is unsafe");
    } finally {
      if (previous === undefined) delete process.env.RECURS_SAFE_TEST_ENV;
      else process.env.RECURS_SAFE_TEST_ENV = previous;
    }
  });

  it("ends stdin and escalates bounded process-group cleanup", async () => {
    const managed = await spawnScenario("hang", { shutdownTimeoutMs: 40 });
    await managed.shutdown();
    await expect(managed.exited).resolves.toMatchObject({ exited: true });
  });

  it.runIf(process.platform !== "win32")(
    "terminates descendants in the isolated process group",
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "recurs-acp-process-"));
      const pidFile = path.join(directory, "descendant.pid");
      try {
        const managed = await spawnManagedAcpProcess({
          command: process.execPath,
          args: [
            fixture,
            "--scenario",
            "resistant-descendant",
            "--pid-file",
            pidFile,
          ],
          allowedEnvironmentKeys: [],
          bounds: { ...bounds, shutdownTimeoutMs: 120 },
        });
        processes.push(managed);
        await initialize(managed);
        const descendantPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
        expect(Number.isSafeInteger(descendantPid)).toBe(true);
        await managed.shutdown();

        let alive = true;
        for (let attempt = 0; attempt < 100 && alive; attempt += 1) {
          try {
            process.kill(descendantPid, 0);
            await new Promise((resolve) => setTimeout(resolve, 10));
          } catch {
            alive = false;
          }
        }
        expect(alive).toBe(false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
