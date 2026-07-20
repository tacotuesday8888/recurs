import { PassThrough, Readable, Writable } from "node:stream";

import { AgentLoopError } from "@recurs/core";
import { describe, expect, it } from "vitest";

import { startRepl, type RecursRuntime } from "../src/index.js";

class TextOutput extends Writable {
  value = "";

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.value += chunk.toString();
    callback();
  }
}

function failingRuntime(error: Error): RecursRuntime {
  let submissions = 0;
  return {
    setConfirmHandler() {},
    cancel() {
      return false;
    },
    async submit() {
      submissions += 1;
      if (submissions === 1) {
        throw error;
      }
      return { type: "quit" };
    },
  } as unknown as RecursRuntime;
}

describe("startRepl", () => {
  it("opens the shared provider view as the first sessionless onboarding step", async () => {
    const output = new TextOutput();
    const submitted: string[] = [];
    let closed = 0;
    const runtime = {
      state: { type: "workspace", cwd: "/tmp/workspace", permissionMode: "ask_always" },
      setConfirmHandler() {},
      cancel() { return false; },
      async close() { closed += 1; },
      async submit(input: string) {
        submitted.push(input);
        return input === "/provider"
          ? { type: "message", level: "info", text: "Providers\nDetected locally\n  None" }
          : { type: "quit" };
      },
    } as unknown as RecursRuntime;

    await startRepl(runtime, {
      input: Readable.from(["/quit\n"]),
      output,
      terminal: false,
    });

    expect(submitted).toEqual(["/provider", "/quit"]);
    expect(closed).toBe(1);
    expect(output.value).toContain("Let's connect the team to a model");
    expect(output.value).toContain("Detected locally");
  });

  it("renders an unknown failure with one diagnostic and no raw details", async () => {
    const output = new TextOutput();
    const canary = "RECURS_REPL_FAILURE_CANARY";

    await startRepl(
      failingRuntime(
        new Error(canary, {
          cause: new Error("RECURS_REPL_CAUSE_CANARY"),
        }),
      ),
      {
        input: Readable.from(["inspect\n", "/quit\n"]),
        output,
        terminal: false,
      },
    );

    expect(output.value).toMatch(
      /Error: Unexpected failure \(diagnostic [0-9a-f-]{36}\)/u,
    );
    expect(output.value.match(/diagnostic/gu)).toHaveLength(1);
    expect(output.value).not.toContain(canary);
    expect(output.value).not.toContain("RECURS_REPL_CAUSE_CANARY");
  });

  it("preserves the documented cancellation response", async () => {
    const output = new TextOutput();

    await startRepl(
      failingRuntime(new AgentLoopError("cancelled", "hostile cancellation detail")),
      {
        input: Readable.from(["inspect\n", "/quit\n"]),
        output,
        terminal: false,
      },
    );

    expect(output.value).toContain("Cancelled\n");
    expect(output.value).not.toContain("hostile cancellation detail");
  });

  it("accepts a follow-up line while the original run is still active", async () => {
    const output = new TextOutput();
    const input = new PassThrough();
    const submitted: string[] = [];
    let active = false;
    let finishRun!: () => void;
    let markInspect!: () => void;
    let markSteer!: () => void;
    const inspected = new Promise<void>((resolve) => { markInspect = resolve; });
    const steered = new Promise<void>((resolve) => { markSteer = resolve; });
    const runtime = {
      get canAcceptLiveInput() { return active; },
      setConfirmHandler() {},
      cancel() { return false; },
      async close() {},
      submit(input: string) {
        submitted.push(input);
        if (input === "inspect") {
          active = true;
          markInspect();
          return new Promise((resolve) => {
            finishRun = () => resolve({
              finalText: "done",
              usage: null,
              usageSource: "unavailable",
              steps: null,
              changedFiles: [],
              changedFilesSource: "none",
              evidence: [],
              evidenceSource: "none",
            });
          });
        }
        if (input === "focus on tests") {
          active = false;
          finishRun();
          markSteer();
          return Promise.resolve({ type: "message", level: "info", text: "Steering queued" });
        }
        return Promise.resolve({ type: "quit" });
      },
    } as unknown as RecursRuntime;

    const repl = startRepl(runtime, {
      input,
      output,
      terminal: false,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write("inspect\n");
    await inspected;
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write("focus on tests\n");
    await steered;
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write("/quit\n");
    await repl;

    expect(submitted).toEqual(["inspect", "focus on tests", "/quit"]);
    expect(output.value).toContain("Steering queued");
  });
});
