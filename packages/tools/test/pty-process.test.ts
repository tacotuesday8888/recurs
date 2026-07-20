import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  startPtyProcessSession,
  type PtyDriver,
  type PtyProcess,
} from "../src/index.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "recurs-pty-process-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

class FakePty implements PtyProcess {
  readonly pid = 2_000_000_000;
  readonly write = vi.fn();
  readonly resize = vi.fn();
  readonly kill = vi.fn();
  #data: ((data: string) => void) | undefined;
  #exit: ((event: { exitCode: number; signal?: number }) => void) | undefined;

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#data = listener;
    return { dispose: () => { this.#data = undefined; } };
  }

  onExit(
    listener: (event: { exitCode: number; signal?: number }) => void,
  ): { dispose(): void } {
    this.#exit = listener;
    return { dispose: () => { this.#exit = undefined; } };
  }

  emitData(data: string): void {
    this.#data?.(data);
  }

  emitExit(exitCode: number): void {
    this.#exit?.({ exitCode });
  }
}

function fakeDriver(pty: FakePty): PtyDriver {
  return { spawn: vi.fn(() => pty) };
}

describe("PTY process lifecycle", () => {
  it("forwards terminal input/output and resize through the injected driver", async () => {
    const pty = new FakePty();
    const driver = fakeDriver(pty);
    const session = await startPtyProcessSession(
      driver,
      "/bin/sh",
      ["-c", "printf ready"],
      { cwd },
      { columns: 80, rows: 24 },
    );
    let output = "";
    session.stdout.setEncoding("utf8");
    session.stdout.on("data", (chunk: string) => { output += chunk; });

    pty.emitData("ready\r\n");
    session.stdin.write("next\n");
    session.resize?.(100, 40);
    pty.emitExit(0);

    await expect(session.completion).resolves.toBe(0);
    expect(output).toBe("ready\r\n");
    expect(pty.write).toHaveBeenCalledWith("next\n");
    expect(pty.resize).toHaveBeenCalledWith(100, 40);
    expect(pty.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("fails closed and terminates when terminal output exceeds its bound", async () => {
    const pty = new FakePty();
    const session = await startPtyProcessSession(
      fakeDriver(pty),
      "/bin/sh",
      ["-c", "yes"],
      { cwd, maxOutputBytes: 4 },
      { columns: 80, rows: 24 },
    );

    pty.emitData("12345");

    await expect(session.completion).rejects.toMatchObject({
      code: "output_limit",
    });
    expect(pty.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("propagates cancellation and terminates the terminal process", async () => {
    const controller = new AbortController();
    const pty = new FakePty();
    const session = await startPtyProcessSession(
      fakeDriver(pty),
      "/bin/sh",
      ["-c", "sleep 60"],
      { cwd, signal: controller.signal },
      { columns: 80, rows: 24 },
    );

    controller.abort();

    await expect(session.completion).rejects.toMatchObject({ code: "cancelled" });
    expect(pty.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
