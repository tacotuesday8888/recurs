import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";

import {
  assertNonCredentialPath,
  credentialRipgrepGlobs,
  isExternalPathApproved,
  isSensitivePath,
  pathPermissionIntents,
  WorkspacePathPolicy,
  type PathPolicyOptions,
  type ResolvedWorkspacePath,
} from "../path-policy.js";
import { runProcess } from "../process.js";
import { ToolError, type Tool } from "../types.js";

const DEFAULT_MAX_FILES = 200;
const DEFAULT_MAX_SYMBOLS = 300;
const MAX_FILES = 1_000;
const MAX_SYMBOLS = 1_000;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_DISCOVERY_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_INDEX_SYMBOLS = 20_000;
const MAX_REFERENCE_EDGES = 200_000;

export type CodeOutlineRanking = "source" | "references";

export interface CodeOutlineInput {
  path: string;
  query?: string;
  ranking: CodeOutlineRanking;
  maxFiles: number;
  maxSymbols: number;
}

interface Declaration {
  readonly line: number;
  readonly kind: string;
  readonly name: string;
}

interface LanguageSpec {
  readonly name: string;
  readonly patterns: readonly (readonly [kind: string, pattern: RegExp])[];
}

interface OutlinedFile {
  readonly path: string;
  readonly language: string;
  readonly declarations: readonly RankedDeclaration[];
  readonly referenceFiles?: number;
}

interface RankedDeclaration extends Declaration {
  readonly referenceFiles?: number;
}

interface IndexedFile extends OutlinedFile {
  readonly content: string;
}

const TYPESCRIPT: LanguageSpec = {
  name: "TypeScript/JavaScript",
  patterns: [
    ["class", /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/u],
    ["interface", /^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)\b/u],
    ["type", /^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\b/u],
    ["enum", /^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)\b/u],
    ["namespace", /^(?:export\s+)?(?:declare\s+)?namespace\s+([A-Za-z_$][\w$]*)\b/u],
    ["function", /^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\b/u],
    ["function", /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/u],
  ],
};

const LANGUAGE_BY_EXTENSION = new Map<string, LanguageSpec>([
  ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map(
    (extension) => [extension, TYPESCRIPT] as const,
  ),
  [".py", {
    name: "Python",
    patterns: [
      ["class", /^class\s+([A-Za-z_]\w*)\b/u],
      ["function", /^(?:async\s+)?def\s+([A-Za-z_]\w*)\b/u],
    ],
  }],
  [".rs", {
    name: "Rust",
    patterns: [
      ["function", /^(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern(?:\s+"[^"]+")?\s+)?fn\s+([A-Za-z_]\w*)\b/u],
      ["struct", /^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)\b/u],
      ["enum", /^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)\b/u],
      ["trait", /^(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)\b/u],
      ["type", /^(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)\b/u],
      ["module", /^(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\b/u],
      ["macro", /^macro_rules!\s+([A-Za-z_]\w*)\b/u],
    ],
  }],
  [".go", {
    name: "Go",
    patterns: [
      ["function", /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/u],
      ["type", /^type\s+([A-Za-z_]\w*)\b/u],
    ],
  }],
  [".swift", {
    name: "Swift",
    patterns: [
      ["type", /^(?:(?:public|package|internal|fileprivate|private|open|final|indirect|nonisolated)\s+)*(?:actor|class|struct|protocol|enum|typealias)\s+([A-Za-z_]\w*)\b/u],
      ["function", /^(?:(?:public|package|internal|fileprivate|private|open|final|static|class|mutating|nonmutating|nonisolated|override|required|convenience)\s+)*func\s+([A-Za-z_]\w*)\b/u],
    ],
  }],
  ...[".java", ".kt", ".kts", ".cs"].map((extension) => [extension, {
    name: extension === ".java" ? "Java" : extension === ".cs" ? "C#" : "Kotlin",
    patterns: [
      ["type", /^(?:(?:public|protected|private|internal|abstract|final|sealed|static|data|open|partial|record|value)\s+)*(?:class|interface|enum|record|object|struct)\s+([A-Za-z_]\w*)\b/u],
      ["function", /^(?:(?:public|protected|private|internal|abstract|final|sealed|static|suspend|open|override|async|virtual|inline|operator|external)\s+)*(?:fun|void)\s+([A-Za-z_]\w*)\b/u],
    ],
  }] as const),
  [".rb", {
    name: "Ruby",
    patterns: [
      ["class", /^class\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\b/u],
      ["module", /^module\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\b/u],
      ["function", /^def\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)\b/u],
    ],
  }],
  [".php", {
    name: "PHP",
    patterns: [
      ["type", /^(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)\b/iu],
      ["function", /^(?:(?:public|protected|private|static|final|abstract)\s+)*function\s+&?\s*([A-Za-z_]\w*)\b/iu],
    ],
  }],
  ...[".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh"].map(
    (extension) => [extension, {
      name: "C/C++",
      patterns: [
        ["type", /^(?:class|struct|enum(?:\s+class)?|union)\s+([A-Za-z_]\w*)\b/u],
        ["namespace", /^namespace\s+([A-Za-z_]\w*)\b/u],
      ],
    }] as const,
  ),
  ...[".sh", ".bash", ".zsh"].map((extension) => [extension, {
    name: "Shell",
    patterns: [
      ["function", /^(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/u],
      ["function", /^function\s+([A-Za-z_][\w-]*)\b/u],
    ],
  }] as const),
]);

function boundedInteger(
  value: unknown,
  name: string,
  defaultValue: number,
  maximum: number,
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new ToolError("invalid_input", `${name} must be between 1 and ${maximum}`);
  }
  return value as number;
}

