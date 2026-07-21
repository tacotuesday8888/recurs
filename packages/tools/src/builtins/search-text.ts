import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  assertNonCredentialPath,
  credentialRipgrepGlobs,
  isCredentialPath,
  isExternalPathApproved,
  pathPermissionIntents,
  WorkspacePathPolicy,
  type PathPolicyOptions,
} from "../path-policy.js";
import { runProcess } from "../process.js";
import { ToolError, type Tool } from "../types.js";

const MAX_QUERY_BYTES = 16 * 1024;
const MAX_GLOB_BYTES = 1024;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const MAX_RAW_SEARCH_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_OUTPUT_BYTES = 512 * 1024;
const MAX_MATCH_COLUMNS = 500;

export interface SearchTextInput {
  readonly query: string;
  readonly path: string;
  readonly glob?: string;
  readonly mode: "fixed" | "regex";
  readonly limit: number;
}

interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

function boundedString(
  value: unknown,
  name: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new ToolError(
      "invalid_input",
      `${name} must be a non-empty string of at most ${maximumBytes} bytes`,
    );
  }
  return value;
}

function parseSearchTextInput(value: unknown): SearchTextInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_input", "search_text expects an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) =>
      key !== "query" && key !== "path" && key !== "glob" &&
      key !== "mode" && key !== "limit"
    )
  ) {
    throw new ToolError("invalid_input", "search_text received an unknown option");
  }
  const query = boundedString(record.query, "query", MAX_QUERY_BYTES);
  const inputPath = record.path ?? ".";
  const glob = record.glob;
  const mode = record.mode ?? "fixed";
  const limit = record.limit ?? DEFAULT_LIMIT;
  if (typeof inputPath !== "string") {
    throw new ToolError("invalid_input", "path must be a string");
  }
  if (glob !== undefined) boundedString(glob, "glob", MAX_GLOB_BYTES);
  if (mode !== "fixed" && mode !== "regex") {
    throw new ToolError("invalid_input", "mode must be fixed or regex");
  }
  if (
    !Number.isSafeInteger(limit) || (limit as number) < 1 ||
    (limit as number) > MAX_LIMIT
  ) {
    throw new ToolError(
      "invalid_input",
      `limit must be between 1 and ${MAX_LIMIT}`,
    );
  }
  return {
    query,
    path: inputPath,
    ...(glob === undefined ? {} : { glob: glob as string }),
    mode,
    limit: limit as number,
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textValue(value: unknown): string | null {
  const record = recordValue(value);
  return typeof record?.text === "string" ? record.text : null;
}

function normalizeMatchPath(candidate: string, cwd: string): string {
  const absolute = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(cwd, candidate);
  const relative = path.relative(cwd, absolute);
  return (relative === "" ? "." : relative).split(path.sep).join("/");
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : null;
}

function parseSearchOutput(output: string, cwd: string, perFileCap: number): {
  readonly matches: readonly SearchMatch[];
  readonly matchedLines: number;
  readonly occurrences: number;
  readonly omitted: number;
  readonly searchCapped: boolean;
} {
  const matches: SearchMatch[] = [];
  let matchedLines: number | undefined;
  let occurrences: number | undefined;
  let omitted = 0;
  let searchCapped = false;
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new ToolError("process_failed", "Search returned malformed output", {
        cause: error,
      });
    }
    const event = recordValue(value);
    if (event === null || typeof event.type !== "string") {
      throw new ToolError("process_failed", "Search returned malformed output");
    }
    const data = recordValue(event.data);
    if (data === null) {
      throw new ToolError("process_failed", "Search returned malformed output");
    }
    if (event.type === "match") {
      const rawPath = textValue(data.path);
      const text = textValue(data.lines);
      const lineNumber = data.line_number;
      if (
        rawPath === null || text === null || !Number.isSafeInteger(lineNumber) ||
        (lineNumber as number) < 1 || isCredentialPath(rawPath)
      ) {
        omitted += 1;
        continue;
      }
      const matchPath = normalizeMatchPath(rawPath, cwd);
      if (isCredentialPath(matchPath)) {
        omitted += 1;
        continue;
      }
      matches.push({
        path: matchPath,
        line: lineNumber as number,
        text: text.replace(/\r?\n$/u, ""),
      });
      continue;
    }
    if (event.type === "summary") {
      if (matchedLines !== undefined || occurrences !== undefined) {
        throw new ToolError("process_failed", "Search returned duplicate summary output");
      }
      const stats = recordValue(data.stats);
      const summaryMatchedLines = nonNegativeInteger(stats?.matched_lines);
      const summaryOccurrences = nonNegativeInteger(stats?.matches);
      if (summaryMatchedLines === null || summaryOccurrences === null) {
        throw new ToolError("process_failed", "Search returned malformed summary output");
      }
      matchedLines = summaryMatchedLines;
      occurrences = summaryOccurrences;
      continue;
    }
    if (event.type === "end") {
      const endMatchedLines = nonNegativeInteger(
        recordValue(data.stats)?.matched_lines,
      );
      if (endMatchedLines === null) {
        throw new ToolError("process_failed", "Search returned malformed end output");
      }
      searchCapped ||= endMatchedLines >= perFileCap;
      continue;
    }
    if (event.type !== "begin" && event.type !== "context") {
      throw new ToolError("process_failed", "Search returned an unknown event");
    }
  }
  if (matchedLines === undefined || occurrences === undefined) {
    throw new ToolError("process_failed", "Search returned no summary output");
  }
  return { matches, matchedLines, occurrences, omitted, searchCapped };
}

