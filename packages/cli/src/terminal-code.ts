import ts from "typescript";
import type { TerminalTheme } from "./terminal-style.js";

/** Uses the shipped TypeScript lexer; unknown languages remain readable plain code. */
export function highlightTerminalCode(code: string, language: string | undefined, theme: TerminalTheme): string[] {
  if (!theme.colorEnabled || code.length > 65536 || !/^(?:[cm]?[jt]sx?|javascript|typescript|json|jsonc)$/iu.test(language ?? "")) {
    return code.split("\n").map(theme.code);
  }
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, code);
  let output = "";
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const style = token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia ? theme.muted
      : token === ts.SyntaxKind.StringLiteral || token === ts.SyntaxKind.NoSubstitutionTemplateLiteral ? theme.success
      : token === ts.SyntaxKind.NumericLiteral || token === ts.SyntaxKind.BigIntLiteral ? theme.warning
      : token >= ts.SyntaxKind.FirstKeyword && token <= ts.SyntaxKind.LastKeyword ? theme.accent : theme.code;
    output += scanner.getTokenText().split("\n").map((part) => part.length === 0 ? "" : style(part)).join("\n");
  }
  return output.split("\n");
}
