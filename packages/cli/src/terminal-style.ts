import type { Writable } from "node:stream";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  isTerminalThemeName,
  type TerminalAppearance,
  type TerminalColorRole,
  type TerminalThemeName,
} from "./terminal-appearance.js";

import {
  RECURS_MARK_ANSI_256,
  RECURS_TERMINAL_ROWS,
  RECURS_TERMINAL_WORDMARK_ROWS,
} from "./generated/recurs-brand.js";

type TerminalEnvironment = Readonly<Record<string, string | undefined>>;

export interface TerminalThemeOptions {
  readonly appearance?: TerminalAppearance;
  readonly colorEnabled?: boolean;
  readonly environment?: TerminalEnvironment;
  readonly terminal?: boolean;
}

export interface TerminalTheme {
  readonly colorEnabled: boolean;
  readonly appearance: TerminalAppearance;
  setAppearance(appearance: TerminalAppearance): void;
  frame(text: string): string;
  code(text: string): string;
  accent(text: string): string;
  brand(text: string, index: number): string;
  companyLayer(depth: 0 | 1 | 2 | 3, text: string): string;
  failure(text: string): string;
  muted(text: string): string;
  rainbow(text: string, offset?: number): string;
  strong(text: string): string;
  success(text: string): string;
  warning(text: string): string;
}

const RESET = "\u001b[0m";
const MAX_RAINBOW_ANSI_256 = Object.freeze([196, 208, 226, 46, 51, 39, 129]);
const COMPANY_LAYER_ANSI_256 = Object.freeze([220, 75, 80, 113]);
const PALETTES: Readonly<Record<Exclude<TerminalThemeName, "system">, Record<TerminalColorRole, string>>> = {
  dark: { background: "#111827", foreground: "#e5e7eb", accent: "#67e8f9", muted: "#9ca3af", success: "#86efac", warning: "#fde68a", failure: "#fda4af", code: "#c4b5fd" },
  light: { background: "#ffffff", foreground: "#172033", accent: "#075985", muted: "#475569", success: "#166534", warning: "#854d0e", failure: "#9f1239", code: "#6b21a8" },
  contrast: { background: "#000000", foreground: "#ffffff", accent: "#00ffff", muted: "#ffffff", success: "#00ff00", warning: "#ffff00", failure: "#ff8080", code: "#ffffff" },
};

function rgbSequence(hex: string, background = false): string {
  const rgb = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  return `\u001b[${background ? 48 : 38};2;${rgb.join(";")}m`;
}

function ansi(enabled: boolean, code: number, text: string): string {
  return enabled ? `\u001b[${code}m${text}${RESET}` : text;
}

function ansi256(enabled: boolean, code: number, text: string): string {
  return enabled ? `\u001b[38;5;${code}m${text}${RESET}` : text;
}

function terminalSupportsColor(
  output: Writable,
  options: TerminalThemeOptions,
): boolean {
  if (options.colorEnabled !== undefined) return options.colorEnabled;
  const environment = options.environment ?? process.env;
  const terminal = options.terminal ??
    (output as Writable & { readonly isTTY?: boolean }).isTTY === true;
  return terminal &&
    !Object.hasOwn(environment, "NO_COLOR") &&
    environment.CLICOLOR !== "0" &&
    environment.TERM?.toLowerCase() !== "dumb";
}

export function createTerminalTheme(
  output: Writable,
  options: TerminalThemeOptions = {},
): TerminalTheme {
  const colorEnabled = terminalSupportsColor(output, options);
  const name = (options.environment ?? process.env).RECURS_THEME ?? "system";
  let appearance: TerminalAppearance = options.appearance ?? { version: 1, theme: isTerminalThemeName(name) ? name : "system" };
  const color = (role: TerminalColorRole): string | undefined => appearance.colors?.[role] ??
    (appearance.theme === "system" ? undefined : PALETTES[appearance.theme][role]);
  const style = (role: TerminalColorRole, fallback: number, text: string): string => {
    const hex = color(role);
    return hex === undefined ? ansi(colorEnabled, fallback, text) : colorEnabled ? `${rgbSequence(hex)}${text}${RESET}` : text;
  };
  return Object.freeze({
    colorEnabled,
    get appearance() { return appearance; },
    setAppearance: (value: TerminalAppearance) => { appearance = value; },
    frame: (text: string) => {
      if (!colorEnabled) return text;
      const background = color("background");
      const foreground = color("foreground");
      const base = `${background === undefined ? "" : rgbSequence(background, true)}${foreground === undefined ? "" : rgbSequence(foreground)}`;
      return `${base}${text.replaceAll(RESET, `${RESET}${base}`)}${RESET}`;
    },
    code: (text: string) => style("code", 96, text),
    accent: (text: string) => style("accent", 96, text),
    brand: (text: string, index: number) =>
      appearance.theme !== "system" ? style("accent", 96, text) : ansi256(
        colorEnabled,
        RECURS_MARK_ANSI_256[index % RECURS_MARK_ANSI_256.length] ?? 51,
        text,
      ),
    companyLayer: (depth: 0 | 1 | 2 | 3, text: string) => appearance.theme === "system"
      ? ansi256(colorEnabled, COMPANY_LAYER_ANSI_256[depth] ?? 80, text)
      : style(depth === 0 ? "accent" : depth === 1 ? "code" : depth === 2 ? "success" : "warning", 96, text),
    failure: (text: string) => style("failure", 31, text),
    muted: (text: string) => style("muted", 2, text),
    rainbow: (text: string, offset = 0) =>
      appearance.theme !== "system" ? style("accent", 96, text) : Array.from(text, (glyph, index) =>
        glyph === " "
          ? glyph
          : ansi256(
            colorEnabled,
            MAX_RAINBOW_ANSI_256[
              (index + offset) % MAX_RAINBOW_ANSI_256.length
            ] ?? 51,
            glyph,
          )
      ).join(""),
    strong: (text: string) => ansi(colorEnabled, 1, text),
    success: (text: string) => style("success", 32, text),
    warning: (text: string) => style("warning", 33, text),
  });
}

