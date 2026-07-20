import path from "node:path";

import ts from "typescript";

export interface TypeScriptOutlineDeclaration {
  readonly line: number;
  readonly kind: string;
  readonly name: string;
}

function scriptKindFor(file: string): ts.ScriptKind {
  switch (path.extname(file).toLowerCase()) {
    case ".ts":
    case ".mts":
    case ".cts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.JS;
  }
}

function declarationName(node: ts.DeclarationName | ts.ModuleName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return undefined;
}

function callableInitializer(
  expression: ts.Expression | undefined,
): "function" | "class" | undefined {
  let current = expression;
  while (
    current !== undefined &&
    (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current))
  ) {
    current = current.expression;
  }
  if (current !== undefined && (ts.isArrowFunction(current) || ts.isFunctionExpression(current))) {
    return "function";
  }
  return current !== undefined && ts.isClassExpression(current) ? "class" : undefined;
}

export function parseTypeScriptOutline(
  file: string,
  content: string,
): readonly TypeScriptOutlineDeclaration[] {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    false,
    scriptKindFor(file),
  );
  const declarations: TypeScriptOutlineDeclaration[] = [];
  const seen = new Set<string>();

  const add = (node: ts.Node, kind: string, name: string): void => {
    if (name.length === 0 || name.length > 256) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const key = `${line}\0${kind}\0${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    declarations.push({ line, kind, name });
  };

  const visitStatements = (
    statements: ts.NodeArray<ts.Statement>,
    prefix = "",
  ): void => {
    for (const statement of statements) {
      if (ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
        if (statement.name === undefined) continue;
        const local = statement.name.text;
        const owner = `${prefix}${local}`;
        add(statement, ts.isClassDeclaration(statement) ? "class" : "interface", owner);
        for (const member of statement.members) {
          if (
            !ts.isMethodDeclaration(member) && !ts.isMethodSignature(member) &&
            !ts.isGetAccessorDeclaration(member) && !ts.isSetAccessorDeclaration(member)
          ) continue;
          const memberName = declarationName(member.name);
          if (memberName !== undefined) add(member, "method", `${owner}.${memberName}`);
        }
        continue;
      }
      if (ts.isFunctionDeclaration(statement)) {
        if (statement.name !== undefined) add(statement, "function", `${prefix}${statement.name.text}`);
        continue;
      }
      if (ts.isTypeAliasDeclaration(statement)) {
        add(statement, "type", `${prefix}${statement.name.text}`);
        continue;
      }
      if (ts.isEnumDeclaration(statement)) {
        add(statement, "enum", `${prefix}${statement.name.text}`);
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) continue;
          const kind = callableInitializer(declaration.initializer);
          if (kind !== undefined) add(declaration, kind, `${prefix}${declaration.name.text}`);
        }
        continue;
      }
      if (ts.isModuleDeclaration(statement)) {
        const local = declarationName(statement.name);
        if (local === undefined) continue;
        let owner = `${prefix}${local}`;
        add(statement, "namespace", owner);
        let body = statement.body;
        while (body !== undefined && ts.isModuleDeclaration(body)) {
          const nested = declarationName(body.name);
          if (nested === undefined) break;
          owner = `${owner}.${nested}`;
          add(body, "namespace", owner);
          body = body.body;
        }
        if (body !== undefined && ts.isModuleBlock(body)) {
          visitStatements(body.statements, `${owner}.`);
        }
      }
    }
  };

  visitStatements(source.statements);
  return declarations.sort((left, right) =>
    left.line - right.line || left.kind.localeCompare(right.kind) ||
    left.name.localeCompare(right.name)
  );
}
