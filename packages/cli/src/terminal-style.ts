import type { Writable } from "node:stream";

import {
  RECURS_MARK_ANSI_256,
  RECURS_TERMINAL_ROWS,
  RECURS_TERMINAL_WORDMARK_ROWS,
} from "./generated/recurs-brand.js";

type TerminalEnvironment = Readonly<Record<string, string | undefined>>;

export interface TerminalThemeOptions {
  readonly colorEnabled?: boolean;
  readonly environment?: TerminalEnvironment;
  readonly terminal?: boolean;
}

export interface TerminalTheme {
  readonly colorEnabled: boolean;
  accent(text: string): string;
  brand(text: string, index: number): string;
  failure(text: string): string;
  muted(text: string): string;
  rainbow(text: string, offset?: number): string;
  strong(text: string): string;
  success(text: string): string;
  warning(text: string): string;
}

const RESET = "\u001b[0m";
const MAX_RAINBOW_ANSI_256 = Object.freeze([196, 208, 226, 46, 51, 39, 129]);

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
  return Object.freeze({
    colorEnabled,
    accent: (text: string) => ansi(colorEnabled, 96, text),
    brand: (text: string, index: number) =>
      ansi256(
        colorEnabled,
        RECURS_MARK_ANSI_256[index % RECURS_MARK_ANSI_256.length] ?? 51,
        text,
      ),
    failure: (text: string) => ansi(colorEnabled, 31, text),
    muted: (text: string) => ansi(colorEnabled, 2, text),
    rainbow: (text: string, offset = 0) =>
      Array.from(text, (glyph, index) =>
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
    success: (text: string) => ansi(colorEnabled, 32, text),
    warning: (text: string) => ansi(colorEnabled, 33, text),
  });
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

export function renderRecursWordmark(
  theme: TerminalTheme,
  options: {
    readonly columns?: number;
    readonly modeId?: string;
  } = {},
): string {
  if (!theme.colorEnabled) return "";
  const wordmarkWidth = Math.max(
    ...RECURS_TERMINAL_WORDMARK_ROWS.map((row) => Array.from(row).length),
  );
  const rows = (options.columns ?? wordmarkWidth) >= wordmarkWidth
    ? RECURS_TERMINAL_WORDMARK_ROWS
    : RECURS_TERMINAL_ROWS;
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
  const lines: string[] = [];
  let current = "";
  for (const word of text.trim().split(/\s+/u)) {
    const glyphs = Array.from(word);
    if (glyphs.length > width) {
      if (current.length > 0) {
        lines.push(current);
      }
      while (glyphs.length > width) {
        lines.push(glyphs.splice(0, width).join(""));
      }
      current = glyphs.join("");
      continue;
    }
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (Array.from(`${current} ${word}`).length <= width) {
      current = `${current} ${word}`;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current.length > 0) lines.push(current);
  return Object.freeze(lines);
}
