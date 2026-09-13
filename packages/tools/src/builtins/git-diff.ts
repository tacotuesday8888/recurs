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
  /** Compare the current working tree with a local commit/ref. */
  base?: string;
}

function parseGitDiffInput(value: unknown): GitDiffInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError("invalid_input", "git_diff expects an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "staged" && key !== "path" && key !== "base")) {
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
  if (record.base !== undefined && (typeof record.base !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/~^+-]{0,255}$/u.test(record.base) || staged)) {
    throw new ToolError("invalid_input", "base must be one local Git revision, without staged");
  }
  return {
    staged,
    ...(record.base === undefined ? {} : { base: record.base as string }),
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
          base: { type: "string" },
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
      const prefix = await safeGitArguments(context.cwd, [], context.signal);
      const args = [
        "--no-replace-objects",
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
      if (input.base !== undefined) {
        const parsed = parseGitDiffInput(input);
        const resolved = await runProcess("git", [...prefix, "--no-replace-objects", "rev-parse", "--verify", "--end-of-options", `${parsed.base}^{commit}`], { cwd: context.cwd, signal: context.signal, maxOutputBytes: 4096, timeoutMs: 5000, acceptableExitCodes: [0, 1, 128] });
        const oid = resolved.stdout.trim();
        if (resolved.exitCode !== 0 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(oid)) throw new ToolError("invalid_input", "Git revision not found");
        args.push(oid);
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
      const safeArgs = [...prefix, ...args];
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