function parseCodeOutlineInput(value: unknown): CodeOutlineInput {
  if (typeof value !== "object" || value === null) {
    throw new ToolError("invalid_input", "code_outline expects an object");
  }
  const inputPath = "path" in value && value.path !== undefined ? value.path : ".";
  const rawQuery = "query" in value ? value.query : undefined;
  if (typeof inputPath !== "string") {
    throw new ToolError("invalid_input", "path must be a string");
  }
  if (rawQuery !== undefined && (typeof rawQuery !== "string" || rawQuery.trim().length === 0)) {
    throw new ToolError("invalid_input", "query must be a non-empty string");
  }
  const query = typeof rawQuery === "string" ? rawQuery.trim() : undefined;
  if (query !== undefined && query.length > 256) {
    throw new ToolError("invalid_input", "query must not exceed 256 characters");
  }
  const rawRanking = "ranking" in value ? value.ranking : undefined;
  if (
    rawRanking !== undefined && rawRanking !== "source" &&
    rawRanking !== "references"
  ) {
    throw new ToolError("invalid_input", "ranking must be source or references");
  }
  return {
    path: inputPath,
    ...(query === undefined ? {} : { query }),
    ranking: rawRanking ?? "source",
    maxFiles: boundedInteger(
      "maxFiles" in value ? value.maxFiles : undefined,
      "maxFiles",
      DEFAULT_MAX_FILES,
      MAX_FILES,
    ),
    maxSymbols: boundedInteger(
      "maxSymbols" in value ? value.maxSymbols : undefined,
      "maxSymbols",
      DEFAULT_MAX_SYMBOLS,
      MAX_SYMBOLS,
    ),
  };
}

function languageFor(file: string): LanguageSpec | undefined {
  return LANGUAGE_BY_EXTENSION.get(path.extname(file).toLowerCase());
}