function renderMatches(matches: readonly SearchMatch[], limit: number): {
  readonly output: string;
  readonly returned: number;
  readonly truncated: boolean;
} {
  let output = "";
  let outputBytes = 0;
  let returned = 0;
  for (const match of matches.slice(0, limit)) {
    const line = `${JSON.stringify(match)}\n`;
    if (
      outputBytes + Buffer.byteLength(line, "utf8") > MAX_SEARCH_OUTPUT_BYTES
    ) {
      return { output, returned, truncated: true };
    }
    output += line;
    outputBytes += Buffer.byteLength(line, "utf8");
    returned += 1;
  }
  return { output, returned, truncated: matches.length > returned };
}

export function createSearchTextTool(
  options: PathPolicyOptions = {},
): Tool<SearchTextInput> {
  return {
    definition: {
      name: "search_text",
      description:
        "Search bounded fixed text or a linear-time regular expression in workspace files",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          path: { type: "string" },
          glob: { type: "string", minLength: 1 },
          mode: { type: "string", enum: ["fixed", "regex"] },
          limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    executionClass: "fixed_process",
    mutating: false,
    parallelSafe: true,
    parse: parseSearchTextInput,
    permissions(input) {
      return pathPermissionIntents("read", input.path, options.sensitivePatterns);
    },
    async execute(input, context) {
      const resolved = await new WorkspacePathPolicy(
        context.cwd,
        options,
      ).resolveReadable(input.path, isExternalPathApproved(context, input.path));
      assertNonCredentialPath(resolved.relative);
      const targetStat = await stat(resolved.absolute);
      const canonicalCwd = await realpath(context.cwd);
      const perFileCap = input.limit + 1;
      const args = [
        "--json",
        "--line-number",
        "--color=never",
        "--no-config",
        `--max-columns=${MAX_MATCH_COLUMNS}`,
        "--max-columns-preview",
        `--max-count=${perFileCap}`,
      ];
      if (input.mode === "fixed") args.push("--fixed-strings");
      if (input.glob !== undefined) args.push("--glob", input.glob);
      for (const glob of credentialRipgrepGlobs()) args.push("--iglob", glob);
      args.push("--", input.query, resolved.absolute);
      const process = await runProcess("rg", args, {
        cwd: context.cwd,
        signal: context.signal,
        maxOutputBytes: MAX_RAW_SEARCH_BYTES,
        acceptableExitCodes: [0, 1, 2],
      });
      if (process.exitCode === 2) {
        const invalidRegex = input.mode === "regex" &&
          process.stderr.includes("regex parse error:");
        throw new ToolError(
          invalidRegex ? "invalid_input" : "process_failed",
          invalidRegex
            ? "Search regular expression is invalid"
            : "Search process failed",
        );
      }
      const parsed = parseSearchOutput(process.stdout, canonicalCwd, perFileCap);
      const rendered = renderMatches(parsed.matches, input.limit);
      const truncated = rendered.truncated || parsed.searchCapped ||
        parsed.matchedLines > rendered.returned;
      return {
        output: rendered.output,
        metadata: {
          path: resolved.relative,
          target: targetStat.isDirectory() ? "directory" : "file",
          mode: input.mode,
          matches: rendered.returned,
          matchedLines: parsed.matchedLines,
          occurrences: parsed.occurrences,
          omitted: parsed.omitted,
          truncated,
          sources: [
            `searched ${resolved.relative} (${rendered.returned} of ${parsed.matchedLines} matching lines)`,
          ],
        },
      };
    },
  };
}
