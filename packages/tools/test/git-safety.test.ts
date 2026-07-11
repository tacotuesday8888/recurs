import { describe, expect, it, vi } from "vitest";

import type { ProcessResult, runProcess } from "../src/process.js";
import { safeGitArguments } from "../src/git-safety.js";

function result(stdout: string): ProcessResult {
  return { stdout, stderr: "", exitCode: 0 };
}

describe("Git safety preflight", () => {
  it.each(["git version 2.44.9\n", "git version unknown\n"])(
    "rejects an unsupported Git report %j before protected commands",
    async (version) => {
      const runner: typeof runProcess = vi.fn(
        async (
          _command: string,
          args: readonly string[],
        ) => {
          expect(args).toEqual(["--version"]);
          return result(version);
        },
      );

      await expect(
        safeGitArguments("/workspace", ["status"], undefined, runner),
      ).rejects.toMatchObject({ code: "unsupported_git_version" });
      expect(runner).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["git version 2.45.0\n", "git version 3.0.0-rc1\n"])(
    "accepts a supported Git report %j and retains the hardening flag",
    async (version) => {
      const runner: typeof runProcess = vi.fn(
        async (
          _command: string,
          args: readonly string[],
        ) => args[0] === "--version" ? result(version) : result(""),
      );

      const args = await safeGitArguments(
        "/workspace",
        ["status"],
        undefined,
        runner,
      );

      expect(args).toContain("--no-lazy-fetch");
      expect(args.at(-1)).toBe("status");
      expect(runner).toHaveBeenCalledTimes(2);
    },
  );
});
