// C0 controls except tab and newline, DEL, and C1 controls. Astral characters
// and lone surrogates are kept, matching code-point iteration.
// eslint-disable-next-line no-control-regex -- removing controls is the purpose.
const multilineControls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;
// eslint-disable-next-line no-control-regex -- removing controls is the purpose.
const singleLineControls = /[\u0000-\u001f\u007f-\u009f]/gu;

export function sanitizeTerminalText(
  text: string,
  options: { readonly multiline?: boolean } = {},
): string {
  if (options.multiline ?? true) {
    return text.replace(multilineControls, "").replaceAll("\t", "  ");
  }
  return text.replace(singleLineControls, "");
}
