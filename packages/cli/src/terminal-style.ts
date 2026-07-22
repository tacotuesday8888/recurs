import type { Writable } from "node:stream";

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
const BRAND_COLORS = Object.freeze([95, 91, 93, 92, 96, 94]);
const WORDMARK_GLYPHS = Object.freeze([
  Object.freeze(["████ ", "█   █", "████ ", "█  █ ", "█   █"]),
  Object.freeze(["█████", "█    ", "████ ", "█    ", "█████"]),
  Object.freeze([" ████", "█    ", "█    ", "█    ", " ████"]),
  Object.freeze(["█   █", "█   █", "█   █", "█   █", " ███ "]),
  Object.freeze(["████ ", "█   █", "████ ", "█  █ ", "█   █"]),
  Object.freeze([" ████", "█    ", " ███ ", "    █", "████ "]),
]);

function ansi(enabled: boolean, code: number, text: string): string {
  return enabled ? `\u001b[${code}m${text}${RESET}` : text;
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
      ansi(colorEnabled, BRAND_COLORS[index % BRAND_COLORS.length] ?? 96, text),
    failure: (text: string) => ansi(colorEnabled, 31, text),
    muted: (text: string) => ansi(colorEnabled, 2, text),
    strong: (text: string) => ansi(colorEnabled, 1, text),
    success: (text: string) => ansi(colorEnabled, 32, text),
    warning: (text: string) => ansi(colorEnabled, 33, text),
  });
}

export function renderRecursWordmark(theme: TerminalTheme): string {
  if (!theme.colorEnabled) return "";
  return Array.from({ length: 5 }, (_unused, row) =>
    WORDMARK_GLYPHS.map((glyph, index) =>
      theme.brand(glyph[row] ?? "", index)
    ).join(" ")
  ).join("\n");
}

export function renderRecursHeader(
  theme: TerminalTheme,
  fallback: string,
): string {
  const wordmark = renderRecursWordmark(theme);
  return wordmark.length === 0
    ? fallback
    : `${wordmark}\n${theme.strong(fallback)}`;
}
