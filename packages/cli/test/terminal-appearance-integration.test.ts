import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RecursInteractiveShell, type InteractiveTerminal } from "../src/terminal-ui.js";
import { loadTerminalAppearance } from "../src/terminal-appearance.js";
import type { RecursRuntime } from "../src/runtime.js";

class AppearanceTerminal implements InteractiveTerminal {
  readonly columns = 100;
  readonly rows = 25;
  readonly kittyProtocolActive = false;
  input: ((data: string) => void) | null = null;
  output = "";
  start(onInput: (data: string) => void): void { this.input = onInput; }
  stop(): void { this.input = null; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.output += data; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  command(text: string): void { this.input!(text); this.input!("\r"); }
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "recurs-theme-integration-"));
  const terminal = new AppearanceTerminal();
  const close = vi.fn(async () => undefined);
  const submit = vi.fn(async () => { throw new Error("Appearance must not call the model runtime"); });
  const runtime = {
    state: { type: "workspace", permissionMode: "ask_always", cwd: root },
    companyBlueprint: null,
    hasActiveRun: false,
    canAcceptLiveInput: false,
    setConfirmHandler() {},
    setApprovalHandler() {},
    setUserInputHandler() {},
    setSelectionHandler() {},
    cancel() { return false; },
    close, submit, commandNames() { return []; },
  } as unknown as RecursRuntime;
  const shell = new RecursInteractiveShell({ terminal, cwd: root, dataDirectory: root, colorEnabled: false, animate: false });
  const running = shell.start(runtime);
  await vi.waitFor(() => expect(terminal.input).not.toBeNull());
  return { root, terminal, running, close, submit, async cleanup() {
    terminal.input?.("\u0011");
    await running;
    await rm(root, { recursive: true, force: true });
  } };
}

describe("terminal appearance integration", () => {
  it("serializes fast color edits and finishes both saves before quitting", async () => {
    const test = await fixture();
    try {
      test.terminal.command("/theme color accent #abcdef");
      test.terminal.command("/theme color warning #fedcba");
      test.terminal.input!("\u0011");
      await expect(test.running).resolves.toEqual({ type: "quit" });
      expect((await loadTerminalAppearance(test.root))?.colors).toEqual({ accent: "#abcdef", warning: "#fedcba" });
      expect(test.close).toHaveBeenCalledOnce();
      expect(test.submit).not.toHaveBeenCalled();
    } finally { await test.cleanup(); }
  });

  it("recovers from a failed disk save without poisoning later appearance writes", async () => {
    const test = await fixture();
    try {
      const file = path.join(test.root, "config", "appearance.json");
      await mkdir(file, { recursive: true, mode: 0o700 });
      test.terminal.command("/theme dark");
      await vi.waitFor(() => expect(test.terminal.output).toContain("Error:"));
      await rm(file, { recursive: true });
      test.terminal.command("/theme color success #abcdef");
      await vi.waitFor(async () => expect((await loadTerminalAppearance(test.root))?.colors?.success).toBe("#abcdef"));
      expect(test.submit).not.toHaveBeenCalled();
    } finally { await test.cleanup(); }
  });
});
