import { PassThrough, Readable, Writable } from "node:stream";

import { AgentLoopError } from "@recurs/core";
import type { HostInvocation, ModelImageInput } from "@recurs/contracts";
import { describe, expect, it } from "vitest";

import { startRepl, type RecursRuntime } from "../src/index.js";
import { ImageInputError } from "../src/image-input.js";

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
  it("renders the gradient loop mark only for a color-capable terminal", async () => {
    const output = new TextOutput();
    const runtime = {
      state: { type: "session" },
      setConfirmHandler() {},
      cancel() { return false; },
      async close() {},
      async submit() { return { type: "quit" as const }; },
    } as unknown as RecursRuntime;

    await startRepl(runtime, {
      input: Readable.from(["/quit\n"]),
      output,
      terminal: true,
      environment: { TERM: "xterm-256color" },
    });

    expect(output.value).toContain("\u001b[38;5;33m");
    expect(output.value).toContain("◀");
    expect(output.value).toContain("Recurs — local harness mode");
    expect(output.value).toContain("\u001b[96mrecurs> \u001b[0m");
  });

  it("keeps non-terminal output plain and compact", async () => {
    const output = new TextOutput();
    const runtime = {
      state: { type: "session" },
      setConfirmHandler() {},
      cancel() { return false; },
      async close() {},
      async submit() { return { type: "quit" as const }; },
    } as unknown as RecursRuntime;

    await startRepl(runtime, {
      input: Readable.from(["/quit\n"]),
      output,
      terminal: false,
      environment: { TERM: "xterm-256color" },
    });

    expect(output.value).toContain("Recurs — local harness mode");
    expect(output.value).not.toContain("\u001b[");
    expect(output.value).not.toContain("█");
  });

  it("stages path-free images for exactly the next ordinary prompt", async () => {
    const root = "/canonical/project";
    const input = new PassThrough();
    const output = new TextOutput();
    const submissions: Array<{
      readonly input: string;
      readonly images?: readonly ModelImageInput[];
    }> = [];
    const runtime = {
      get hasActiveRun() { return false; },
      setConfirmHandler() {},
      cancel() { return false; },
      async close() {},
      async submit(
        input: string,
        _invocation: HostInvocation,
        options: { readonly images?: readonly ModelImageInput[] } = {},
      ) {
        submissions.push({ input, ...options });
        return input === "/quit"
          ? { type: "quit" as const }
          : input.startsWith("/")
            ? { type: "message" as const, level: "info" as const, text: "command" }
            : {
                finalText: "done",
                usage: null,
                usageSource: "unavailable" as const,
                steps: null,
                changedFiles: [],
                changedFilesSource: "none" as const,
                evidence: [],
                evidenceSource: "none" as const,
              };
      },
    } as unknown as RecursRuntime;

    const repl = startRepl(runtime, {
      input,
      output,
      terminal: false,
      cwd: root,
      async loadImages(paths, cwd) {
        expect(paths).toEqual(["My Screen.bin"]);
        expect(cwd).toBe(root);
        return [{ mediaType: "image/png", data: "iVBORw0KGgo=" }];
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const line of [
      "/image My\\ Screen.bin\n",
      "/help\n",
      "Inspect the screenshot\n",
      "Continue without it\n",
      "/quit\n",
    ]) {
      input.write(line);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await repl;

    expect(submissions).toEqual([
      { input: "/help" },
      {
        input: "Inspect the screenshot",
        images: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }],
      },
      { input: "Continue without it" },
      { input: "/quit" },
    ]);
    expect(output.value).toContain("Images staged for the next prompt: 1/4");
    expect(output.value).toContain("/image [path|clear]");
    expect(JSON.stringify(submissions)).not.toContain(root);
  });

  it("reports safe image errors and does not submit invalid attachments", async () => {
    const input = new PassThrough();
    const output = new TextOutput();
    const submissions: string[] = [];
    const runtime = {
      setConfirmHandler() {},
      cancel() { return false; },
      async close() {},
      async submit(input: string) {
        submissions.push(input);
        return { type: "quit" as const };
      },
    } as unknown as RecursRuntime;

    const repl = startRepl(runtime, {
      input,
      output,
      terminal: false,
      async loadImages() {
        throw new ImageInputError("Image input must be PNG, JPEG, or WebP");
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write("/image notes.bin\n");
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write("/quit\n");
    await repl;

    expect(submissions).toEqual(["/quit"]);
    expect(output.value).toContain("Error: Image input must be PNG, JPEG, or WebP");
    expect(output.value).not.toContain("diagnostic");
  });

  it("reports and clears staged images without consuming a model turn", async () => {
    const input = new PassThrough();
    const output = new TextOutput();
    const submissions: Array<{
      readonly input: string;
      readonly images?: readonly ModelImageInput[];
    }> = [];
    const runtime = {
      setConfirmHandler() {},
      cancel() { return false; },
      async close() {},
      async submit(
        line: string,
        _invocation: HostInvocation,
        options: { readonly images?: readonly ModelImageInput[] } = {},
      ) {
        submissions.push({ input: line, ...options });
        return line === "/quit"
          ? { type: "quit" as const }
          : {
              finalText: "done",
              usage: null,
              usageSource: "unavailable" as const,
              steps: null,
              changedFiles: [],
              changedFilesSource: "none" as const,
              evidence: [],
              evidenceSource: "none" as const,
            };
      },
    } as unknown as RecursRuntime;

    const repl = startRepl(runtime, {
      input,
      output,
      terminal: false,
      async loadImages() {
        return [{ mediaType: "image/png", data: "iVBORw0KGgo=" }];
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const line of [
      "/image screen.png\n",
      "/image\n",
      "/image clear\n",
      "/image\n",
      "Inspect without an attachment\n",
      "/quit\n",
    ]) {
      input.write(line);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await repl;

    expect(submissions).toEqual([
      { input: "Inspect without an attachment" },
      { input: "/quit" },
    ]);
    expect(output.value).toContain("Staged images cleared.");
    expect(output.value).toContain("No images staged.");
  });

  it("does not turn image staging into ambiguous live steering", async () => {
    const input = new PassThrough();
    const output = new TextOutput();
    let loaded = false;
    const submissions: string[] = [];
    const runtime = {
      get hasActiveRun() { return true; },
      setConfirmHandler() {},
      cancel() { return false; },
      async close() {},
      async submit(line: string) {
        submissions.push(line);
        return { type: "quit" as const };
      },
    } as unknown as RecursRuntime;

    const repl = startRepl(runtime, {
      input,
      output,
      terminal: false,
      async loadImages() {
        loaded = true;
        return [{ mediaType: "image/png", data: "iVBORw0KGgo=" }];
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write("/image screen.png\n");
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write("/quit\n");
    await repl;

    expect(loaded).toBe(false);
    expect(submissions).toEqual(["/quit"]);
    expect(output.value).toContain(
      "Error: Images can be staged only while the current agent turn is idle",
    );
  });

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

  it("hands an attach result to the terminal host before reading the next command", async () => {
    const output = new TextOutput();
    const input = new PassThrough();
    const attached: string[] = [];
    const submitted: string[] = [];
    let markAttached!: () => void;
    const attachmentHandled = new Promise<void>((resolve) => {
      markAttached = resolve;
    });
    const runtime = {
      setConfirmHandler() {},
      cancel() { return false; },
      async close() {},
      async submit(input: string) {
        submitted.push(input);
        return input === "/process terminal-1 attach"
          ? { type: "attach_process", sessionId: "terminal-1" }
          : { type: "quit" };
      },
    } as unknown as RecursRuntime;

    const repl = startRepl(runtime, {
      input,
      output,
      terminal: false,
      attachProcess: async (_runtime, sessionId) => {
        attached.push(sessionId);
        markAttached();
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write("/process terminal-1 attach\n");
    await attachmentHandled;
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write("/quit\n");
    await repl;

    expect(submitted).toEqual(["/process terminal-1 attach", "/quit"]);
    expect(attached).toEqual(["terminal-1"]);
  });

  it("preempts live steering so a model question receives the next line", async () => {
    const output = new TextOutput();
    const input = new PassThrough();
    const submitted: string[] = [];
    const answers: Array<string | null> = [];
    let active = false;
    let userInputHandler: Parameters<RecursRuntime["setUserInputHandler"]>[0]
      | undefined;
    let markQuestion!: () => void;
    let markAnswered!: () => void;
    const questionPresented = new Promise<void>((resolve) => {
      markQuestion = resolve;
    });
    const answerHandled = new Promise<void>((resolve) => {
      markAnswered = resolve;
    });
    const runtime = {
      get canAcceptLiveInput() { return active; },
      setConfirmHandler() {},
      setUserInputHandler(handler: NonNullable<typeof userInputHandler>) {
        userInputHandler = handler;
      },
      currentSignal() { return new AbortController().signal; },
      cancel() { return false; },
      async close() {},
      async submit(line: string) {
        submitted.push(line);
        if (line === "inspect") {
          active = true;
          await new Promise<void>((resolve) => setImmediate(resolve));
          const pending = userInputHandler!({
            question: "Which target should I change?",
            options: ["Core", "CLI"],
          }, new AbortController().signal);
          markQuestion();
          answers.push(await pending);
          active = false;
          markAnswered();
          return {
            finalText: "done",
            usage: null,
            usageSource: "unavailable",
            steps: null,
            changedFiles: [],
            changedFilesSource: "none",
            evidence: [],
            evidenceSource: "none",
          };
        }
        return { type: "quit" };
      },
    } as unknown as RecursRuntime;

    const repl = startRepl(runtime, { input, output, terminal: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write("inspect\n");
    await questionPresented;
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write("2\n");
    await answerHandled;
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.write("/quit\n");
    await repl;

    expect(submitted).toEqual(["inspect", "/quit"]);
    expect(answers).toEqual(["CLI"]);
    expect(output.value).toContain("Which target should I change?");
    expect(output.value).toContain("2. CLI");
  });
});
