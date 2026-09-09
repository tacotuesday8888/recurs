import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { TERMINAL_THEMES, type TerminalAppearance } from "./terminal-appearance.js";
import type { TerminalTheme } from "./terminal-style.js";

const DESCRIPTIONS = {
  system: "Use your terminal's background and standard colors",
  dark: "Slate background, soft cyan accents, readable muted text",
  light: "White background, deep blue accents, dark text",
  contrast: "Black background, bright text, no dimmed information",
};

export class TerminalThemePicker implements Component {
  #selected: number;
  #error: string | null = null;
  #saving = false;
  constructor(private readonly options: {
    theme: TerminalTheme;
    rows(): number;
    current: TerminalAppearance;
    preview(appearance: TerminalAppearance): void;
    save(appearance: TerminalAppearance): Promise<void>;
    cancel(): void;
    refresh(): void;
  }) {
    this.#selected = Math.max(0, TERMINAL_THEMES.indexOf(options.current.theme));
  }
  invalidate(): void {}
  #appearance(): TerminalAppearance {
    const name = TERMINAL_THEMES[this.#selected]!;
    return name === this.options.current.theme ? this.options.current : { version: 1, theme: name };
  }
  render(width: number): string[] {
    const { theme, current } = this.options;
    const height = Math.max(1, this.options.rows());
    const line = (value: string) => truncateToWidth(value, Math.max(1, width));
    const name = TERMINAL_THEMES[this.#selected]!;
    const header = theme.strong(line("Appearance · preview"));
    const choices = TERMINAL_THEMES.map((item, index) => {
      const text = line(`${index === this.#selected ? "›" : " "} ${item}${item === current.theme ? " · current" : ""}`);
      return index === this.#selected ? theme.accent(theme.strong(text)) : text;
    });
    const footer = line(this.#saving ? "Saving…" : "Esc cancel · Enter save · ↑↓ preview");
    const error = this.#error === null ? [] : [theme.failure(line(this.#error))];
    if (height < 9) {
      const visible = Math.max(1, height - 2 - error.length);
      const start = Math.max(0, this.#selected - visible + 1);
      return [header, ...choices.slice(start, start + visible), ...error, footer].slice(-height);
    }
    const lines = [header, theme.muted(line("Preview now; Enter saves. Esc restores your theme.")), "", ...choices,
      "", theme.muted(line(DESCRIPTIONS[name])),
      line(`${theme.accent("Accent")}  ${theme.code("Code")}  ${theme.success("Success")}  ${theme.warning("Warning")}  ${theme.failure("Error")}`),
      ...(!theme.colorEnabled ? [line("Color disabled by this terminal or NO_COLOR; preference still saves.")] : []),
    ];
    return [...lines.slice(0, height - 1 - error.length), ...error, footer];
  }
  handleInput(data: string): void {
    if (this.#saving) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.options.cancel();
    } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.#selected = (this.#selected + (matchesKey(data, Key.up) ? -1 : 1) + TERMINAL_THEMES.length) % TERMINAL_THEMES.length;
      this.options.preview(this.#appearance());
    } else if (matchesKey(data, Key.enter)) {
      this.#saving = true;
      this.options.refresh();
      void this.options.save(this.#appearance()).catch(() => {
        this.#error = "Save failed: check private config";
      }).finally(() => { this.#saving = false; this.options.refresh(); });
    }
    this.options.refresh();
  }
}
