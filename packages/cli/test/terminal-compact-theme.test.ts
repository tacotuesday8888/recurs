import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTerminalTheme } from "../src/terminal-style.js";
import { TerminalThemePicker } from "../src/terminal-theme-picker.js";

describe("appearance in compact terminals", () => {
  it.each([1, 2, 3, 4, 8, 24])("preserves the selected theme and color input at %i rows", (height) => {
    const current = { version: 1 as const, theme: "orange" as const };
    const theme = createTerminalTheme(process.stdout, { appearance: current, colorEnabled: false });
    const picker = new TerminalThemePicker({ theme, current, rows: () => height, preview() {}, async save() {}, cancel() {}, refresh() {} });
    expect(picker.render(40).join("\n")).toContain("› orange");
    picker.handleInput("c");
    picker.handleInput("aabbcc");
    for (const width of [1, 20, 40]) {
      const rows = picker.render(width);
      expect(rows.length).toBeLessThanOrEqual(height);
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
      if (width >= 20) expect(rows.join("\n")).toContain("#aabbcc");
    }
  });
});
