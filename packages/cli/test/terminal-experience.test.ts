import { describe, expect, it, vi } from "vitest";
import { visibleWidth, TUI, type Terminal } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { TerminalActivity } from "../src/terminal-activity.js";
import { renderTerminalOpening } from "../src/terminal-opening.js";
import { createTerminalTheme } from "../src/terminal-style.js";
import { TerminalThemePicker } from "../src/terminal-theme-picker.js";
import { TerminalUiState } from "../src/terminal-ui-state.js";
import { parseTerminalAppearance } from "../src/terminal-appearance.js";
import { ChatComponent, TranscriptBuffer } from "../src/terminal-ui.js";

const base = { sessionId: "root", at: "2026-09-09T00:00:00Z" };
const theme = createTerminalTheme(process.stdout, { colorEnabled: true, appearance: { version: 1, theme: "orange" } });
const plain = (rows: string[]) => stripVTControlCharacters(rows.join("\n"));
const start = (activity: TerminalActivity, patch: string) => activity.emit({ ...base, type: "tool_started", call: { id: "patch", name: "apply_patch", arguments: { patch } } });

describe("implemented terminal experience", () => {
  it("preserves legacy preferences while presenting one combined interface", () => {
    const current = parseTerminalAppearance({ version: 1, theme: "orange", design: "v19" });
    expect(current.design).toBe("v19");
    expect(() => parseTerminalAppearance({ ...current, design: "unknown" })).toThrow();
    const local = createTerminalTheme(process.stdout, { colorEnabled: true, appearance: current });
    const picker = new TerminalThemePicker({ theme: local, current, rows: () => 30, refresh() {}, preview: (value) => local.setAppearance(value), save: async () => {}, cancel() {} });
    picker.handleInput("\u001b[B");
    expect(local.appearance.design).toBe("v19");
    expect(local.appearance.theme).toBe("system");
    picker.handleInput("d");
    expect(local.appearance.design).toBe("v19");
    expect(plain(picker.render(100))).toContain("Ctrl+G opens the agent floor");
    expect(local.appearance.theme).toBe("system");
  });
  it("tracks tools and permission waits on the exact child execution", async () => {
    const state = new TerminalUiState({ model: "root-model", mode: "balanced", permission: "ask_always" });
    await state.emit({ ...base, type: "agent_started", parentAgentId: "parent", childAgentId: "builder", childSessionId: "child", taskId: "task", description: "Build parser", operatingModeId: "balanced_v6", profileId: "implement_v1", modelId: "child-model", reasoningEffort: null });
    await state.emit({ ...base, sessionId: "child", type: "tool_started", call: { id: "read", name: "read_file", arguments: { path: "parser.ts" } } });
    expect(state.snapshot().agents[0]?.detail).toBe("Running read_file");
    await state.emit({ ...base, sessionId: "unrelated", type: "tool_started", call: { id: "read", name: "other", arguments: {} } });
    expect(state.snapshot().agents[0]?.detail).toBe("Running read_file");
    await state.emit({ ...base, sessionId: "child", type: "permission_requested", intent: { category: "write", resource: "parser.ts" } });
    expect(state.snapshot().agents[0]?.detail).toContain("Waiting for permission");
    await state.emit({ ...base, sessionId: "child", type: "tool_completed", callId: "read", result: { output: "read" } });
    expect(state.snapshot().agents[0]?.detail).toBe("read_file completed");
    expect(state.snapshot().agents[0]?.status).toBe("running");
  });
  it("animates native geometry and keeps every frame within terminal bounds", () => {
    expect(renderTerminalOpening(80, 7, theme, 0)).not.toEqual(renderTerminalOpening(80, 7, theme, 12));
    expect(renderTerminalOpening(100, 20, theme, 0)).not.toEqual(renderTerminalOpening(100, 20, theme, 12));
    for (const width of [1, 24, 48, 80, 120]) for (const height of [1, 5, 16, 30]) for (const frame of [0, 10, 25]) {
      const rows = renderTerminalOpening(width, height, theme, frame);
      expect(rows.length).toBeLessThanOrEqual(height);
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
    }
  });
  it("shows only completed patch changes, with exact observed line counts", () => {
    const activity = new TerminalActivity();
    start(activity, "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1,2 @@\n---old\n+++new\n+extra\n");
    expect(plain(activity.render(80, 9, 0, theme))).toContain("running");
    expect(plain(activity.render(80, 9, 0, theme))).not.toContain("+new");
    activity.emit({ ...base, type: "tool_completed", callId: "patch", result: { output: "Applied" } });
    const rendered = plain(activity.render(80, 9, 0, theme));
    expect(rendered).toContain("+2 −1 observed patch lines");
    expect(rendered).toContain("---old\n+++new\n+extra");
    activity.emit({ ...base, type: "tool_completed", callId: "patch", result: { output: "Applied" } });
    expect(plain(activity.render(80, 9, 0, theme))).toBe(rendered);
    activity.emit({ ...base, type: "turn_started", turnId: "next", prompt: "next" });
    expect(activity.render(80, 9, 0, theme)).toEqual([]);
  });
  it("does not present failed or oversized patch input as applied edits", () => {
    const activity = new TerminalActivity();
    start(activity, "+never applied");
    activity.emit({ ...base, type: "turn_cancelled", turnId: "turn" });
    expect(plain(activity.render(80, 9, 0, theme))).toContain("cancelled");
    expect(plain(activity.render(80, 9, 0, theme))).not.toContain("never applied");
    start(activity, "+".repeat(70000));
    activity.emit({ ...base, type: "tool_completed", callId: "patch", result: { output: "Applied" } });
    expect(plain(activity.render(80, 9, 0, theme))).not.toContain("observed patch lines");
  });
  it("colors diff additions and removals while preserving ordinary code", () => {
    const terminal = { columns: 80, rows: 30, write() {}, hideCursor() {}, showCursor() {} } as unknown as Terminal;
    const buffer = new TranscriptBuffer();
    const chat = new ChatComponent(new TUI(terminal), buffer, { model: "model", mode: "balanced", permission: "ask_always" }, [], "/tmp", true, () => 30, undefined, theme);
    buffer.append("```diff\n@@ -1 +1 @@\n-old\n+new\n```\n\n```ts\n-negative\n```");
    const rendered = chat.render(80).join("\n");
    expect(rendered).toContain(theme.success("+new"));
    expect(rendered).toContain(theme.failure("-old"));
    expect(rendered).toContain(theme.code("-negative"));
  });
  it("keeps input and questions visible with real activity at small sizes", async () => {
    const terminal = { columns: 32, rows: 12, write() {}, hideCursor() {}, showCursor() {} } as unknown as Terminal;
    const activity = new TerminalActivity();
    start(activity, "+new");
    const chat = new ChatComponent(new TUI(terminal), new TranscriptBuffer(), { model: "model", mode: "balanced", permission: "ask_always" }, [], "/tmp", true, () => terminal.rows, undefined, theme, { activity, frame: () => 0 });
    chat.editor.setText("Keep my draft");
    expect(plain(chat.render(32))).toContain("Keep my draft");
    const controller = new AbortController();
    const answer = chat.ask("Approve this change?", ["yes", "no"], controller.signal);
    const rows = chat.render(32);
    expect(rows).toHaveLength(12);
    expect(rows.every((row) => visibleWidth(row) <= 32)).toBe(true);
    expect(plain(rows)).toContain("Approve this change?");
    expect(plain(rows)).not.toContain("ACTIVITY");
    controller.abort(); await answer;
    expect(chat.editor.getText()).toBe("Keep my draft");
  });
  it("previews edited color roles, saves only on confirmation, and supports cancelling", async () => {
    const current = { version: 1 as const, theme: "orange" as const };
    const local = createTerminalTheme(process.stdout, { colorEnabled: true, appearance: current });
    const save = vi.fn(async () => {}), cancel = vi.fn(() => local.setAppearance(current));
    const picker = new TerminalThemePicker({ theme: local, current, rows: () => 30, refresh() {}, preview: (value) => local.setAppearance(value), save, cancel });
    picker.handleInput("c"); picker.handleInput("\t"); picker.handleInput("\t");
    picker.handleInput("abc"); picker.handleInput("\r");
    expect(plain(picker.render(80))).toContain("six hex digits");
    picker.handleInput("def"); picker.handleInput("\r");
    expect(local.appearance.colors?.accent).toBe("#abcdef");
    expect(save).not.toHaveBeenCalled();
    picker.handleInput("\r"); await Promise.resolve();
    expect(save).toHaveBeenCalledWith({ ...current, colors: { accent: "#abcdef" } });
    await Promise.resolve(); await Promise.resolve();
    picker.handleInput("c"); picker.handleInput("\u0003");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