export function renderTerminalCanvas(
  lines: readonly string[],
  requestedWidth: number,
  requestedHeight: number,
  theme: Pick<TerminalTheme, "colorEnabled"> & Partial<Pick<TerminalTheme, "frame">>,
): readonly string[] {
  if (!theme.colorEnabled) return Object.freeze([...lines]);
  const width = Math.max(1, Math.floor(requestedWidth));
  const height = Math.max(1, Math.floor(requestedHeight));
  const visible = [...lines];
  while (visible.length < height) visible.push("");
  return Object.freeze(visible.map((line) => {
    const padding = " ".repeat(Math.max(0, width - visibleWidth(line)));
    return theme.frame?.(`${line}${padding}`) ?? `${line}${padding}${RESET}`;
  }));
}

function isMaxMode(modeId: string | undefined): boolean {
  return modeId?.startsWith("max_") === true;
}

function centeredPadding(text: string, columns: number | undefined): string {
  if (columns === undefined) return "";
  const width = Array.from(text).length;
  return " ".repeat(Math.max(0, Math.floor((columns - width) / 2)));
}

export function centerTerminalText(text: string, columns: number): string {
  return `${centeredPadding(text, columns)}${text}`;
}

export function formatTerminalLabel(value: string): string {
  return value.replace(/_v\d+$/u, "").split("_").map((word, index) => {
    if (index > 0 && ["for", "of", "the"].includes(word)) return word;
    return `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
  }).join(" ");
}

export function renderRecursWordmark(
  theme: TerminalTheme,
  options: {
    readonly columns?: number;
    readonly modeId?: string;
  } = {},
): string {
  if (!theme.colorEnabled) return "";
  const rows = renderRecursBrandRows(options.columns);
  const blockWidth = Math.max(...rows.map((row) =>
    Array.from(row.trimEnd()).length
  ));
  const padding = centeredPadding(" ".repeat(blockWidth), options.columns);
  return rows.map((row, rowIndex) => {
    return padding + Array.from(row.trimEnd(), (glyph, glyphIndex) =>
      glyph === " "
        ? glyph
        : isMaxMode(options.modeId)
          ? theme.rainbow(glyph, glyphIndex + rowIndex * 2)
          : theme.brand(
            glyph,
            Math.min(
              Math.floor(
                ((glyphIndex + rowIndex * 0.35) /
                  Math.max(1, row.length - 1)) *
                  RECURS_MARK_ANSI_256.length,
              ),
              RECURS_MARK_ANSI_256.length - 1,
            ),
          )
    ).join("");
  }).join("\n");
}

export function renderRecursBrandRows(columns?: number): readonly string[] {
  const wordmarkWidth = Math.max(
    ...RECURS_TERMINAL_WORDMARK_ROWS.map((row) => Array.from(row).length),
  );
  return (columns ?? wordmarkWidth) >= wordmarkWidth
    ? RECURS_TERMINAL_WORDMARK_ROWS
    : RECURS_TERMINAL_ROWS;
}

export function renderRecursHeader(
  theme: TerminalTheme,
  fallback: string,
  options: {
    readonly columns?: number;
    readonly modeId?: string;
  } = {},
): string {
  const wordmark = renderRecursWordmark(theme, options);
  if (wordmark.length === 0) return fallback;
  return `${wordmark}\n${centeredPadding(fallback, options.columns)}${theme.strong(fallback)}`;
}

export function renderOperatingMode(
  theme: TerminalTheme,
  modeId: string,
  displayName: string,
): string {
  const label = isMaxMode(modeId) ? displayName.toUpperCase() : displayName;
  return isMaxMode(modeId) ? theme.rainbow(label) : theme.strong(label);
}

export function renderSetupStep(
  theme: TerminalTheme,
  current: number,
  total: number,
  label: string,
): string {
  const progress = `${String(current).padStart(2, "0")}/${
    String(total).padStart(2, "0")
  }`;
  return theme.accent(`${progress}  ${label.toUpperCase()}`);
}

export function renderChoiceList(
  theme: TerminalTheme,
  choices: readonly {
    readonly label: string;
    readonly detail: string;
  }[],
): string {
  return choices.map((choice, index) => [
    `  ${theme.accent(String(index + 1).padStart(2, "0"))}  ${
      theme.strong(choice.label)
    }`,
    `      ${theme.muted(choice.detail)}`,
  ].join("\n")).join("\n");
}

export function wrapTerminalText(
  text: string,
  columns: number,
): readonly string[] {
  const width = Math.max(1, Math.floor(columns));
  return Object.freeze(wrapTextWithAnsi(text.trim().replace(/\s+/gu, " "), width));
}