function isGenerated(file: string): boolean {
  const normalized = file.replaceAll("\\", "/").toLowerCase();
  const basename = path.posix.basename(normalized);
  return normalized.split("/").some((part) =>
    /^node[_]modules$/u.test(part) || part === "vendor" || part === "dist" ||
    part === "build" || part === "coverage" || part === ".git"
  ) || basename.endsWith(".min.js") || basename.endsWith(".min.css") ||
    basename.endsWith(".map");
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceRank(file: string): number {
  const normalized = file.replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/");
  const basename = parts.at(-1) ?? "";
  const stem = basename.replace(/\.[^.]+$/u, "");
  let score = parts.length * 4;
  if (["index", "main", "app", "cli", "server", "mod", "lib"].includes(stem)) score -= 16;
  if (parts.some((part) => part === "src" || part === "lib" || part === "packages")) score -= 4;
  if (parts.some((part) => part === "test" || part === "tests" || part === "__tests__" || part === "fixtures")) score += 40;
  if (/\.(?:test|spec)\.[^.]+$/u.test(basename)) score += 40;
  if (basename.endsWith(".d.ts")) score += 20;
  return score;
}

function rankCandidates(files: readonly string[], query?: string): string[] {
  const normalizedQuery = query?.toLowerCase();
  return [...new Set(files)].sort((left, right) => {
    if (normalizedQuery !== undefined) {
      const leftPath = left.toLowerCase().includes(normalizedQuery) ? 0 : 1;
      const rightPath = right.toLowerCase().includes(normalizedQuery) ? 0 : 1;
      if (leftPath !== rightPath) return leftPath - rightPath;
    }
    return sourceRank(left) - sourceRank(right) || lexicalCompare(left, right);
  });
}

function declarationFor(line: string, language: LanguageSpec): Omit<Declaration, "line"> | undefined {
  const trimmed = line.trim();
  if (
    trimmed.length === 0 || trimmed.startsWith("//") || trimmed.startsWith("#") ||
    trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("<!--")
  ) return undefined;
  for (const [kind, pattern] of language.patterns) {
    const match = pattern.exec(trimmed);
    const name = match?.[1];
    if (name !== undefined && name.length <= 256) return { kind, name };
  }
  return undefined;
}

function declarationsFrom(content: string, language: LanguageSpec): Declaration[] {
  const declarations: Declaration[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    const declaration = declarationFor(line, language);
    if (declaration !== undefined) declarations.push({ line: index + 1, ...declaration });
  }
  return declarations;
}

type BoundedRead =
  | { readonly kind: "content"; readonly content: string; readonly bytes: number }
  | { readonly kind: "binary" }
  | { readonly kind: "large" }
  | { readonly kind: "budget" }
  | { readonly kind: "changed" };

async function readBoundedSource(file: string, remainingBytes: number): Promise<BoundedRead> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) return { kind: "binary" };
    if (before.size > MAX_FILE_BYTES) return { kind: "large" };
    if (before.size > remainingBytes) return { kind: "budget" };
    const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES + 1, Math.max(1, before.size + 1)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (
      before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || bytesRead !== before.size
    ) return { kind: "changed" };
    if (bytesRead > MAX_FILE_BYTES) return { kind: "large" };
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) return { kind: "binary" };
    try {
      return {
        kind: "content",
        content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        bytes: bytesRead,
      };
    } catch {
      return { kind: "binary" };
    }
  } finally {
    await handle.close();
  }
}

async function discoverFiles(
  target: string,
  query: string | undefined,
  cwd: string,
  signal: AbortSignal,
): Promise<string[]> {
  const runDiscovery = async (
    args: string[],
    operands: readonly string[],
  ): Promise<string[]> => {
    for (const glob of credentialRipgrepGlobs()) args.push("--iglob", glob);
    args.push("--", ...operands);
    const result = await runProcess("rg", args, {
      cwd,
      signal,
      maxOutputBytes: MAX_DISCOVERY_BYTES,
      acceptableExitCodes: [0, 1],
    });
    return result.stdout.split("\n").filter((file) => file.length > 0);
  };
  if (query === undefined) return runDiscovery(["--files"], [target]);
  const [contentMatches, allFiles] = await Promise.all([
    runDiscovery([
      "--files-with-matches", "--fixed-strings", "--ignore-case", "--color=never",
    ], [query, target]),
    runDiscovery(["--files"], [target]),
  ]);
  const normalizedQuery = query.toLowerCase();
  return [
    ...contentMatches,
    ...allFiles.filter((file) => file.toLowerCase().includes(normalizedQuery)),
  ];
}

