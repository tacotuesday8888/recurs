import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TerminalChoicePicker } from "../src/terminal-choice-picker.js";
import { createTerminalTheme } from "../src/terminal-style.js";

const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
const theme = createTerminalTheme(sink, { colorEnabled: false });

describe("terminal choice picker", () => {
  it("keeps an empty catalog stable through keyboard navigation", () => {
    const settle = vi.fn();
    const picker = new TerminalChoicePicker({ message: "Model", choices: [], theme, rows: () => 6, refresh() {}, settle });
    for (const key of ["\u001b[A", "\u001b[B", "\u001b[5~", "\u001b[6~"]) {
      picker.handleInput(key);
      expect(picker.render(40).join("\n")).toContain("No choices available");
      expect(picker.render(40).join("\n")).not.toMatch(/NaN|1\/0/u);
    }
    picker.handleInput("\r");
    expect(settle).toHaveBeenCalledWith(null);
  });
  it("selects the explicit current connection despite active words in another model or account name", () => {
    const settle = vi.fn();
    const picker = new TerminalChoicePicker({
      message: "Choose a model", theme, rows: () => 12, refresh() {}, settle,
      choices: [
        { id: "connection-other", label: "provider/active-model", detail: "Active project account" },
        { id: "connection-current", label: "provider/model", detail: "Work account", current: true },
      ],
    });
    expect(picker.render(50).join("\n")).toContain("› provider/model");
    picker.handleInput("\r");
    expect(settle).toHaveBeenCalledWith("connection-current");
  });

  it.each([1, 2, 3, 4, 5, 12])("keeps the selected exact model visible at %i rows", (rows) => {
    const settle = vi.fn();
    const picker = new TerminalChoicePicker({
      message: "Choose a model", theme, rows: () => rows, refresh() {}, settle,
      choices: [{ id: "opaque-connection-id", label: "模型 example", detail: "A detailed description that may wrap over several lines." }],
    });
    const lines = picker.render(22);
    expect(lines.length).toBeLessThanOrEqual(rows);
    expect(lines.join("\n")).toContain("› 模型 example");
    expect(lines.every((line) => visibleWidth(line) <= 22)).toBe(true);
    picker.handleInput("\r");
    expect(settle).toHaveBeenCalledWith("opaque-connection-id");
  });

  it("navigates a long catalog and returns exact connection IDs rather than duplicate display labels", () => {
    const settle = vi.fn();
    const choices = Array.from({ length: 40 }, (_, index) => ({ id: `connection-${index}`, label: "provider/same-model", detail: `Account ${index}` }));
    const picker = new TerminalChoicePicker({ message: "Model", choices, theme, rows: () => 12, refresh() {}, settle });
    picker.handleInput("\u001b[A");
    expect(picker.render(40).join("\n")).toContain("Account 39");
    picker.handleInput("\u001b[5~");
    expect(picker.render(40).join("\n")).toContain("Account 35");
    picker.handleInput("\r");
    expect(settle).toHaveBeenCalledWith("connection-35");
  });

  it.each(["\u001b", "\u0003"])("cancels without selecting a model (%j)", (key) => {
    const settle = vi.fn();
    const picker = new TerminalChoicePicker({ message: "Model", choices: [{ id: "saved-model", label: "Model" }], theme, rows: () => 5, refresh() {}, settle });
    picker.handleInput(key);
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(null);
  });
});

describe("choice picker stress", () => {
  it("keeps the current choice visible across catalog and viewport sizes", () => {
    for (const size of [1, 2, 50, 1000]) for (const height of [1, 2, 3, 4, 8, 24]) {
      const choices = Array.from({ length: size }, (_, i) => ({ id: `id-${i}`, label: `模型-${i}`, detail: "Long account description ".repeat(20), current: i === size - 1 }));
      const settle = vi.fn();
      const picker = new TerminalChoicePicker({ message: "Select a saved model ".repeat(10), choices, theme, rows: () => height, refresh() {}, settle });
      for (const width of [1, 8, 20, 80]) {
        const rows = picker.render(width);
        expect(rows.length).toBeLessThanOrEqual(height);
        expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
        if (width >= 20) expect(rows.join("\n")).toContain(`模型-${size - 1}`);
      }
      picker.handleInput("\r");
      expect(settle).toHaveBeenCalledWith(`id-${size - 1}`);
    }
  });
});

it("filters long lists by label and detail without losing exact choice identity", () => {
  const settle = vi.fn();
  const picker = new TerminalChoicePicker({ message: "Chats", choices: [{ id: "one", label: "Parser", detail: "typescript" }, { id: "two", label: "Review", detail: "database" }], theme, rows: () => 12, settle, refresh() {} });
  picker.handleInput("/"); picker.handleInput("database");
  expect(picker.render(80).join("\n")).toContain("Review");
  expect(picker.render(80).join("\n")).not.toContain("Parser");
  picker.handleInput("\r");
  expect(settle).toHaveBeenCalledWith("two");
});

it("keeps unmatched searches open and restores the full list on Escape", () => {
  const settle = vi.fn();
  const picker = new TerminalChoicePicker({ message: "Chats", choices: [{ id: "one", label: "Parser" }], theme, rows: () => 5, settle, refresh() {} });
  picker.handleInput("/"); picker.handleInput("missing"); picker.handleInput("\r");
  expect(settle).not.toHaveBeenCalled();
  expect(picker.render(30).join("\n")).toContain("No matches");
  picker.handleInput("\u001b");
  expect(picker.render(30).join("\n")).toContain("Parser");
  picker.handleInput("\u001b");
  expect(settle).toHaveBeenCalledWith(null);
});
