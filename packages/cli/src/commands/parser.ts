import type { ParsedCommand } from "./types.js";

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isCommandNameCharacter(code: number): boolean {
  return isAsciiLetter(code) ||
    (code >= 48 && code <= 57) ||
    code === 45 ||
    code === 95;
}

function isWhitespace(character: string): boolean {
  return character.trim().length === 0;
}

function containsLineTerminator(value: string, start: number): boolean {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (
    trimmed.length < 2 ||
    trimmed[0] !== "/" ||
    !isAsciiLetter(trimmed.charCodeAt(1))
  ) {
    return null;
  }

  let cursor = 2;
  while (
    cursor < trimmed.length &&
    isCommandNameCharacter(trimmed.charCodeAt(cursor))
  ) {
    cursor += 1;
  }
  const name = trimmed.slice(1, cursor).toLowerCase();
  if (cursor === trimmed.length) return { name, args: "" };
  if (!isWhitespace(trimmed[cursor] ?? "")) return null;
  while (
    cursor < trimmed.length &&
    isWhitespace(trimmed[cursor] ?? "")
  ) {
    cursor += 1;
  }
  if (containsLineTerminator(trimmed, cursor)) return null;

  return {
    name,
    args: trimmed.slice(cursor).trim(),
  };
}
