import { describe, expect, it, vi } from "vitest";
import { TUI, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { AgentExecutionDetail } from "@recurs/core";
import { ChatComponent, TranscriptBuffer } from "../src/terminal-ui.js";
import { ExecutionInspector } from "../src/terminal-execution-inspector.js";

const detail: AgentExecutionDetail = {
  execution: {
    executionId: "child-exact", parentExecutionId: "root", agentId: "worker", roleId: "implement_v1",
    roleName: "Implement", profileId: { id: "implement_v1", version: 1 }, description: "Fix the parser",
    depth: 1, model: "selected-model", effort: "medium",
    permissions: { executionMode: "act", parentExecutionMode: "act", permissionMode: "ask_always", parentPermissionMode: "ask_always" },
    status: "running", recordedStatus: "running", updatedAt: "2026-09-09T00:00:00Z", usage: null,
    changedFiles: ["parser.ts"], evidence: ["fixture passed"], detail: null, teamRunId: null, companyGoalRunId: null,
    capabilities: { cancel: true, send: false, reason: "Read-only. Cancel stops this execution and descendants." },
  },
  messages: [{ id: "1", role: "user", content: "Child-only task" }, { id: "2", role: "assistant", content: "Child-only result" }],
  transcriptNotice: "Durable messages",
};

describe("terminal reading and intervention", () => {
  it("bounds sustained output and keeps the recent tail visible", () => {
    const buffer = new TranscriptBuffer();
    for (let index = 0; index < 1000; index += 1) buffer.append(`chunk ${index}: ${"x".repeat(1024)}\n`);
    expect(buffer.text().length).toBeLessThanOrEqual(TranscriptBuffer.maximumCharacters + 30);
    expect(buffer.text()).toContain("earlier output omitted");
    expect(buffer.text()).not.toContain("chunk 0:");
    expect(buffer.text()).toContain("chunk 999:");
    const terminal = { columns: 32, rows: 10, write() {}, hideCursor() {}, showCursor() {} } as unknown as Terminal;
    const chat = new ChatComponent(new TUI(terminal), buffer, { model: "model", mode: "balanced", permission: "ask_always" }, [], "/tmp", false, () => terminal.rows);
    expect(chat.render(32)).toHaveLength(10);
    expect(chat.render(32).every((line) => visibleWidth(line) <= 32)).toBe(true);
  });
  it("shows the selected execution and cancels that exact execution without a composer", () => {
    const cancel = vi.fn();
    const inspector = new ExecutionInspector({ rows: () => 30, back() {}, reload() {}, refresh() {}, cancel });
    inspector.show(detail);
    const screen = inspector.render(100).join("\n");
    expect(screen).toContain("Child-only task");
    expect(screen).toContain("Child-only result");
    expect(screen).toContain("parser.ts");
    expect(screen).toContain("child-exact");
    expect(screen).not.toContain("Enter send");
    inspector.handleInput("arbitrary text");
    inspector.handleInput("\r");
    expect(cancel).not.toHaveBeenCalled();
    inspector.handleInput("\u0003");
    expect(cancel).toHaveBeenCalledWith("child-exact");
  });

  it("does not offer cancellation for historical or unknown owners", () => {
    const cancel = vi.fn();
    const inspector = new ExecutionInspector({ rows: () => 8, back() {}, reload() {}, refresh() {}, cancel });
    inspector.show({ ...detail, execution: { ...detail.execution, status: "unknown", capabilities: { cancel: false, send: false, reason: "Owner unknown" } } });
    expect(inspector.render(30)).toHaveLength(8);
    expect(inspector.render(30).every((line) => visibleWidth(line) <= 30)).toBe(true);
    inspector.handleInput("\u0003");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("scrolls long conversations, preserves the reading position as output arrives, and resizes", () => {
    const terminal = { columns: 60, rows: 12, write() {}, hideCursor() {}, showCursor() {} } as unknown as Terminal;
    const buffer = new TranscriptBuffer();
    const chat = new ChatComponent(new TUI(terminal), buffer, { model: "model", mode: "balanced", permission: "ask_always" }, [], "/tmp", false, () => terminal.rows);
    buffer.append(Array.from({ length: 60 }, (_, i) => `Line ${i}\n\n`).join(""));
    const text = () => stripVTControlCharacters(chat.render(60).join("\n"));
    expect(text()).toContain("Line 59");
    chat.scroll("\u001b[5~");
    const previous = text();
    expect(previous).not.toContain("Line 59");
    buffer.append("New output\n\n");
    expect(text().split("\n").filter((line) => line.includes("Line "))).toEqual(previous.split("\n").filter((line) => line.includes("Line ")));
    chat.scroll("\u001b[1;5F");
    expect(text()).toContain("New output");
    expect(chat.render(24)).toHaveLength(12);
    expect(chat.render(24).every((line) => visibleWidth(line) <= 24)).toBe(true);
  });
});
