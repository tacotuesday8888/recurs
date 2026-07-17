import { credentialGitPathspecs } from "../path-policy.js";
import { safeGitArguments } from "../git-safety.js";
import { runProcess } from "../process.js";
import { ToolError, type Tool } from "../types.js";

export function createGitStatusTool(): Tool<Record<string, never>> {
  return {
    definition: {
      name: "git_status",
      description: "Show concise Git workspace status",
      inputSchema: { type: "object", additionalProperties: false },
    },
    executionClass: "fixed_process",
    mutating: false,
    parse(value) {
      if (
        typeof value !== "object" ||
        value === null ||
        Object.keys(value).length !== 0
      ) {
        throw new ToolError("invalid_input", "git_status does not accept arguments");
      }
      return {};
    },
    permissions() {
      return [{ category: "read", resource: ".git/status", risk: "normal" }];
    },
    async execute(_input, context) {
      const args = await safeGitArguments(
        context.cwd,
        [
          "status",
          "--short",
          "--branch",
          "--untracked-files=all",
          "--ignore-submodules=dirty",
          "--",
          ".",
          ...credentialGitPathspecs(),
        ],
        context.signal,
      );
      const result = await runProcess(
        "git",
        args,
        {
          cwd: context.cwd,
          signal: context.signal,
          maxOutputBytes: 1024 * 1024,
        },
      );
      return {
        output: result.stdout,
        metadata: {
          exitCode: result.exitCode,
          sources: ["inspected git status"],
        },
      };
    },
  };
}
