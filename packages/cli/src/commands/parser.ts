import type { ParsedCommand } from "./types.js";

const COMMAND_PATTERN = /^\/([a-z][a-z0-9_-]*)(?:\s+(.*))?$/iu;

export function parseCommand(input: string): ParsedCommand | null {
  const match = COMMAND_PATTERN.exec(input.trim());
  if (match === null) {
    return null;
  }
  return {
    name: (match[1] ?? "").toLowerCase(),
    args: (match[2] ?? "").trim(),
  };
}
