import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderTerminalOpeningArt } from "./terminal-opening-art.js";
import type { TerminalTheme } from "./terminal-style.js";

import { RECURS_OPENING_WORDMARK_ROWS } from "./generated/recurs-brand.js";

/** Uses the same normal-based ASCII lighting as the original 3D design preview. */
export function renderTerminalOpening(width: number, available: number, theme: TerminalTheme, frame = 0, options: { compactWordmark?: boolean } = {}): string[] {
  if (available < 5) return [];
  const center = (value: string): string => {
    const text = truncateToWidth(value, Math.max(1, width), "", false);
    return " ".repeat(Math.max(0, Math.floor((width - visibleWidth(text)) / 2))) + text;
  };
  const rows: string[] = [];
  const compact = available < 12 || options.compactWordmark === true;
  if (available >= 7 && width >= 40 && theme.colorEnabled) {
    const artHeight = Math.min(20, available - (compact ? 2 : 6));
    const artWidth = Math.min(64, width);
    const cells = renderTerminalOpeningArt(artWidth, artHeight, frame);
    rows.push(...cells.map((row) => {
      let result = "", run = "", role = 0;
      const style = (text: string, value: number): string => value === 2 ? theme.strong(text) : value === 1 ? theme.accent(text) : theme.muted(text);
      for (const { ch, light } of row) {
        const next = light > .77 ? 2 : light > .36 ? 1 : 0;
        if (next !== role) { result += style(run, role); run = ""; role = next; }
        run += ch;
      }
      return center(result + style(run, role));
    }), "");
    if (compact) return [...rows, theme.accent(center("RECURS"))].slice(0, available);
  }
  rows.push(...RECURS_OPENING_WORDMARK_ROWS.map((line) => theme.accent(center(line))), "", theme.muted(center("One task. A team you control.")));
  return rows.slice(0, available);
}
