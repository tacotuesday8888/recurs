import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { TERMINAL_THEMES, TERMINAL_COLOR_ROLES, type TerminalAppearance } from "./terminal-appearance.js";
import type { TerminalTheme } from "./terminal-style.js";

const DESCRIPTIONS = {
  orange: "Recurs: charcoal canvas, warm orange accents, soft readable text",
  system: "Use your terminal's background and standard colors",
  dark: "Slate background, soft cyan accents, readable muted text",
  light: "White background, deep blue accents, dark text",
  contrast: "Black background, bright text, no dimmed information",
};

export class TerminalThemePicker implements Component {
  #selected: number;
  #error: string | null = null;
  #saving = false;
  #editingRole: number | null = null;
  #hex = "";
  #draft: TerminalAppearance | null = null;
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
    if (this.#draft !== null) return this.#draft;
    const name = TERMINAL_THEMES[this.#selected]!;
    return name === this.options.current.theme ? this.options.current : { version: 1, theme: name, ...(this.options.theme.appearance.design === undefined ? {} : { design: this.options.theme.appearance.design }) };
  }
  render(width: number): string[] {
    const { theme, current } = this.options;
    const height = Math.max(1, this.options.rows());
    const line = (value: string) => truncateToWidth(value, Math.max(1, width));
    const name = TERMINAL_THEMES[this.#selected]!;
    const header = theme.strong(line("Appearance · preview"));
    if (this.#editingRole !== null) {
      const role = TERMINAL_COLOR_ROLES[this.#editingRole]!;
      return [header, "", theme.accent(line(`Color · ${role}`)), line(`#${this.#hex}`),
        line("Enter 6 hex digits, then Enter to preview."), line("Tab next role · Backspace edit · Esc back"),
        line("Save the theme afterward with Enter."), ...(this.#error === null ? [] : [theme.failure(line(this.#error))])].slice(-height);
    }
    const choices = TERMINAL_THEMES.map((item, index) => {
      const text = line(`${index === this.#selected ? "›" : " "} ${item}${item === current.theme ? " · current" : ""}`);
      return index === this.#selected ? theme.accent(theme.strong(text)) : text;
    });
    const footer = line(this.#saving ? "Saving…" : width < 64 ? "C colors · D design · Esc back" : "C colors · D design · Esc cancel · Enter save · ↑↓ preview");
    const error = this.#error === null ? [] : [theme.failure(line(this.#error))];
    if (height < 9) {
      const visible = Math.max(1, height - 2 - error.length);
      const start = Math.max(0, this.#selected - visible + 1);
      return [header, ...choices.slice(start, start + visible), ...error, footer].slice(-height);
    }
    const lines = [header, theme.muted(line("Preview now; Enter saves. Esc restores your theme.")), "", ...choices,
      "", theme.accent(line(`Design: ${this.#appearance().design === "v19" ? "V19 · agent floor" : "3D R · sculpted opening"} · D switches`)), theme.muted(line(DESCRIPTIONS[name])),
      line(`${theme.accent("Accent")}  ${theme.code("Code")}  ${theme.success("Success")}  ${theme.warning("Warning")}  ${theme.failure("Error")}`),
      ...(!theme.colorEnabled ? [line("Color disabled by this terminal or NO_COLOR; preference still saves.")] : []),
    ];
    return [...lines.slice(0, height - 1 - error.length), ...error, footer];
  }
  handleInput(data: string): void {
    if (this.#saving) return;
    if (matchesKey(data, Key.ctrl("c"))) { this.options.cancel(); return; }
    if (this.#editingRole !== null) {
      if (matchesKey(data, Key.escape)) { this.#editingRole = null; this.#error = null; }
      else if (matchesKey(data, Key.tab)) { this.#editingRole = (this.#editingRole + 1) % TERMINAL_COLOR_ROLES.length; this.#hex = ""; }
      else if (matchesKey(data, Key.backspace)) this.#hex = this.#hex.slice(0, -1);
      else if (matchesKey(data, Key.enter)) {
        if (/^[0-9a-f]{6}$/iu.test(this.#hex)) {
          const current = this.#appearance();
          this.#draft = { ...current, colors: { ...current.colors, [TERMINAL_COLOR_ROLES[this.#editingRole]!]: `#${this.#hex.toLowerCase()}` } };
          this.options.preview(this.#draft); this.#editingRole = null; this.#error = null;
        } else this.#error = "Use exactly six hex digits.";
      } else if (/^[0-9a-f]+$/iu.test(data) && this.#hex.length + data.length <= 6) this.#hex += data;
      this.options.refresh(); return;
    }
    if (data.toLowerCase() === "d") {
      const current = this.#appearance();
      this.#draft = { ...current, design: current.design === "v19" ? "r" : "v19" };
      this.options.preview(this.#draft); this.options.refresh(); return;
    }
    if (data.toLowerCase() === "c") { this.#editingRole = 0; this.#hex = ""; this.options.refresh(); return; }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.options.cancel();
    } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const design = this.#appearance().design;
      this.#draft = null;
      this.#selected = (this.#selected + (matchesKey(data, Key.up) ? -1 : 1) + TERMINAL_THEMES.length) % TERMINAL_THEMES.length;
      if (design !== undefined) this.#draft = { ...this.#appearance(), design };
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
