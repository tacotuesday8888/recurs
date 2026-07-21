import { stat } from "node:fs/promises";

import {
  assertNonCredentialPath,
  credentialRipgrepGlobs,
  isExternalPathApproved,
  pathPermissionIntents,
  WorkspacePathPolicy,
  type PathPolicyOptions,
} from "../path-policy.js";
import { runProcess } from "../process.js";
import { ToolError, type Tool } from "../types.js";

const MAX_SEARCH_BYTES = 512 * 1024;
const MAX_GLOB_BYTES = 1_024;

export interface ListFilesInput {
  path: string;
  limit: number;
  glob?: string;
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
  const limit = record.limit ?? 2_000;
  const glob = record.glob;
  if (typeof inputPath !== "string") {
    throw new ToolError("invalid_input", "path must be a string");
  }
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 10_000) {
    throw new ToolError("invalid_input", "limit must be between 1 and 10000");
  }
  if (
    glob !== undefined &&
    (typeof glob !== "string" || glob.length === 0 ||
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

export function createListFilesTool(
  options: PathPolicyOptions = {},
): Tool<ListFilesInput> {
  return {
    definition: {
      name: "list_files",
      description: "List files under a workspace directory, optionally matching a glob",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 10_000 },
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
      const args = ["--files"];
      if (input.glob !== undefined) {
        args.push("--glob", input.glob);
      }
      for (const glob of credentialRipgrepGlobs()) {
        args.push("--iglob", glob);
      }
      args.push("--", resolved.relative);
      const process = await runProcess(
        "rg",
        args,
        {
          cwd: context.cwd,
          signal: context.signal,
          maxOutputBytes: MAX_SEARCH_BYTES,
          acceptableExitCodes: [0, 1],
        },
      );
      const files = process.stdout
        .split("\n")
        .filter((line) => line.length > 0)
        .sort((left, right) => left.localeCompare(right));
      const selected = files.slice(0, input.limit);
      return {
        output: selected.length === 0 ? "" : `${selected.join("\n")}\n`,
        metadata: {
          count: selected.length,
          total: files.length,
          truncated: files.length > selected.length,
          sources: [
            input.glob === undefined
              ? `listed ${resolved.relative} (${selected.length} of ${files.length} files)`
              : `listed ${resolved.relative} matching ${JSON.stringify(input.glob)} (${selected.length} of ${files.length} files)`,
          ],
        },
      };
    },
  };
}
