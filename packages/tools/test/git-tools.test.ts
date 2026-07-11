import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PermissionEngine,
  ToolRegistry,
  createGitDiffTool,
  createGitStatusTool,
  type ApprovalHandler,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "recurs-git-tools-"));
  await execFileAsync("git", ["init", "--quiet"], { cwd });
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const deny: ApprovalHandler = {
  async request() {
    return "deny";
  },
};

function context(): ToolContext {
  return {
    sessionId: "s1",
    cwd,
    signal: new AbortController().signal,
    executionMode: "act",
    readRevisions: new Map(),
  };
}

async function invoke(
  tool: Tool,
  arguments_: unknown,
): Promise<ToolResult> {
  return new ToolRegistry([tool]).invoke(
    { id: "call-1", name: tool.definition.name, arguments: arguments_ },
    context(),
    new PermissionEngine("full_access"),
    deny,
  );
}

describe("credential-safe Git inspection", () => {
  it("excludes credential paths and contents from aggregate status and diff", async () => {
    await writeFile(path.join(cwd, ".ENV"), "GIT_CANARY=before\n");
    await writeFile(path.join(cwd, "safe.txt"), "safe before\n");
    await execFileAsync("git", ["add", "--force", ".ENV", "safe.txt"], { cwd });
    await writeFile(path.join(cwd, ".ENV"), "GIT_CANARY=after\n");
    await writeFile(path.join(cwd, "safe.txt"), "safe after\n");

    const status = await invoke(createGitStatusTool(), {});
    const diff = await invoke(createGitDiffTool(), {});

    expect(status.output).toContain("safe.txt");
    expect(status.output).not.toContain(".ENV");
    expect(diff.output).toContain("safe after");
    expect(diff.output).not.toContain("GIT_CANARY");
    expect(diff.output).not.toContain(".ENV");
  });

  it("excludes credential directory names used as tracked Git nodes", async () => {
    await mkdir(path.join(cwd, "nested"));
    await mkdir(path.join(cwd, ".config"));
    await writeFile(path.join(cwd, ".ssh"), "SSH_NODE_CANARY=before\n");
    await writeFile(path.join(cwd, "nested", ".aws"), "AWS_NODE_CANARY=before\n");
    await writeFile(path.join(cwd, ".config", "gcloud"), "GCLOUD_NODE_CANARY=before\n");
    await writeFile(path.join(cwd, "safe.txt"), "safe before\n");
    await execFileAsync(
      "git",
      ["add", "--force", ".ssh", "nested/.aws", ".config/gcloud", "safe.txt"],
      { cwd },
    );
    await writeFile(path.join(cwd, ".ssh"), "SSH_NODE_CANARY=after\n");
    await writeFile(path.join(cwd, "nested", ".aws"), "AWS_NODE_CANARY=after\n");
    await writeFile(path.join(cwd, ".config", "gcloud"), "GCLOUD_NODE_CANARY=after\n");
    await writeFile(path.join(cwd, "safe.txt"), "safe after\n");

    const status = await invoke(createGitStatusTool(), {});
    const diff = await invoke(createGitDiffTool(), {});

    expect(status.output).toContain("safe.txt");
    expect(status.output).not.toMatch(/\.ssh|\.aws|gcloud/u);
    expect(diff.output).toContain("safe after");
    expect(diff.output).not.toMatch(/(?:SSH|AWS|GCLOUD)_NODE_CANARY/u);
    expect(diff.output).not.toMatch(/\.ssh|\.aws|gcloud/u);
  });

  it("denies explicit direct and canonical credential targets", async () => {
    await writeFile(path.join(cwd, ".env"), "TOKEN=secret\n");
    await execFileAsync("git", ["add", "--force", ".env"], { cwd });
    await symlink(".env", path.join(cwd, "innocent.txt"));

    await expect(
      invoke(createGitDiffTool(), { path: ".env" }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      invoke(createGitDiffTool(), { path: "innocent.txt" }),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });
});
