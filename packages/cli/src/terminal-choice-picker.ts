import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { CommandSelectionOption } from "./commands/types.js";
import { wrapTerminalText, type TerminalTheme } from "./terminal-style.js";

/** An ephemeral choice returns an exact ID; commands still own validation and mutation. */
export class TerminalChoicePicker implements Component {
  #selected = 0;
  #query: string | null = null;
  get choices(): readonly CommandSelectionOption[] {
    const query = this.#query?.toLocaleLowerCase().trim();
    return !query ? this.options.choices : this.options.choices.filter((choice) => `${choice.label} ${choice.detail ?? ""}`.toLocaleLowerCase().includes(query));
  }
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
    const choicesInView = this.choices;
    const selected = choicesInView[this.#selected];
    const message = this.#query === null ? this.options.message : `${this.options.message} · /${this.#query}`;
    if (selected === undefined) {
      return [theme.strong(line(message)), line(this.#query === null ? "No choices available" : "No matches · type to search"), line(this.#query === null ? "Esc back" : "Esc clear search")].slice(-height);
    }
    if (height <= 3) {
      const selectedLine = theme.accent(line(`› ${selected?.label ?? "No choices available"}`));
      if (height === 1) return [selectedLine];
      return [...(height === 3 ? [theme.strong(line(message))] : []),
        selectedLine, line("Esc cancel · Enter select")];
    }
    const detail = selected?.detail === undefined ? [] : wrapTerminalText(selected.detail, safeWidth).slice(0, height > 10 ? 3 : 1).map(theme.muted);
    const title = wrapTerminalText(message, safeWidth).slice(0, height > 10 ? 3 : 1).map(theme.strong);
    const count = Math.max(1, height - title.length - detail.length - 3);
    const start = Math.min(Math.max(0, this.#selected - count + 1), Math.max(0, choicesInView.length - count));
    const choices = choicesInView.slice(start, start + count).map((choice, offset) => {
      const text = line(`${start + offset === this.#selected ? "›" : " "} ${choice.label}`);
      return start + offset === this.#selected ? theme.accent(text) : text;
    });
    const footer = line(`Esc ${this.#query === null ? "cancel" : "clear"} · Enter select · / search · ↑↓ ${this.#selected + 1}/${choicesInView.length}`);
    return [...title, ...choices, "", ...detail, footer].slice(-height);
  }
  handleInput(data: string): void {
    const choices = this.choices;
    if (matchesKey(data, Key.escape) && this.#query !== null) {
      this.#query = null;
      this.#selected = Math.max(0, this.options.choices.findIndex((choice) => choice.current === true));
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.options.settle(null);
    else if (matchesKey(data, Key.enter)) {
      const selected = choices[this.#selected];
      if (selected) this.options.settle(selected.id);
      else if (this.#query === null) this.options.settle(null);
    } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      if (choices.length > 0) this.#selected = (this.#selected + (matchesKey(data, Key.up) ? -1 : 1) + choices.length) % choices.length;
    } else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      this.#selected = Math.max(0, Math.min(choices.length - 1, this.#selected + (matchesKey(data, Key.pageUp) ? -1 : 1) * Math.max(1, this.options.rows() - 8)));
    } else if (this.#query === null && data === "/") { this.#query = ""; this.#selected = 0; }
    else if (this.#query !== null && matchesKey(data, Key.backspace)) { this.#query = [...this.#query].slice(0, -1).join(""); this.#selected = 0; }
    else if (this.#query !== null && /^[^\p{Cc}\p{Cf}]+$/u.test(data)) { this.#query = (this.#query + data).slice(0, 120); this.#selected = 0; }
    this.options.refresh();
  }
}
