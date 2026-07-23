import type { Writable } from "node:stream";

import {
  RECURS_MARK_ANSI_256,
  RECURS_TERMINAL_ROWS,
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
  strong(text: string): string;
  success(text: string): string;
  warning(text: string): string;
}

const RESET = "\u001b[0m";

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
    strong: (text: string) => ansi(colorEnabled, 1, text),
    success: (text: string) => ansi(colorEnabled, 32, text),
    warning: (text: string) => ansi(colorEnabled, 33, text),
  });
}

export function renderRecursWordmark(theme: TerminalTheme): string {
  if (!theme.colorEnabled) return "";
  return RECURS_TERMINAL_ROWS.map((row, rowIndex) =>
    Array.from(row, (glyph, glyphIndex) =>
      glyph === " "
        ? glyph
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
    ).join("")
  ).join("\n");
}

export function renderRecursHeader(
  theme: TerminalTheme,
  fallback: string,
): string {
  const wordmark = renderRecursWordmark(theme);
  if (wordmark.length === 0) return fallback;
  return `${wordmark}\n${theme.strong(fallback)}`;
}
