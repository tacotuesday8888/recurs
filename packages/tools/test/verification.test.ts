import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import * as toolExports from "../src/index.js";
import {
  PermissionEngine,
  ToolRegistry,
  type Tool,
  type ToolContext,
} from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

type VerificationExports = {
  createRunVerificationTool(): Tool;
  parseVerificationCommand(command: string): {
    readonly program: string;
    readonly args: readonly string[];
    readonly canonical: string;
  };
};

function verificationExports(): VerificationExports {
  expect(toolExports).toHaveProperty("createRunVerificationTool");
  expect(toolExports).toHaveProperty("parseVerificationCommand");
  return toolExports as typeof toolExports & VerificationExports;
}

describe("run_verification", () => {
  it.each([
    ["npm test", "npm", ["test"]],
    ["npm run typecheck", "npm", ["run", "typecheck"]],
    ["pnpm run lint", "pnpm", ["run", "lint"]],
    ["yarn test", "yarn", ["test"]],
    ["bun run check:generated", "bun", ["run", "check:generated"]],
    ["cargo test --workspace", "cargo", ["test", "--workspace"]],
    ["go test ./...", "go", ["test", "./..."]],
    ["pytest tests/unit", "pytest", ["tests/unit"]],
    ["python -m pytest", "python", ["-m", "pytest"]],
    ["swift test", "swift", ["test"]],
  ] as const)("accepts fixed verification command %s", (command, program, args) => {
    expect(verificationExports().parseVerificationCommand(command)).toEqual({
      program,
      args,
      canonical: command,
    });
  });

  it.each([
    "npm install",
    "npm publish",
    "npm run start",
    "echo test",
    "npm test && rm -rf .",
    "npm test | tee result.txt",
    "npm test > result.txt",
    "npm test $(touch nope)",
    "npm test `touch nope`",
    "npm test\nrm -rf .",
    "npm run lint -- --fix",
    "npm run lint -- --fix=true",
    "python -c 'print(1)'",
    "'unterminated",
  ])("rejects non-verification input %s", (command) => {
    expect(() => verificationExports().parseVerificationCommand(command))
      .toThrow();
  });

  it("runs an allowlisted command without a shell and records evidence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-verify-"));
    directories.push(directory);
    await writeFile(path.join(directory, "package.json"), JSON.stringify({
      scripts: { test: "node -e \"process.stdout.write('verified')\"" },
    }), "utf8");
    const tool = verificationExports().createRunVerificationTool();
    const context: ToolContext = {
      sessionId: "verification-session",
      cwd: directory,
      signal: new AbortController().signal,
      executionMode: "act",
      readRevisions: new Map(),
    };

    const result = await new ToolRegistry([tool]).invoke(
      {
        id: "verify-call",
        name: "run_verification",
        arguments: { command: "npm test", timeoutMs: 30_000 },
      },
      context,
      new PermissionEngine("full_access"),
      { async request() { return "deny"; } },
    );

    expect(result.output).toContain("verified");
    expect(result.metadata).toMatchObject({
      exitCode: 0,
      evidence: ["npm test exited 0"],
    });
  });

  it.each([
    [
      "times out bounded verification",
      "node -e \"setTimeout(() => {}, 5000)\"",
      25,
      "command_timeout",
    ],
    [
      "caps verification output",
      "node -e \"process.stdout.write('x'.repeat(1048577))\"",
      30_000,
      "output_limit",
    ],
  ])("%s", async (_name, script, timeoutMs, code) => {
    const directory = await mkdtemp(path.join(tmpdir(), "recurs-verify-bound-"));
    directories.push(directory);
    await writeFile(path.join(directory, "package.json"), JSON.stringify({
      scripts: { test: script },
    }), "utf8");
    const tool = verificationExports().createRunVerificationTool();

    await expect(new ToolRegistry([tool]).invoke(
      {
        id: "verify-bound",
        name: "run_verification",
        arguments: { command: "npm test", timeoutMs },
      },
      {
        sessionId: "verification-bound-session",
        cwd: directory,
        signal: new AbortController().signal,
        executionMode: "act",
        readRevisions: new Map(),
      },
      new PermissionEngine("full_access"),
      { async request() { return "deny"; } },
    )).rejects.toMatchObject({ code });
  });
});