function renderOutline(
  files: readonly OutlinedFile[],
  maxBytes: number,
  ranking: CodeOutlineRanking,
): {
  readonly output: string;
  readonly renderedFiles: number;
  readonly renderedSymbols: number;
  readonly outputTruncated: boolean;
} {
  let output = "";
  let renderedFiles = 0;
  let renderedSymbols = 0;
  for (const file of files) {
    const referenceSuffix = ranking === "references"
      ? ` (referenced by ${file.referenceFiles ?? 0} ${(file.referenceFiles ?? 0) === 1 ? "file" : "files"})`
      : "";
    const header = `${file.path} [${file.language}]${referenceSuffix}\n`;
    for (const [index, declaration] of file.declarations.entries()) {
      const declarationSuffix = ranking === "references"
        ? ` (referenced by ${declaration.referenceFiles ?? 0} ${(declaration.referenceFiles ?? 0) === 1 ? "file" : "files"})`
        : "";
      const line = `  ${declaration.line}  ${declaration.kind} ${declaration.name}${declarationSuffix}\n`;
      const addition = index === 0 ? `${header}${line}` : line;
      if (Buffer.byteLength(output + addition, "utf8") > maxBytes) {
        return { output, renderedFiles, renderedSymbols, outputTruncated: true };
      }
      output += addition;
      if (index === 0) renderedFiles += 1;
      renderedSymbols += 1;
    }
  }
  return { output, renderedFiles, renderedSymbols, outputTruncated: false };
}

interface RankedIndex {
  readonly files: readonly OutlinedFile[];
  readonly referenceEdges: number;
  readonly weightedReferenceEdges: number;
  readonly graphTruncated: boolean;
}

interface IndexedDefinition {
  readonly file: IndexedFile;
  readonly declaration: Declaration;
}

interface WeightedReference {
  readonly source: string;
  readonly target: string;
  readonly name: string;
  readonly weight: number;
}

function identifierWeight(
  name: string,
  definitionFiles: number,
): number {
  let weight = 1;
  const compound = (name.includes("_") && /[A-Za-z]/u.test(name)) ||
    (/[A-Z]/u.test(name) && /[a-z]/u.test(name));
  if (compound && name.length >= 8) weight *= 10;
  else if (name.length < 8) weight *= 0.1;
  if (name.length < 4) weight *= 0.1;
  if (name.startsWith("_")) weight *= 0.1;
  if (definitionFiles > 5) weight *= 0.1;
  return weight;
}

function pageRank(
  filePaths: readonly string[],
  edges: readonly WeightedReference[],
): {
  readonly ranks: ReadonlyMap<string, number>;
  readonly outgoingWeights: ReadonlyMap<string, number>;
} {
  if (filePaths.length === 0) {
    return { ranks: new Map(), outgoingWeights: new Map() };
  }
  const outgoingWeights = new Map<string, number>();
  for (const edge of edges) {
    outgoingWeights.set(
      edge.source,
      (outgoingWeights.get(edge.source) ?? 0) + edge.weight,
    );
  }

  const damping = 0.85;
  const initial = 1 / filePaths.length;
  let ranks = new Map(filePaths.map((file) => [file, initial] as const));
  for (let iteration = 0; iteration < 50; iteration += 1) {
    let dangling = 0;
    for (const file of filePaths) {
      if ((outgoingWeights.get(file) ?? 0) === 0) dangling += ranks.get(file) ?? 0;
    }
    const base = (1 - damping) / filePaths.length +
      damping * dangling / filePaths.length;
    const next = new Map(filePaths.map((file) => [file, base] as const));
    for (const edge of edges) {
      const total = outgoingWeights.get(edge.source) ?? 0;
      if (total === 0) continue;
      const contribution = damping * (ranks.get(edge.source) ?? 0) * edge.weight / total;
      next.set(edge.target, (next.get(edge.target) ?? 0) + contribution);
    }
    let change = 0;
    for (const file of filePaths) {
      change += Math.abs((next.get(file) ?? 0) - (ranks.get(file) ?? 0));
    }
    ranks = next;
    if (change < 1e-9) break;
  }
  return { ranks, outgoingWeights };
}

