import { TUI, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import type { AgentExecutionDetail, RecursEvent } from "@recurs/core";
import { describe, expect, it, vi } from "vitest";
import { ExecutionInspector } from "../src/terminal-execution-inspector.js";
import { ChatComponent, RecursInteractiveShell, TaskPanelComponent, TranscriptBuffer } from "../src/terminal-ui.js";
import { TerminalUiState } from "../src/terminal-ui-state.js";
import type { RecursRuntime } from "../src/runtime.js";

class TestTerminal implements Terminal {
  readonly kittyProtocolActive = false;
  output = "";
  input: ((data: string) => void) | null = null;
  constructor(readonly columns = 80, readonly rows = 16) {}
  start(input: (data: string) => void) { this.input = input; }
  stop() { this.input = null; }
  async drainInput() {}
  write(value: string) { this.output += value; }
  hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {}
  moveBy() {} setTitle() {}
}
function started(id: string, parent = "root"): Extract<RecursEvent, { type: "agent_started" }> {
  return { type: "agent_started", sessionId: parent, at: "2026-09-09T00:00:00Z", parentAgentId: `${parent}-agent`, childAgentId: `${id}-agent`, childSessionId: id, taskId: id, description: id, operatingModeId: "balanced_v6", profileId: "explore_v1", modelId: "worker" };
}
function detail(id: string): AgentExecutionDetail {
  return {
    execution: { executionId: id, roleName: id, status: "completed", model: "worker", effort: null, description: `TASK ${id}`, parentExecutionId: "root", permissions: {}, changedFiles: [], evidence: [], detail: null, capabilities: { cancel: false, send: false, reason: "Read-only" } },
    messages: [{ id: id, role: "assistant", content: Array.from({ length: 30 }, (_, index) => `${id} line ${index}`).join("\n") }], transcriptNotice: null,
  } as unknown as AgentExecutionDetail;
}

describe("terminal execution workflow regressions", () => {
  it("uses depth-first ancestry and keeps selection stable as siblings arrive", async () => {
    const state = new TerminalUiState({ model: "root", mode: "act", permission: "ask" });
    await state.emit(started("a")); await state.emit(started("b")); await state.emit(started("a-child", "a"));
    const open = vi.fn();
    const panel = new TaskPanelComponent(state, { openChat: open, back() {}, refresh() {}, rows: () => 18 });
    panel.render(80);
    panel.handleInput("\x1b[B"); panel.handleInput("\r");
    expect(open.mock.calls[0]?.[0].executionId).toBe("a-child");
    await state.emit(started("0-earlier"));
    panel.render(80); panel.handleInput("\r");
    expect(open.mock.calls[1]?.[0].executionId).toBe("a-child");
    panel.handleInput("\x1b[B"); panel.handleInput("\r");
    expect(open.mock.calls[2]?.[0].executionId).toBe("b");
  });
  it("fits the execution picker and preserves its escape hint at tiny dimensions", async () => {
    const state = new TerminalUiState({ model: "root", mode: "act", permission: "ask" });
    await state.emit(started("child"));
    for (const height of [1, 2, 4, 7, 9, 12, 25]) {
      const panel = new TaskPanelComponent(state, { openChat() {}, back() {}, refresh() {}, rows: () => height });
      const lines = panel.render(60);
      expect(lines).toHaveLength(height);
      expect(lines.at(-1)).toContain("ESC BACK");
      expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
    }
  });
  it("resets scrolling for a different execution and preserves same-execution refresh", () => {
    const inspector = new ExecutionInspector({ rows: () => 10, back() {}, refresh() {}, reload() {}, cancel() {} });
    inspector.show(detail("A")); inspector.handleInput("\x1b[F");
    expect(inspector.render(60).join("\n")).toContain("A line 29");
    inspector.show(detail("A"));
    expect(inspector.render(60).join("\n")).toContain("A line 29");
    inspector.show(null); inspector.show(detail("B"));
    expect(inspector.render(60).join("\n")).toContain("Task: TASK B");
    expect(inspector.render(60).join("\n")).not.toContain("B line 29");
  });
  it("scrolls an oversized approval independently and restores the draft", async () => {
    const terminal = new TestTerminal();
    const chat = new ChatComponent(new TUI(terminal), new TranscriptBuffer(), { model: "model", mode: "act", permission: "ask" }, [], "/workspace", false, () => terminal.rows);
    chat.editor.setText("unfinished work");
    const answer = chat.ask(Array.from({ length: 40 }, (_, index) => `approval-${index}`).join("\n"), ["yes", "no"]);
    expect(chat.render(80).join("\n")).toContain("approval-0");
    for (let index = 0; index < 10; index += 1) { chat.scroll("\x1b[6~"); chat.render(80); }
    const last = chat.render(80);
    expect(last).toHaveLength(16);
    expect(last.join("\n")).toContain("approval-39");
    expect(last.join("\n")).toContain("2. no");
    chat.editor.handleInput("no"); chat.editor.handleInput("\r");
    await expect(answer).resolves.toBe("no");
    expect(chat.editor.getText()).toBe("unfinished work");
  });
  it("updates the visible model, permission and running state", () => {
    const terminal = new TestTerminal();
    let status = { model: "first", mode: "act", permission: "ask", running: false };
    const chat = new ChatComponent(new TUI(terminal), new TranscriptBuffer(), status, [], "/workspace", false, () => terminal.rows, () => status);
    expect(chat.render(80).join("\n")).toContain("Parent · ready");
    status = { model: "second", mode: "plan", permission: "full_access", running: true };
    const rendered = chat.render(80).join("\n");
    expect(rendered).toContain("Parent · running");
    expect(rendered).toContain("second · Plan · Full Access");
  });
  it("shows incomplete-history warnings without suppressing the restored root conversation", async () => {
    const terminal = new TestTerminal(100, 20);
    const runtime = {
      state: { type: "session", session: { id: "root", model: "model", permissionMode: "ask_always" } },
      companyBlueprint: null,
      async listExecutions() { return [{ ...detail("root").execution, parentExecutionId: null, detail: "1 session log(s) could not be read." }]; },
      async inspectExecution() { return { ...detail("root"), messages: [{ role: "user", content: "Restored actual root prompt" }] }; },
      setConfirmHandler() {}, setApprovalHandler() {}, setUserInputHandler() {},
      cancel() { return false; }, async close() {}, commandNames() { return []; },
    } as unknown as RecursRuntime;
    const shell = new RecursInteractiveShell({ terminal, cwd: "/workspace", animate: false, colorEnabled: false });
    const running = shell.start(runtime, { launch: false });
    await vi.waitFor(() => expect(terminal.input).not.toBeNull());
    terminal.input?.("\x11");
    await running;
    expect(terminal.output).toContain("Restored actual root prompt");
    expect(terminal.output).toContain("1 session log(s) could not be read.");
  });
  it("does not carry one saved conversation into another when the shell is reused", async () => {
    const terminal = new TestTerminal(100, 20);
    const shell = new RecursInteractiveShell({ terminal, cwd: "/workspace", colorEnabled: false });
    const runtime = (id: string) => ({
      state: { type: "session", session: { id, model: "model", permissionMode: "ask_always" } },
      companyBlueprint: null,
      async listExecutions() { return []; },
      async inspectExecution() { return { ...detail(id), messages: [{ role: "assistant", content: `Private conversation ${id}` }] }; },
      setConfirmHandler() {}, setApprovalHandler() {}, setUserInputHandler() {},
      cancel() { return false; }, async close() {}, commandNames() { return []; },
    }) as unknown as RecursRuntime;
    const first = shell.start(runtime("first"), { launch: false });
    await vi.waitFor(() => expect(terminal.output).toContain("Private conversation first"));
    terminal.input?.("\x11"); await first;
    terminal.output = "";
    const second = shell.start(runtime("second"), { launch: false });
    await vi.waitFor(() => expect(terminal.output).toContain("Private conversation second"));
    expect(terminal.output).not.toContain("Private conversation first");
    terminal.input?.("\x11"); await second;
  });

});
