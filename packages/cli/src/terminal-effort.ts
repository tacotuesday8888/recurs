import type { TerminalTheme } from "./terminal-style.js";

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** Decorative feedback for an explicit setting, never a measure of model progress. */
export function effortBadge(effort: string | undefined, theme: TerminalTheme, frame = 0): string {
  if (!effort) return "";
  const level = EFFORTS.indexOf(effort);
  const mark = level >= 6 ? ["✦", "✧", "✦", "✶"][Math.floor(frame / 3) % 4]! : level >= 4 ? "◆" : "◇";
  const text = `${theme.colorEnabled ? mark : "*"} ${effort}`;
  return level >= 6 ? theme.strong(theme.accent(text)) : level >= 4 ? theme.accent(text) : theme.muted(text);
}

export function effortLabel(effort: string): string {
  return `${["max", "ultra"].includes(effort) ? "✦ " : ""}${effort[0]!.toUpperCase()}${effort.slice(1)}`;
}
