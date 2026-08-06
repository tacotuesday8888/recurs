export function sanitizeTerminalText(
  text: string,
  options: { readonly multiline?: boolean } = {},
): string {
  const multiline = options.multiline ?? true;
  return [...text].flatMap((character) => {
    if (character === "\n") return multiline ? [character] : [];
    if (character === "\t") return multiline ? ["  "] : [];
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 0x1f && (codePoint < 0x7f || codePoint > 0x9f)
      ? [character]
      : [];
  }).join("");
}
