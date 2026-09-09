import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { CommandSelectionOption } from "./commands/types.js";
import { wrapTerminalText, type TerminalTheme } from "./terminal-style.js";

/** An ephemeral choice returns an exact ID; commands still own validation and mutation. */
export class TerminalChoicePicker implements Component {
  #selected = 0;
  constructor(private readonly options: {
    message: string;
    choices: readonly CommandSelectionOption[];
    theme: TerminalTheme;
    rows(): number;
    settle(id: string | null): void;
    refresh(): void;
  }) {
    const current = options.choices.findIndex((choice) => choice.current === true);
    this.#selected = Math.max(0, current);
  }
  invalidate(): void {}
  render(width: number): string[] {
    const height = Math.max(1, this.options.rows());
    const safeWidth = Math.max(1, width);
    const line = (text: string) => truncateToWidth(text, safeWidth);
    const theme = this.options.theme;
    const selected = this.options.choices[this.#selected];
    if (height <= 3) {
      const selectedLine = theme.accent(line(`› ${selected?.label ?? "No choices available"}`));
      if (height === 1) return [selectedLine];
      return [...(height === 3 ? [theme.strong(line(this.options.message))] : []),
        selectedLine, line("Esc cancel · Enter select")];
    }
    const detail = selected?.detail === undefined ? [] : wrapTerminalText(selected.detail, safeWidth).slice(0, height > 10 ? 3 : 1).map(theme.muted);
    const title = wrapTerminalText(this.options.message, safeWidth).slice(0, height > 10 ? 3 : 1).map(theme.strong);
    const count = Math.max(1, height - title.length - detail.length - 3);
    const start = Math.min(Math.max(0, this.#selected - count + 1), Math.max(0, this.options.choices.length - count));
    const choices = this.options.choices.slice(start, start + count).map((choice, offset) => {
      const text = line(`${start + offset === this.#selected ? "›" : " "} ${choice.label}`);
      return start + offset === this.#selected ? theme.accent(text) : text;
    });
    const footer = line(`Esc cancel · Enter select · ↑↓ ${this.#selected + 1}/${this.options.choices.length}`);
    return [...title, ...choices, "", ...detail, footer].slice(-height);
  }
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.options.settle(null);
    else if (matchesKey(data, Key.enter)) this.options.settle(this.options.choices[this.#selected]?.id ?? null);
    else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.#selected = (this.#selected + (matchesKey(data, Key.up) ? -1 : 1) + this.options.choices.length) % this.options.choices.length;
    } else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      this.#selected = Math.min(this.options.choices.length - 1, Math.max(0, this.#selected + (matchesKey(data, Key.pageUp) ? -1 : 1) * Math.max(1, this.options.rows() - 8)));
    }
    this.options.refresh();
  }
}
