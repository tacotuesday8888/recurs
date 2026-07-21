import {
  assertNonCredentialPath,
  credentialGitPathspecs,
  pathPermissionIntents,
  WorkspacePathPolicy,
} from "../path-policy.js";
import { safeGitArguments } from "../git-safety.js";
import { runProcess } from "../process.js";
import { ToolError, type Tool } from "../types.js";

export interface GitDiffInput {
  staged: boolean;
  path?: string;
}

function parseGitDiffInput(value: unknown): GitDiffInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_input", "git_diff expects an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "staged" && key !== "path")) {
    throw new ToolError("invalid_input", "git_diff received an unknown option");
  }
  const staged = record.staged !== undefined
    ? record.staged
    : false;
  const inputPath = record.path;
  if (typeof staged !== "boolean") {
    throw new ToolError("invalid_input", "staged must be a boolean");
  }
  if (inputPath !== undefined && typeof inputPath !== "string") {
    throw new ToolError("invalid_input", "path must be a string");
  }
  return {
    staged,
    ...(inputPath === undefined ? {} : { path: inputPath }),
  };
}

export function createGitDiffTool(): Tool<GitDiffInput> {
  return {
    definition: {
      name: "git_diff",
      description: "Show a bounded Git diff for the workspace",
      inputSchema: {
        type: "object",
        properties: {
          staged: { type: "boolean" },
          path: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    executionClass: "fixed_process",
    mutating: false,
    parallelSafe: true,
    parse: parseGitDiffInput,
    permissions(input) {
      return input.path === undefined
        ? [{ category: "read", resource: ".", risk: "normal" }]
        : pathPermissionIntents("read", input.path);
    },
    async execute(input, context) {
      const args = [
        "-c",
        "core.quotePath=true",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--no-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--submodule=short",
        "--ignore-submodules=dirty",
      ];
      if (input.staged) {
        args.push("--cached");
      }
      let target = ".";
      if (input.path !== undefined) {
        const resolved = await new WorkspacePathPolicy(
          context.cwd,
        ).resolveWritable(input.path);
        assertNonCredentialPath(resolved.relative);
        target = resolved.relative;
      }
      const targetPathspec = target === "." ? target : `:(top,literal)${target}`;
      args.push("--", targetPathspec, ...credentialGitPathspecs());
      const safeArgs = await safeGitArguments(context.cwd, args, context.signal);
      const result = await runProcess("git", safeArgs, {
        cwd: context.cwd,
        signal: context.signal,
        maxOutputBytes: 1024 * 1024,
      });
      return {
        output: result.stdout,
        metadata: {
          exitCode: result.exitCode,
          sources: [
            `inspected ${input.staged ? "staged" : "working-tree"} git diff for ${target}`,
          ],
        },
      };
    },
  };
}
