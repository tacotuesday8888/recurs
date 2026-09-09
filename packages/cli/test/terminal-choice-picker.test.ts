import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TerminalChoicePicker } from "../src/terminal-choice-picker.js";
import { createTerminalTheme } from "../src/terminal-style.js";

const sink = new Writable({ write(_chunk, _encoding, done) { done(); } });
const theme = createTerminalTheme(sink, { colorEnabled: false });

describe("terminal choice picker", () => {
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