function rankReferenceIndex(
  files: readonly IndexedFile[],
  query: string | undefined,
  maxSymbols: number,
  signal: AbortSignal,
): RankedIndex {
  const definitions = new Map<string, IndexedDefinition[]>();
  for (const file of files) {
    for (const declaration of file.declarations) {
      const existing = definitions.get(declaration.name) ?? [];
      existing.push({ file, declaration });
      definitions.set(declaration.name, existing);
    }
  }

  const references = new Map<string, Map<string, number>>();
  let graphTruncated = false;
  for (const source of files) {
    if (signal.aborted) throw new ToolError("cancelled", "code_outline was cancelled");
    const sourceCounts = new Map<string, number>();
    for (const match of source.content.matchAll(/[A-Za-z_$][\w$]*/gu)) {
      const name = match[0];
      if (definitions.has(name)) {
        sourceCounts.set(name, (sourceCounts.get(name) ?? 0) + 1);
      }
    }
    for (const [name, count] of sourceCounts) {
      const bySource = references.get(name) ?? new Map<string, number>();
      bySource.set(source.path, count);
      references.set(name, bySource);
    }
  }

  const normalizedQuery = query?.toLowerCase();
  const weightedReferences: WeightedReference[] = [];
  const identifierWeights = new Map<string, number>();
  const definitionReferenceCounts = new Map<string, number>();
  const targetFilesByName = new Map<string, Set<string>>();
  for (const [name, targets] of definitions) {
    const targetFiles = new Set(targets.map((target) => target.file.path));
    targetFilesByName.set(name, targetFiles);
    const weight = identifierWeight(name, targetFiles.size);
    identifierWeights.set(name, weight);
    const sources = references.get(name) ?? new Map<string, number>();
    for (const target of targetFiles) {
      definitionReferenceCounts.set(
        `${target}\0${name}`,
        sources.size - (sources.has(target) ? 1 : 0),
      );
    }
  }
  buildGraph: for (const [name, targetFiles] of targetFilesByName) {
    const weight = identifierWeights.get(name) ?? 1;
    const sources = references.get(name) ?? new Map<string, number>();
    for (const [source, occurrences] of sources) {
      for (const target of targetFiles) {
        if (source === target) continue;
        if (weightedReferences.length >= MAX_REFERENCE_EDGES) {
          graphTruncated = true;
          break buildGraph;
        }
        weightedReferences.push({
          source,
          target,
          name,
          weight: weight * Math.sqrt(occurrences),
        });
      }
    }
  }
  const fileReferrers = new Map<string, Set<string>>();
  const edges = new Set<string>();
  for (const edge of weightedReferences) {
    const sources = fileReferrers.get(edge.target) ?? new Set<string>();
    sources.add(edge.source);
    fileReferrers.set(edge.target, sources);
    edges.add(`${edge.source}\0${edge.target}`);
  }
  const graph = pageRank(files.map((file) => file.path), weightedReferences);
  const definitionScores = new Map<string, number>();
  for (const edge of weightedReferences) {
    const total = graph.outgoingWeights.get(edge.source) ?? 0;
    if (total === 0) continue;
    const key = `${edge.target}\0${edge.name}`;
    const score = (graph.ranks.get(edge.source) ?? 0) * edge.weight / total *
      (identifierWeights.get(edge.name) ?? 1);
    definitionScores.set(key, (definitionScores.get(key) ?? 0) + score);
  }
  const queryFileRanks = new Map<string, number>();
  if (normalizedQuery !== undefined) {
    for (const file of files) {
      if (file.path.toLowerCase().includes(normalizedQuery)) {
        queryFileRanks.set(file.path, 2);
      } else if (file.content.toLowerCase().includes(normalizedQuery)) {
        queryFileRanks.set(file.path, 1);
      }
    }
  }
  const ranked = [...definitions.values()].flat().sort((left, right) => {
    if (normalizedQuery !== undefined) {
      const leftRank = `${left.declaration.kind} ${left.declaration.name}`
        .toLowerCase().includes(normalizedQuery)
        ? 3
        : (queryFileRanks.get(left.file.path) ?? 0);
      const rightRank = `${right.declaration.kind} ${right.declaration.name}`
        .toLowerCase().includes(normalizedQuery)
        ? 3
        : (queryFileRanks.get(right.file.path) ?? 0);
      if (leftRank !== rightRank) return rightRank - leftRank;
    }
    const leftScore = definitionScores.get(
      `${left.file.path}\0${left.declaration.name}`,
    ) ?? 0;
    const rightScore = definitionScores.get(
      `${right.file.path}\0${right.declaration.name}`,
    ) ?? 0;
    return rightScore - leftScore ||
      (definitionReferenceCounts.get(
        `${right.file.path}\0${right.declaration.name}`,
      ) ?? 0) - (definitionReferenceCounts.get(
        `${left.file.path}\0${left.declaration.name}`,
      ) ?? 0) ||
      (fileReferrers.get(right.file.path)?.size ?? 0) -
        (fileReferrers.get(left.file.path)?.size ?? 0) ||
      sourceRank(left.file.path) - sourceRank(right.file.path) ||
      lexicalCompare(left.file.path, right.file.path) ||
      left.declaration.line - right.declaration.line ||
      lexicalCompare(left.declaration.name, right.declaration.name);
  }).slice(0, maxSymbols);

  const selected = new Map<string, {
    readonly source: IndexedFile;
    readonly declarations: RankedDeclaration[];
  }>();
  for (const item of ranked) {
    const existing = selected.get(item.file.path) ?? {
      source: item.file,
      declarations: [],
    };
    existing.declarations.push({
      ...item.declaration,
      referenceFiles: definitionReferenceCounts.get(
        `${item.file.path}\0${item.declaration.name}`,
      ) ?? 0,
    });
    selected.set(item.file.path, existing);
  }

  return {
    files: [...selected.values()].map(({ source, declarations }) => ({
      path: source.path,
      language: source.language,
      declarations: declarations.sort((left, right) => left.line - right.line),
      referenceFiles: fileReferrers.get(source.path)?.size ?? 0,
    })),
    referenceEdges: edges.size,
    weightedReferenceEdges: weightedReferences.length,
    graphTruncated,
  };
}

