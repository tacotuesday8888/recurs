import { Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { TerminalTheme } from "./terminal-style.js";

/** Keep the editor's cursor, wrapping and completion behavior inside a visible frame. */
export class TerminalComposer extends Editor {
  constructor(tui: TUI, editorTheme: EditorTheme, private readonly surface?: TerminalTheme) {
    super(tui, editorTheme, { paddingX: 1 });
  }

  override render(width: number): string[] {
    if (width < 4) return super.render(width);
    const border = this.borderColor;
    // Mark only editor-generated rules; source text can itself contain box glyphs.
    const marker = "\u0000composer-rule\u0000";
    let rows: string[];
    this.borderColor = (text) => marker + text;
    try { rows = super.render(width - 2); }
    finally { this.borderColor = border; }
    let closed = false;
    return rows.map((row, index) => {
      if (row.startsWith(marker)) {
        const rule = row.replaceAll(marker, "");
        if (index === 0) return border(`╭${rule}╮`);
        closed = true;
        return border(`╰${rule}╯`);
      }
      if (closed) return ` ${row} `;
      return `${border("│")}${this.surface?.input(row) ?? row}${border("│")}`;
    });
  }
}
