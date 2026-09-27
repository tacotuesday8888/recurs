import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { installTerminationCleanup } from "../src/termination.js";

function harness(signals: ("SIGHUP" | "SIGINT" | "SIGTERM")[], deadlineMs = 5_000) {
  const target = new EventEmitter();
  const output = new EventEmitter();
  const events: string[] = [];
  const exited = new Promise<number>((resolve) => {
    const cleanup = installTerminationCleanup({
      signals,
      deadlineMs,
      target: target as unknown as NodeJS.Process,
      outputs: [output],
      restoreTerminal: () => events.push("restore"),
      exit: (code) => { events.push(`exit ${code}`); resolve(code); },
    });
    Object.assign(target, { cleanup });
  });
  const { cleanup } = target as unknown as { cleanup: ReturnType<typeof installTerminationCleanup> };
  return { target, output, events, exited, cleanup };
}

describe("termination cleanup", () => {
  it("restores the terminal, closes every resource, then exits with 128 + signal", async () => {
    const { target, events, exited, cleanup } = harness(["SIGHUP", "SIGTERM"]);
    cleanup.register(async () => { events.push("close runtime"); });
    cleanup.register(async () => { events.push("close second runtime"); });
    target.emit("SIGTERM");
    expect(await exited).toBe(143);
    expect(events).toEqual(["restore", "close runtime", "close second runtime", "exit 143"]);
  });

  it("maps hang-ups and interrupts to their conventional exit codes", async () => {
    const hangup = harness(["SIGHUP"]);
    hangup.target.emit("SIGHUP");
    expect(await hangup.exited).toBe(129);
    const interrupt = harness(["SIGINT"]);
    interrupt.target.emit("SIGINT");
    expect(await interrupt.exited).toBe(130);
  });

  it("still exits when restoring or closing fails, and ignores errors from a closed terminal", async () => {
    const target = new EventEmitter();
    const output = new EventEmitter();
    const exit = vi.fn();
    const cleanup = installTerminationCleanup({
      signals: ["SIGHUP"], target: target as unknown as NodeJS.Process, outputs: [output], exit,
      restoreTerminal: () => { throw new Error("EIO"); },
    });
    cleanup.register(async () => { throw new Error("close failed"); });
    target.emit("SIGHUP");
    expect(() => output.emit("error", new Error("write EIO"))).not.toThrow();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(129));
  });

  it("exits at the deadline when a resource never finishes closing", async () => {
    vi.useFakeTimers();
    try {
      const { target, exited, cleanup } = harness(["SIGTERM"], 5_000);
      cleanup.register(() => new Promise(() => {}));
      target.emit("SIGTERM");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await exited).toBe(143);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exits immediately on a second signal and removes its handlers when disposed", async () => {
    const target = new EventEmitter();
    const exit = vi.fn();
    const cleanup = installTerminationCleanup({ signals: ["SIGINT", "SIGTERM"], target: target as unknown as NodeJS.Process, outputs: [], exit });
    cleanup.register(() => new Promise(() => {}));
    target.emit("SIGINT");
    expect(exit).not.toHaveBeenCalled();
    target.emit("SIGTERM");
    expect(exit).toHaveBeenCalledWith(143);
    cleanup.dispose();
    expect(target.listenerCount("SIGINT") + target.listenerCount("SIGTERM")).toBe(0);
  });
});
