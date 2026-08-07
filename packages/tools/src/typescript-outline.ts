import path from "node:path";

import ts from "typescript";

export interface TypeScriptOutlineDeclaration {
  readonly line: number;
  readonly kind: string;
  readonly name: string;
}

export interface TypeScriptOutlineSource {
  readonly path: string;
  readonly content: string;
  readonly declarations: readonly TypeScriptOutlineDeclaration[];
}

export interface TypeScriptOutlineReference {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly targetLine: number;
  readonly targetName: string;
}

export interface TypeScriptOutlineReferenceIndex {
  readonly analyzedPaths: ReadonlySet<string>;
  readonly references: readonly TypeScriptOutlineReference[];
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

function virtualPath(file: string): string {
  const safe = file.replaceAll("\\", "/").replace(/^\/+/, "");
  return path.posix.join("/__recurs_outline__", safe);
}

function declarationIdentifier(node: ts.Declaration): ts.Identifier | undefined {
  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ||
    ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) || ts.isVariableDeclaration(node) ||
    ts.isMethodDeclaration(node) || ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return node.name !== undefined && ts.isIdentifier(node.name)
      ? node.name
      : undefined;
  }
  if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name;
  }
  return undefined;
}

function isDeclarationIdentifier(node: ts.Identifier): boolean {
  return declarationIdentifier(node.parent as ts.Declaration) === node ||
    ts.isParameter(node.parent) && node.parent.name === node;
}

function isImportOrExportIdentifier(node: ts.Identifier): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (ts.isImportDeclaration(current) || ts.isImportEqualsDeclaration(current) ||
      ts.isExportDeclaration(current)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/** Resolve cross-file TypeScript/JavaScript references without filesystem reads. */
export function indexTypeScriptOutlineReferences(
  files: readonly TypeScriptOutlineSource[],
): TypeScriptOutlineReferenceIndex {
  const sourceByVirtualPath = new Map<string, TypeScriptOutlineSource>();
  for (const file of files) {
    const virtual = virtualPath(file.path);
    const existing = sourceByVirtualPath.get(virtual);
    if (existing !== undefined && existing.path !== file.path) {
      throw new TypeError("TypeScript outline paths collide after normalization");
    }
    sourceByVirtualPath.set(virtual, file);
  }
  const directories = new Set<string>(["/__recurs_outline__"]);
  for (const file of sourceByVirtualPath.keys()) {
    let directory = path.posix.dirname(file);
    while (directory.startsWith("/__recurs_outline__")) {
      directories.add(directory);
      if (directory === "/__recurs_outline__") break;
      directory = path.posix.dirname(directory);
    }
  }
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    module: ts.ModuleKind.NodeNext,
    moduleDetection: ts.ModuleDetectionKind.Legacy,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    noLib: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
  };
  const fileExists = (file: string) => sourceByVirtualPath.has(file);
  const readFile = (file: string) => sourceByVirtualPath.get(file)?.content;
  const moduleHost: ts.ModuleResolutionHost = {
    fileExists,
    readFile,
    directoryExists: (directory) => directories.has(directory),
    getCurrentDirectory: () => "/__recurs_outline__",
    getDirectories: () => [],
    realpath: (file) => file,
  };
  const host: ts.CompilerHost = {
    fileExists,
    readFile,
    directoryExists: (directory) => directories.has(directory),
    getDirectories: () => [],
    realpath: (file) => file,
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => "/__recurs_outline__",
    getDefaultLibFileName: () => "/__recurs_outline__/lib.d.ts",
    getNewLine: () => "\n",
    getSourceFile(file, languageVersion) {
      const content = readFile(file);
      return content === undefined
        ? undefined
        : ts.createSourceFile(
            file,
            content,
            languageVersion,
            true,
            scriptKindFor(file),
          );
    },
    useCaseSensitiveFileNames: () => true,
    writeFile() {},
    resolveModuleNames(moduleNames, containingFile) {
      return moduleNames.map((moduleName) =>
        ts.resolveModuleName(
          moduleName,
          containingFile,
          options,
          moduleHost,
        ).resolvedModule
      );
    },
  };
  const program = ts.createProgram({
    rootNames: [...sourceByVirtualPath.keys()],
    options,
    host,
  });
  const checker = program.getTypeChecker();
  const targetCache = new Map<ts.Symbol, {
    readonly path: string;
    readonly line: number;
    readonly name: string;
  } | null>();

  const targetFor = (input: ts.Symbol): Exclude<
    ReturnType<typeof targetCache.get>,
    undefined
  > => {
    const symbol = (input.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(input)
      : input;
    const cached = targetCache.get(symbol);
    if (cached !== undefined) return cached;
    for (const declaration of symbol.declarations ?? []) {
      const source = declaration.getSourceFile();
      const indexed = sourceByVirtualPath.get(source.fileName);
      const identifier = declarationIdentifier(declaration);
      if (indexed === undefined || identifier === undefined) continue;
      const line = source.getLineAndCharacterOfPosition(
        declaration.getStart(source),
      ).line + 1;
      const outlined = indexed.declarations.find((candidate) =>
        candidate.line === line &&
        (candidate.name === identifier.text ||
          candidate.name.endsWith(`.${identifier.text}`))
      );
      if (outlined !== undefined) {
        const target = { path: indexed.path, line, name: outlined.name };
        targetCache.set(symbol, target);
        return target;
      }
    }
    targetCache.set(symbol, null);
    return null;
  };

  const references: TypeScriptOutlineReference[] = [];
  for (const [fileName, indexed] of sourceByVirtualPath) {
    const source = program.getSourceFile(fileName);
    if (source === undefined) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !isDeclarationIdentifier(node) &&
        !isImportOrExportIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node);
        const target = symbol === undefined ? null : targetFor(symbol);
        if (target !== null && target.path !== indexed.path) {
          references.push({
            sourcePath: indexed.path,
            targetPath: target.path,
            targetLine: target.line,
            targetName: target.name,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return {
    analyzedPaths: new Set(files.map((file) => file.path)),
    references,
  };
}
