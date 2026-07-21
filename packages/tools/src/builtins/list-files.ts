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

const MAX_GLOB_BYTES = 1_024;
const DEFAULT_LIMIT = 2_000;
const MAX_LIMIT = 10_000;
const MAX_RAW_LIST_BYTES = 2 * 1024 * 1024;
const MAX_LIST_OUTPUT_BYTES = 512 * 1024;
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface ListFilesInput {
  readonly path: string;
  readonly limit: number;
  readonly glob?: string;
}

function parseListFilesInput(value: unknown): ListFilesInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_input", "list_files expects an object");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) =>
      key !== "path" && key !== "limit" && key !== "glob"
    )
  ) {
    throw new ToolError("invalid_input", "list_files received an unknown option");
  }
  const inputPath = record.path ?? ".";
  const limit = record.limit ?? DEFAULT_LIMIT;
  const glob = record.glob;
  if (typeof inputPath !== "string") {
    throw new ToolError("invalid_input", "path must be a string");
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
  if (
    glob !== undefined &&
    (typeof glob !== "string" || glob.length === 0 || glob.includes("\0") ||
      Buffer.byteLength(glob, "utf8") > MAX_GLOB_BYTES)
  ) {
    throw new ToolError(
      "invalid_input",
      `glob must be a non-empty string of at most ${MAX_GLOB_BYTES} bytes`,
    );
  }
  return {
    path: inputPath,
    limit: limit as number,
    ...(glob === undefined ? {} : { glob }),
  };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function normalizedRelative(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  return (relative === "" ? "." : relative).split(path.sep).join("/");
}

function parseFilePaths(
  bytes: Buffer,
  directory: string,
  cwd: string,
): { readonly paths: readonly string[]; readonly omitted: number } {
  if (bytes.length === 0) return { paths: [], omitted: 0 };
  if (bytes.at(-1) !== 0) {
    throw new ToolError("process_failed", "File listing was not NUL-terminated");
  }
  const paths = new Set<string>();
  let omitted = 0;
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index === start) {
      throw new ToolError("process_failed", "File listing contained an empty path");
    }
    let candidate: string;
    try {
      candidate = FATAL_UTF8.decode(bytes.subarray(start, index));
    } catch {
      omitted += 1;
      start = index + 1;
      continue;
    }
    start = index + 1;
    const absolute = path.isAbsolute(candidate)
      ? path.normalize(candidate)
      : path.resolve(cwd, candidate);
    const normalized = normalizedRelative(cwd, absolute);
    if (
      !isWithin(directory, absolute) || isCredentialPath(candidate) ||
      isCredentialPath(normalized)
    ) {
      omitted += 1;
      continue;
    }
    paths.add(normalized);
  }
  return {
    paths: [...paths].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
    ),
    omitted,
  };
}

function renderPaths(paths: readonly string[], limit: number): {
  readonly output: string;
  readonly returned: number;
  readonly truncated: boolean;
} {
  let output = "";
  let outputBytes = 0;
  let returned = 0;
  for (const filePath of paths.slice(0, limit)) {
    const line = `${JSON.stringify({ path: filePath })}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (outputBytes + lineBytes > MAX_LIST_OUTPUT_BYTES) {
      return { output, returned, truncated: true };
    }
    output += line;
    outputBytes += lineBytes;
    returned += 1;
  }
  return { output, returned, truncated: paths.length > returned };
}

export function createListFilesTool(
  options: PathPolicyOptions = {},
): Tool<ListFilesInput> {
  return {
    definition: {
      name: "list_files",
      description:
        "List bounded, deterministic, structured file paths under a workspace directory",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
          glob: { type: "string", minLength: 1, maxLength: MAX_GLOB_BYTES },
        },
        additionalProperties: false,
      },
    },
    executionClass: "fixed_process",
    mutating: false,
    parallelSafe: true,
    parse: parseListFilesInput,
    permissions(input) {
      return pathPermissionIntents("read", input.path, options.sensitivePatterns);
    },
    async execute(input, context) {
      const resolved = await new WorkspacePathPolicy(
        context.cwd,
        options,
      ).resolveReadable(input.path, isExternalPathApproved(context, input.path));
      assertNonCredentialPath(resolved.relative);
      if (!(await stat(resolved.absolute)).isDirectory()) {
        throw new ToolError("not_a_directory", `Not a directory: ${input.path}`);
      }
      const canonicalCwd = await realpath(context.cwd);
      const args = ["--files", "--null", "--no-config"];
      if (input.glob !== undefined) args.push("--glob", input.glob);
      for (const glob of credentialRipgrepGlobs()) args.push("--iglob", glob);
      args.push("--", resolved.absolute);
      const process = await runProcess("rg", args, {
        cwd: context.cwd,
        signal: context.signal,
        maxOutputBytes: MAX_RAW_LIST_BYTES,
        captureStdoutBytes: true,
        acceptableExitCodes: [0, 1],
      });
      if (process.stdoutBytes === undefined) {
        throw new ToolError("process_failed", "File listing bytes were unavailable");
      }
      const parsed = parseFilePaths(
        process.stdoutBytes,
        resolved.absolute,
        canonicalCwd,
      );
      const rendered = renderPaths(parsed.paths, input.limit);
      return {
        output: rendered.output,
        metadata: {
          count: rendered.returned,
          total: parsed.paths.length,
          omitted: parsed.omitted,
          truncated: rendered.truncated || parsed.omitted > 0,
          sources: [
            input.glob === undefined
              ? `listed ${resolved.relative} (${rendered.returned} of ${parsed.paths.length} files)`
              : `listed ${resolved.relative} matching ${JSON.stringify(input.glob)} (${rendered.returned} of ${parsed.paths.length} files)`,
          ],
        },
      };
    },
  };
}
