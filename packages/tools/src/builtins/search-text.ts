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

export interface SearchTextInput {
  query: string;
  path: string;
  glob?: string;
}

function parseSearchTextInput(value: unknown): SearchTextInput {
  if (
    typeof value !== "object" ||
    value === null ||
    !("query" in value) ||
    typeof value.query !== "string" ||
    value.query.length === 0
  ) {
    throw new ToolError("invalid_input", "search_text requires a non-empty query");
  }
  const inputPath = "path" in value && value.path !== undefined ? value.path : ".";
  const glob = "glob" in value ? value.glob : undefined;
  if (typeof inputPath !== "string") {
    throw new ToolError("invalid_input", "path must be a string");
  }
  if (glob !== undefined && typeof glob !== "string") {
    throw new ToolError("invalid_input", "glob must be a string");
  }
  return {
    query: value.query,
    path: inputPath,
    ...(glob === undefined ? {} : { glob }),
  };
}

export function createSearchTextTool(
  options: PathPolicyOptions = {},
): Tool<SearchTextInput> {
  return {
    definition: {
      name: "search_text",
      description: "Search for fixed text inside the workspace using ripgrep",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          path: { type: "string" },
          glob: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    mutating: false,
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
      const args = [
        "--line-number",
        "--no-heading",
        "--color=never",
        "--fixed-strings",
      ];
      if (input.glob !== undefined) {
        args.push("--glob", input.glob);
      }
      for (const glob of credentialRipgrepGlobs()) {
        args.push("--iglob", glob);
      }
      args.push("--", input.query, resolved.relative);
      const process = await runProcess("rg", args, {
        cwd: context.cwd,
        signal: context.signal,
        maxOutputBytes: MAX_SEARCH_BYTES,
        acceptableExitCodes: [0, 1],
      });
      return {
        output: process.stdout,
        metadata: {
          path: resolved.relative,
          target: targetStat.isDirectory() ? "directory" : "file",
          matches: process.stdout === "" ? 0 : process.stdout.trimEnd().split("\n").length,
        },
      };
    },
  };
}
