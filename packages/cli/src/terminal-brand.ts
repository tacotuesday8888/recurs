import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { RECURS_OPENING_WORDMARK_ROWS } from "./generated/recurs-brand.js";
import type { TerminalTheme } from "./terminal-style.js";

/** Native lettering stays aligned and follows the user's colors in every terminal. */
export class RecursBrandComponent implements Component {
  constructor(private readonly theme: TerminalTheme, private readonly centered = true) {}
  invalidate(): void {}
  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const rows = safeWidth < 23 ? ["RECURS"] : RECURS_OPENING_WORDMARK_ROWS;
    const blockWidth = Math.min(safeWidth, Math.max(...rows.map(visibleWidth)));
    const padding = this.centered ? " ".repeat(Math.max(0, Math.floor((safeWidth - blockWidth) / 2))) : "";
    return rows.map((row) => `${padding}${this.theme.accent(truncateToWidth(row, safeWidth, "", false))}`);
  }
  handleInput(): void {}
}
