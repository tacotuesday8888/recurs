import { PassThrough, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { MAX_PROCESS_SESSION_INPUT_BYTES } from "@recurs/tools";

import {
  attachOwnedTerminalProcess,
  type RecursRuntime,
} from "../src/index.js";

class RawInput extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  readonly rawModes: boolean[] = [];

  setRawMode(enabled: boolean): void {
    this.isRaw = enabled;
    this.rawModes.push(enabled);
  }
}

class TerminalOutput extends Writable {
  readonly isTTY = true;
  columns = 100;
  rows = 40;
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

describe("owned terminal attachment", () => {
  it("relays exact terminal bytes, resizes, and detaches without stopping", async () => {
    const input = new RawInput();
    const output = new TerminalOutput();
    const interactions: Array<Record<string, unknown>> = [];
    const runtime = {
      async interactWithOwnedProcess(interaction: Record<string, unknown>) {
        interactions.push(interaction);
        if (interaction.input !== undefined) {
          return {
            sessionId: "terminal-1",
            status: "running",
            terminal: true,
            output: "child\u001b[2J",
          };
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        return {
          sessionId: "terminal-1",
          status: "running",
          terminal: true,
          output: "",
        };
      },
    } as unknown as RecursRuntime;

    const attached = attachOwnedTerminalProcess(
      runtime,
      "terminal-1",
      input,
      output,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    output.columns = 132;
    output.rows = 42;
    output.emit("resize");
    input.write(Buffer.from([0x61, 0xff, 0x1b]));
    input.write(Buffer.from([0x1d]));
    await attached;

    expect(input.rawModes).toEqual([true, false]);
    expect(interactions).toContainEqual({
      sessionId: "terminal-1",
      resize: { columns: 100, rows: 40 },
      yieldTimeMs: 0,
    });
    expect(interactions).toContainEqual({
      sessionId: "terminal-1",
      input: Uint8Array.from([0x61, 0xff, 0x1b]),
      yieldTimeMs: 0,
    });
    expect(interactions.some((interaction) =>
      interaction.input instanceof Uint8Array &&
      interaction.input.includes(0x1d)
    )).toBe(false);
    expect(output.value).toContain("Attached to terminal-1");
    expect(output.value).toContain("child\u001b[2J");
    expect(output.value).toContain("Detached from terminal-1; process continues");
  });

  it("restores terminal mode when the child exits or attachment is unavailable", async () => {
    const input = new RawInput();
    input.isRaw = true;
    const output = new TerminalOutput();
    const runtime = {
      async interactWithOwnedProcess() {
        return {
          sessionId: "terminal-1",
          status: "exited",
          terminal: true,
          output: "done\r\n",
          exitCode: 7,
        };
      },
    } as unknown as RecursRuntime;

    await attachOwnedTerminalProcess(runtime, "terminal-1", input, output);
    expect(input.rawModes).toEqual([true, true]);
    expect(output.value).toContain("done\r\nProcess exited with code 7.");

    await expect(attachOwnedTerminalProcess(
      runtime,
      "terminal-1",
      new PassThrough(),
      output,
    )).rejects.toMatchObject({
      code: "invalid_input",
      message: "Process attachment requires an interactive terminal",
    });
  });

  it("bounds queued input and restores terminal state when attachment fails", async () => {
    const input = new RawInput();
    const output = new TerminalOutput();
    let releaseInteraction!: () => void;
    const interactionPending = new Promise<void>((resolve) => {
      releaseInteraction = resolve;
    });
    const runtime = {
      async interactWithOwnedProcess() {
        await interactionPending;
        return {
          sessionId: "terminal-1",
          status: "running",
          terminal: true,
          output: "",
        };
      },
    } as unknown as RecursRuntime;

    const attached = attachOwnedTerminalProcess(
      runtime,
      "terminal-1",
      input,
      output,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write(Buffer.alloc(MAX_PROCESS_SESSION_INPUT_BYTES + 1));
    releaseInteraction();

    await expect(attached).rejects.toMatchObject({
      code: "invalid_input",
      message: "Attached terminal input exceeded the bounded queue",
    });
    expect(input.rawModes).toEqual([true, false]);
    expect(input.listenerCount("data")).toBe(0);
    expect(output.listenerCount("resize")).toBe(0);
  });
});
