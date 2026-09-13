import { TUI, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { TerminalComposer } from "../src/terminal-composer.js";
import { createTerminalTheme } from "../src/terminal-style.js";

function composer() {
  const theme = createTerminalTheme(process.stdout, { colorEnabled: true, appearance: { version: 1, theme: "orange" } });
  return new TerminalComposer(new TUI({ rows: 30 } as Terminal), {
    borderColor: theme.accent,
    selectList: { selectedPrefix: theme.accent, selectedText: theme.accent, description: theme.muted, scrollInfo: theme.muted, noMatch: theme.muted },
  }, theme);
}

describe("terminal composer", () => {
  it("frames wrapped Unicode input without changing submitted text", () => {
    const editor = composer();
    const text = "Review 界面 and preserve 🦊 emojis across wrapped lines.";
    editor.setText(text);
    editor.focused = true;
    const submit = vi.fn();
    editor.onSubmit = submit;
    for (const width of [20, 40, 80]) {
      const rows = editor.render(width);
      expect(rows.every((row) => visibleWidth(row) === width)).toBe(true);
      expect(stripVTControlCharacters(rows[0]!)).toMatch(/^╭─+╮$/u);
      expect(stripVTControlCharacters(rows.at(-1)!)).toMatch(/^╰─+╯$/u);
      expect(rows.join("\n")).not.toContain("composer-rule");
      expect(editor.getText()).toBe(text);
    }
    editor.handleInput("\r");
    expect(submit).toHaveBeenCalledWith(text);
  });
  it("does not mistake user-entered rule glyphs for its border", () => {
    const editor = composer();
    editor.setText("────\n↓ 3 more lines");
    const rows = editor.render(40).map(stripVTControlCharacters);
    expect(rows[1]).toMatch(/^│.*────.*│$/u);
    expect(rows[2]).toMatch(/^│.*↓ 3 more lines.*│$/u);
  });
});
