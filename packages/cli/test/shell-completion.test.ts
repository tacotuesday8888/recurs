import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CLI_HELP } from "../src/cli-help.js";
import {
  COMPLETION_SHELLS,
  isCompletionShell,
  renderShellCompletion,
} from "../src/shell-completion.js";

const execFileAsync = promisify(execFile);
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "recurs-completion-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const documentedCommands = [...CLI_HELP.matchAll(/^ {2}recurs ([a-z]+)/gmu)]
  .map((match) => match[1]!)
  .filter((command) => command !== "help");

describe("shell completion", () => {
  it("accepts only the supported shells", () => {
    expect(COMPLETION_SHELLS).toEqual(["bash", "zsh", "fish"]);
    expect(isCompletionShell("zsh")).toBe(true);
    expect(isCompletionShell("powershell")).toBe(false);
    expect(isCompletionShell(undefined)).toBe(false);
  });

  it("covers every documented top-level command and enumerated option value", () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = renderShellCompletion(shell);
      for (const command of new Set(documentedCommands)) {
        expect(script, `${shell} completes ${command}`).toContain(command);
      }
      for (const value of ["jsonl", "approved", "performance", "set-primary", "diagnose"]) {
        expect(script, `${shell} offers ${value}`).toContain(value);
      }
      expect(script).toContain(shell === "fish" ? "-l continue" : "--continue");
      expect(script).not.toMatch(/RECURS_HOME|\.recurs|sessions\//u);
    }
  });

  it("produces scripts that bash and zsh parse, and bash completes with", async () => {
    const bashScript = path.join(directory, "recurs.bash");
    await writeFile(bashScript, renderShellCompletion("bash"));
    await execFileAsync("bash", ["-n", bashScript]);
    const { stdout } = await execFileAsync("bash", [
      "-c",
      [
        `source ${JSON.stringify(bashScript)}`,
        "COMP_WORDS=(recurs run --format js); COMP_CWORD=3; _recurs; echo \"${COMPREPLY[*]}\"",
        "COMP_WORDS=(recurs setup ''); COMP_CWORD=2; _recurs; echo \"${COMPREPLY[*]}\"",
        "COMP_WORDS=(recurs run --con); COMP_CWORD=2; _recurs; echo \"${COMPREPLY[*]}\"",
      ].join("; "),
    ]);
    expect(stdout.split("\n")).toEqual([
      "json jsonl",
      "local byok codex copilot",
      "--connection --continue",
      "",
    ]);

    const zshScript = path.join(directory, "_recurs");
    await writeFile(zshScript, renderShellCompletion("zsh"));
    await execFileAsync("zsh", ["-n", zshScript]).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    expect(renderShellCompletion("zsh").startsWith("#compdef recurs\n")).toBe(true);
    expect(renderShellCompletion("fish")).toContain("complete -c recurs -n '__fish_use_subcommand' -a run");
  });
});