export function createCodeOutlineTool(
  options: PathPolicyOptions = {},
): Tool<CodeOutlineInput> {
  return {
    definition: {
      name: "code_outline",
      description: "List bounded lexical declarations, optionally ranked by cross-file references",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          query: { type: "string", minLength: 1, maxLength: 256 },
          ranking: { type: "string", enum: ["source", "references"] },
          maxFiles: { type: "integer", minimum: 1, maximum: MAX_FILES },
          maxSymbols: { type: "integer", minimum: 1, maximum: MAX_SYMBOLS },
        },
        additionalProperties: false,
      },
    },
    executionClass: "fixed_process",
    mutating: false,
    parallelSafe: true,
    parse: parseCodeOutlineInput,
    permissions(input) {
      return pathPermissionIntents("read", input.path, options.sensitivePatterns);
    },
    async execute(input, context) {
      const policy = new WorkspacePathPolicy(context.cwd, options);
      const allowExternal = isExternalPathApproved(context, input.path);
      const resolved = await policy.resolveReadable(input.path, allowExternal);
      assertNonCredentialPath(resolved.relative);
      const target = await stat(resolved.absolute);
      const referenceRanking = input.ranking === "references";
      const discovered = target.isDirectory()
        ? await discoverFiles(
          resolved.relative,
          referenceRanking ? undefined : input.query,
          context.cwd,
          context.signal,
        )
        : [resolved.relative];
      const uniqueDiscovered = [...new Set(discovered)];
      const supported = uniqueDiscovered.filter((file) => languageFor(file) !== undefined);
      const eligible = rankCandidates(
        supported.filter((file) => !isGenerated(file)), input.query,
      );
      if (!target.isDirectory() && eligible.length === 0) {
        throw new ToolError("invalid_input", `Unsupported source file: ${input.path}`);
      }

      let outlined: OutlinedFile[] = [];
      const indexed: IndexedFile[] = [];
      const languages = new Set<string>();
      let scannedFiles = 0;
      let scannedBytes = 0;
      let skippedBinaryFiles = 0;
      let skippedLargeFiles = 0;
      let skippedChangedFiles = 0;
      let skippedSensitiveFiles = 0;
      const skippedGeneratedFiles = supported.length - eligible.length;
      const skippedUnsupportedFiles = uniqueDiscovered.length - supported.length;
      let totalSymbols = 0;
      let limitReached = false;
      const normalizedQuery = input.query?.toLowerCase();

      for (const candidate of eligible) {
        if (
          scannedFiles >= input.maxFiles || scannedBytes >= MAX_SCAN_BYTES ||
          totalSymbols >= (referenceRanking ? MAX_INDEX_SYMBOLS : input.maxSymbols)
        ) {
          limitReached = true;
          break;
        }
        if (context.signal.aborted) throw new ToolError("cancelled", "code_outline was cancelled");
        if (isSensitivePath(candidate, options.sensitivePatterns)) {
          skippedSensitiveFiles += 1;
          continue;
        }
        let file: ResolvedWorkspacePath;
        try {
          file = await policy.resolveReadable(candidate, allowExternal);
        } catch (error) {
          if (error instanceof ToolError && error.code === "not_found") {
            skippedChangedFiles += 1;
            continue;
          }
          throw error;
        }
        assertNonCredentialPath(file.relative);
        const language = languageFor(file.relative);
        if (language === undefined) continue;
        let read: BoundedRead;
        try {
          read = await readBoundedSource(file.absolute, MAX_SCAN_BYTES - scannedBytes);
        } catch (error) {
          if (
            typeof error === "object" && error !== null && "code" in error &&
            error.code === "ENOENT"
          ) {
            skippedChangedFiles += 1;
            continue;
          }
          throw error;
        }
        scannedFiles += 1;
        if (read.kind === "binary") {
          skippedBinaryFiles += 1;
          continue;
        }
        if (read.kind === "large") {
          skippedLargeFiles += 1;
          continue;
        }
        if (read.kind === "changed") {
          skippedChangedFiles += 1;
          continue;
        }
        if (read.kind === "budget") {
          limitReached = true;
          break;
        }
        scannedBytes += read.bytes;
        let declarations = declarationsFrom(read.content, language);
        if (!referenceRanking && normalizedQuery !== undefined && !file.relative.toLowerCase().includes(normalizedQuery)) {
          declarations = declarations.filter((declaration) =>
            `${declaration.kind} ${declaration.name}`.toLowerCase().includes(normalizedQuery)
          );
        }
        const remaining = (referenceRanking ? MAX_INDEX_SYMBOLS : input.maxSymbols) - totalSymbols;
        if (declarations.length > remaining) {
          declarations = declarations.slice(0, remaining);
          limitReached = true;
        }
        if (referenceRanking) {
          indexed.push({
            path: file.relative,
            language: language.name,
            declarations,
            content: read.content,
          });
        } else {
          if (declarations.length === 0) continue;
          outlined.push({ path: file.relative, language: language.name, declarations });
        }
        if (declarations.length > 0) languages.add(language.name);
        totalSymbols += declarations.length;
      }

      const rankedIndex = referenceRanking
        ? rankReferenceIndex(indexed, input.query, input.maxSymbols, context.signal)
        : undefined;
      if (rankedIndex !== undefined) outlined = [...rankedIndex.files];
      const rendered = renderOutline(outlined, MAX_OUTPUT_BYTES, input.ranking);
      const truncated = limitReached || rendered.outputTruncated ||
        rankedIndex?.graphTruncated === true ||
        (referenceRanking && totalSymbols > input.maxSymbols);
      return {
        output: rendered.output,
        metadata: {
          path: resolved.relative,
          ...(input.query === undefined ? {} : { query: input.query }),
          ranking: input.ranking,
          scannedFiles,
          matchedFiles: rendered.renderedFiles,
          symbols: rendered.renderedSymbols,
          scannedBytes,
          skippedBinaryFiles,
          skippedLargeFiles,
          skippedChangedFiles,
          skippedSensitiveFiles,
          skippedGeneratedFiles,
          skippedUnsupportedFiles,
          languages: [...languages].sort(lexicalCompare),
          ...(rankedIndex === undefined ? {} : {
            indexedSymbols: totalSymbols,
            referenceEdges: rankedIndex.referenceEdges,
            weightedReferenceEdges: rankedIndex.weightedReferenceEdges,
            graphTruncated: rankedIndex.graphTruncated,
            rankingAlgorithm: "weighted_file_graph_v1",
          }),
          truncated,
          lexical: true,
          sources: [
            `${referenceRanking ? "ranked" : "outlined"} ${rendered.renderedFiles} ${rendered.renderedFiles === 1 ? "file" : "files"} under ${resolved.relative} (${rendered.renderedSymbols} lexical ${rendered.renderedSymbols === 1 ? "declaration" : "declarations"})`,
          ],
        },
      };
    },
  };
}
