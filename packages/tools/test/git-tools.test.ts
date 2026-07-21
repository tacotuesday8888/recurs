import { execFile } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PermissionEngine,
  ToolRegistry,
  createApplyPatchTool,
  createGitDiffTool,
  createGitHistoryTool,
  createGitShowTool,
  createGitStatusTool,
  createReadFileTool,
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

function context(executionMode: "act" | "plan" = "act"): ToolContext {
  return {
    sessionId: "s1",
    cwd,
    signal: new AbortController().signal,
    executionMode,
    readRevisions: new Map(),
  };
}

async function invoke(
  tool: Tool,
  arguments_: unknown,
  toolContext = context(),
): Promise<ToolResult> {
  return new ToolRegistry([tool]).invoke(
    { id: "call-1", name: tool.definition.name, arguments: arguments_ },
    toolContext,
    new PermissionEngine("full_access"),
    deny,
  );
}

async function commitFixture(
  file: string,
  content: string,
  subject: string,
  authoredAt: string,
): Promise<string> {
  await writeFile(path.join(cwd, file), content);
  await execFileAsync("git", ["add", "--force", "--", file], { cwd });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Recurs Historian",
      "-c",
      "user.email=history@example.invalid",
      "commit",
      "--quiet",
      "-m",
      subject,
    ],
    {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: authoredAt,
        GIT_COMMITTER_DATE: authoredAt,
      },
    },
  );
  const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  return result.stdout.trim();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

describe("credential-safe Git inspection", () => {
  it("returns bounded newest-first JSON history in Plan mode", async () => {
    await commitFixture(
      "safe.txt",
      "first\n",
      "first change",
      "2026-01-01T00:00:00Z",
    );
    await commitFixture(
      "safe.txt",
      "second\n",
      "second change",
      "2026-01-02T00:00:00Z",
    );
    await commitFixture(
      "safe.txt",
      "third\n",
      "third change",
      "2026-01-03T00:00:00Z",
    );

    const result = await invoke(
      createGitHistoryTool(),
      { limit: 2 },
      context("plan"),
    );
    const entries = result.output.trim().split("\n").map((line) =>
      JSON.parse(line) as Record<string, string>
    );

    expect(entries.map((entry) => entry.subject)).toEqual([
      "third change",
      "second change",
    ]);
    expect(entries[0]).toMatchObject({
      commit: expect.stringMatching(/^[0-9a-f]{40}$/u),
      authoredAt: "2026-01-03T00:00:00Z",
      author: "Recurs Historian",
    });
    expect(result.metadata).toEqual({
      path: ".",
      returnedCommits: 2,
      requestedLimit: 2,
      truncated: true,
      exitCode: 0,
      sources: ["inspected 2 recent commits for \".\""],
    });
  });

  it("filters history by path and excludes credential-only commits", async () => {
    await commitFixture(
      "safe.txt",
      "first\n",
      "safe first",
      "2026-01-01T00:00:00Z",
    );
    await commitFixture(
      ".env",
      "SECRET_HISTORY_CANARY=1\n",
      "SECRET_SUBJECT_CANARY",
      "2026-01-02T00:00:00Z",
    );
    await commitFixture(
      "safe.txt",
      "second\n",
      "safe second",
      "2026-01-03T00:00:00Z",
    );

    const aggregate = await invoke(createGitHistoryTool(), { limit: 10 });
    const filtered = await invoke(createGitHistoryTool(), {
      path: "safe.txt",
      limit: 10,
    });
    const pathspec = await invoke(createGitHistoryTool(), {
      path: ":(glob)**",
      limit: 10,
    });

    for (const result of [aggregate, filtered]) {
      expect(result.output).toContain("safe first");
      expect(result.output).toContain("safe second");
      expect(result.output).not.toContain("SECRET_SUBJECT_CANARY");
      expect(result.output).not.toContain("SECRET_HISTORY_CANARY");
    }
    expect(filtered.metadata).toMatchObject({
      path: "safe.txt",
      returnedCommits: 2,
      truncated: false,
    });
    expect(pathspec.output).toBe("No commits found for path \":(glob)**\".\n");
    await expect(invoke(createGitHistoryTool(), { path: ".env" }))
      .rejects.toMatchObject({ code: "permission_denied" });
  });

  it("does not execute configured signature programs while reading history", async () => {
    await commitFixture(
      "safe.txt",
      "safe\n",
      "signed-looking history",
      "2026-01-01T00:00:00Z",
    );
    const marker = path.join(cwd, ".git", "signature-program-invoked");
    const program = path.join(cwd, ".git", "signature-program");
    await writeFile(
      program,
      `#!/bin/sh\nprintf invoked > ${shellQuote(marker)}\nexit 1\n`,
    );
    await chmod(program, 0o700);
    await execFileAsync("git", ["config", "log.showSignature", "true"], { cwd });
    await execFileAsync("git", ["config", "gpg.program", program], { cwd });

    const result = await invoke(createGitHistoryTool(), {});

    expect(result.output).toContain("signed-looking history");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("handles empty history and rejects malformed inputs", async () => {
    await expect(invoke(createGitHistoryTool(), {})).resolves.toMatchObject({
      output: "No commits found for path \".\".\n",
      metadata: {
        path: ".",
        returnedCommits: 0,
        requestedLimit: 20,
        truncated: false,
      },
    });
    await expect(invoke(createGitHistoryTool(), { limit: 0 }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(invoke(createGitHistoryTool(), { limit: 101 }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(invoke(createGitHistoryTool(), { revision: "HEAD~1" }))
      .rejects.toMatchObject({ code: "invalid_input" });
  });

  it("shows one exact reachable commit patch in Plan mode", async () => {
    const commit = await commitFixture(
      "safe.txt",
      "first line\n",
      "add safe file",
      "2026-01-01T00:00:00Z",
    );

    const result = await invoke(
      createGitShowTool(),
      { commit },
      context("plan"),
    );
    const [header = "", ...patch] = result.output.split("\n");

    expect(JSON.parse(header)).toEqual({
      commit,
      authoredAt: "2026-01-01T00:00:00Z",
      author: "Recurs Historian",
      subject: "add safe file",
    });
    expect(patch.join("\n")).toContain("+first line");
    expect(result.metadata).toMatchObject({
      commit,
      path: ".",
      patchBytes: expect.any(Number),
      exitCode: 0,
    });
  });

  it("excludes credential patches and treats paths as literals", async () => {
    const safeCommit = await commitFixture(
      "safe.txt",
      "safe\n",
      "safe commit",
      "2026-01-01T00:00:00Z",
    );
    const credentialCommit = await commitFixture(
      ".env",
      "GIT_SHOW_SECRET_CANARY=1\n",
      "credential-only commit",
      "2026-01-02T00:00:00Z",
    );

    const credential = await invoke(createGitShowTool(), {
      commit: credentialCommit,
    });
    const pathspec = await invoke(createGitShowTool(), {
      commit: safeCommit,
      path: ":(glob)**",
    });

    expect(credential.output).toBe(
      `No accessible changes found for commit ${credentialCommit}.\n`,
    );
    expect(credential.output).not.toContain("GIT_SHOW_SECRET_CANARY");
    expect(pathspec.output).toBe(
      `No accessible changes found for commit ${safeCommit}.\n`,
    );
    await expect(invoke(createGitShowTool(), {
      commit: credentialCommit,
      path: ".env",
    })).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("requires a full commit reachable from the current HEAD", async () => {
    const commit = await commitFixture(
      "safe.txt",
      "safe\n",
      "reachable commit",
      "2026-01-01T00:00:00Z",
    );
    const tree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd,
    })).stdout.trim();
    const orphan = (await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Recurs Historian",
        "-c",
        "user.email=history@example.invalid",
        "commit-tree",
        tree,
        "-m",
        "unreachable commit",
      ],
      { cwd },
    )).stdout.trim();

    await expect(invoke(createGitShowTool(), { commit: commit.slice(0, 12) }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(invoke(createGitShowTool(), { commit: "HEAD~1" }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(invoke(createGitShowTool(), { commit: "0".repeat(40) }))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(invoke(createGitShowTool(), { commit: orphan }))
      .rejects.toMatchObject({ code: "permission_denied" });
  });

  it("ignores replacement objects and configured signature programs", async () => {
    const commit = await commitFixture(
      "safe.txt",
      "original\n",
      "original commit",
      "2026-01-01T00:00:00Z",
    );
    const tree = (await execFileAsync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd,
    })).stdout.trim();
    const replacement = (await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Recurs Historian",
        "-c",
        "user.email=history@example.invalid",
        "commit-tree",
        tree,
        "-m",
        "replacement commit",
      ],
      { cwd },
    )).stdout.trim();
    await execFileAsync("git", ["replace", commit, replacement], { cwd });
    const marker = path.join(cwd, ".git", "show-signature-invoked");
    const program = path.join(cwd, ".git", "show-signature-program");
    await writeFile(
      program,
      `#!/bin/sh\nprintf invoked > ${shellQuote(marker)}\nexit 1\n`,
    );
    await chmod(program, 0o700);
    await execFileAsync("git", ["config", "log.showSignature", "true"], { cwd });
    await execFileAsync("git", ["config", "gpg.program", program], { cwd });

    const result = await invoke(createGitShowTool(), { commit });

    expect(result.output).toContain("original commit");
    expect(result.output).not.toContain("replacement commit");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

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
    expect(status.metadata?.sources).toEqual(["inspected git status"]);
    expect(diff.metadata?.sources).toEqual([
      "inspected working-tree git diff for .",
    ]);
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

  it("excludes POSIX names containing credential-like backslash segments", async () => {
    if (path.sep !== "/") {
      return;
    }
    const names = [String.raw`nested\.env`, String.raw`nested\\.env`];
    for (const name of names) {
      await writeFile(path.join(cwd, name), "BACKSLASH_GIT_CANARY=before\n");
    }
    await execFileAsync("git", ["add", "--force", ...names], { cwd });
    for (const name of names) {
      await writeFile(path.join(cwd, name), "BACKSLASH_GIT_CANARY=after\n");
    }

    const status = await invoke(createGitStatusTool(), {});
    const diff = await invoke(createGitDiffTool(), {});

    expect(status.output).not.toContain("BACKSLASH_GIT_CANARY");
    expect(diff.output).not.toContain("BACKSLASH_GIT_CANARY");
    for (const name of names) {
      expect(status.output).not.toContain(name);
      expect(diff.output).not.toContain(name);
    }
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

  it.each([false, true])(
    "disables repository fsmonitor execution for staged=%s diffs",
    async (staged) => {
      await writeFile(path.join(cwd, "safe.txt"), "before\n");
      await execFileAsync("git", ["add", "safe.txt"], { cwd });
      await writeFile(path.join(cwd, "safe.txt"), "after\n");
      if (staged) {
        await execFileAsync("git", ["add", "safe.txt"], { cwd });
      }
      const marker = path.join(cwd, ".git", "fsmonitor-invoked");
      const hook = path.join(cwd, ".git", "fsmonitor-hook");
      await writeFile(
        hook,
        `#!/bin/sh\nprintf invoked > ${shellQuote(marker)}\nexit 0\n`,
      );
      await chmod(hook, 0o700);
      await execFileAsync("git", ["config", "core.fsmonitor", hook], { cwd });

      try {
        await invoke(createGitDiffTool(), { staged });
      } catch {
        // An invalid hook response still proves execution if the marker exists.
      }

      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("does not execute post-index hooks while inspecting status", async () => {
    await writeFile(path.join(cwd, "safe.txt"), "before\n");
    await execFileAsync("git", ["add", "safe.txt"], { cwd });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Recurs Test",
        "-c",
        "user.email=recurs@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      { cwd },
    );
    const marker = path.join(cwd, ".git", "post-index-invoked");
    const hook = path.join(cwd, ".git", "hooks", "post-index-change");
    await writeFile(
      hook,
      `#!/bin/sh\nprintf invoked > ${shellQuote(marker)}\nexit 0\n`,
    );
    await chmod(hook, 0o700);
    const future = new Date(Date.now() + 5_000);
    await utimes(path.join(cwd, "safe.txt"), future, future);

    await invoke(createGitStatusTool(), {});

    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pins fixed Git inspection to the requested workspace", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "recurs-core-worktree-"));
    try {
      await writeFile(path.join(cwd, "safe.txt"), "safe baseline\n");
      await execFileAsync("git", ["add", "safe.txt"], { cwd });
      await writeFile(
        path.join(outside, "safe.txt"),
        "RECURS_CORE_WORKTREE_CANARY\n",
      );
      await writeFile(path.join(outside, "outside-only.txt"), "outside\n");
      await execFileAsync("git", ["config", "core.worktree", outside], {
        cwd,
      });

      const diff = await invoke(createGitDiffTool(), {});
      const status = await invoke(createGitStatusTool(), {});

      expect(diff.output).not.toContain("RECURS_CORE_WORKTREE_CANARY");
      expect(status.output).not.toContain("outside-only.txt");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("disables lazy object fetching during fixed Git inspection", async () => {
    await writeFile(path.join(cwd, "safe.txt"), "baseline\n");
    await execFileAsync("git", ["add", "safe.txt"], { cwd });
    const blob = (await execFileAsync("git", ["rev-parse", ":safe.txt"], {
      cwd,
    })).stdout.trim();
    await rm(path.join(cwd, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    const marker = path.join(cwd, ".git", "lazy-fetch-invoked");
    const helper = path.join(cwd, ".git", "lazy-fetch-helper");
    await writeFile(
      helper,
      `#!/bin/sh\nprintf invoked > ${shellQuote(marker)}\nexit 1\n`,
    );
    await chmod(helper, 0o700);
    await execFileAsync(
      "git",
      ["config", "core.repositoryformatversion", "1"],
      { cwd },
    );
    await execFileAsync("git", ["config", "extensions.partialClone", "origin"], {
      cwd,
    });
    await execFileAsync("git", ["config", "remote.origin.promisor", "true"], {
      cwd,
    });
    await execFileAsync("git", ["config", "remote.origin.url", `ext::${helper}`], {
      cwd,
    });
    await execFileAsync("git", ["config", "protocol.ext.allow", "always"], {
      cwd,
    });
    await writeFile(path.join(cwd, "safe.txt"), "changed\n");

    await expect(invoke(createGitDiffTool(), {})).rejects.toMatchObject({
      code: "process_failed",
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["clean", "process"] as const)(
    "neutralizes configured %s filters while forming a worktree diff",
    async (kind) => {
      await writeFile(path.join(cwd, ".gitattributes"), "*.txt filter=evil\n");
      await writeFile(path.join(cwd, "safe.txt"), "before\n");
      await execFileAsync("git", ["add", ".gitattributes", "safe.txt"], {
        cwd,
      });
      const marker = path.join(cwd, ".git", `${kind}-filter-invoked`);
      const filter = path.join(cwd, ".git", `${kind}-filter`);
      await writeFile(
        filter,
        [
          "#!/bin/sh",
          `printf invoked > ${shellQuote(marker)}`,
          kind === "clean" ? "/bin/cat" : "exit 1",
          "",
        ].join("\n"),
      );
      await chmod(filter, 0o700);
      await execFileAsync("git", ["config", `filter.evil.${kind}`, filter], {
        cwd,
      });
      await execFileAsync(
        "git",
        ["config", "filter.evil.required", "true"],
        { cwd },
      );
      await writeFile(path.join(cwd, "safe.txt"), "after\n");

      const diff = await invoke(createGitDiffTool(), {});

      expect(diff.output).toContain("after");
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("neutralizes configured clean filters while inspecting status", async () => {
    await writeFile(path.join(cwd, ".gitattributes"), "*.txt filter=evil\n");
    await writeFile(path.join(cwd, "safe.txt"), "before\n");
    await execFileAsync("git", ["add", ".gitattributes", "safe.txt"], { cwd });
    const marker = path.join(cwd, ".git", "status-filter-invoked");
    const filter = path.join(cwd, ".git", "status-filter");
    await writeFile(
      filter,
      [
        "#!/bin/sh",
        `printf invoked > ${shellQuote(marker)}`,
        "/bin/cat",
        "",
      ].join("\n"),
    );
    await chmod(filter, 0o700);
    await execFileAsync("git", ["config", "filter.evil.clean", filter], { cwd });
    await execFileAsync("git", ["config", "filter.evil.required", "true"], {
      cwd,
    });
    await writeFile(path.join(cwd, "safe.txt"), "after!\n");

    const status = await invoke(createGitStatusTool(), {});

    expect(status.output).toContain("safe.txt");
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["clean", "smudge", "process"] as const)(
    "neutralizes configured %s filters while checking and applying patches",
    async (kind) => {
      await writeFile(path.join(cwd, ".gitattributes"), "*.txt filter=evil\n");
      await writeFile(path.join(cwd, "safe.txt"), "before\n");
      await execFileAsync("git", ["add", ".gitattributes", "safe.txt"], {
        cwd,
      });
      const marker = path.join(cwd, ".git", `${kind}-apply-filter-invoked`);
      const filter = path.join(cwd, ".git", `${kind}-apply-filter`);
      await writeFile(
        filter,
        [
          "#!/bin/sh",
          `printf invoked > ${shellQuote(marker)}`,
          kind === "process" ? "exit 1" : "/bin/cat",
          "",
        ].join("\n"),
      );
      await chmod(filter, 0o700);
      await execFileAsync("git", ["config", `filter.evil.${kind}`, filter], {
        cwd,
      });
      await execFileAsync(
        "git",
        ["config", "filter.evil.required", "true"],
        { cwd },
      );
      const toolContext = context();
      const registry = new ToolRegistry([
        createReadFileTool(),
        createApplyPatchTool(),
      ]);
      const permissions = new PermissionEngine("full_access");
      const read = await registry.invoke(
        { id: "read", name: "read_file", arguments: { path: "safe.txt" } },
        toolContext,
        permissions,
        deny,
      );
      const expectedHash = read.metadata?.sha256;
      expect(expectedHash).toEqual(expect.any(String));
      if (typeof expectedHash !== "string") {
        throw new TypeError("read_file did not return a revision hash");
      }

      await registry.invoke(
        {
          id: "patch",
          name: "apply_patch",
          arguments: {
            patch: [
              "--- a/safe.txt",
              "+++ b/safe.txt",
              "@@ -1 +1 @@",
              "-before",
              "+after",
              "",
            ].join("\n"),
            files: [{ path: "safe.txt", expected_hash: expectedHash }],
          },
        },
        toolContext,
        permissions,
        deny,
      );

      expect(await readFile(path.join(cwd, "safe.txt"), "utf8")).toBe(
        "after\n",
      );
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects markerless credential renames hidden beside a declared hunk", async () => {
    await writeFile(path.join(cwd, "safe.txt"), "before\n");
    await writeFile(path.join(cwd, ".env"), "TRACKED_CREDENTIAL_CANARY\n");
    await execFileAsync("git", ["add", "--force", "safe.txt", ".env"], {
      cwd,
    });
    const toolContext = context();
    const registry = new ToolRegistry([
      createReadFileTool(),
      createApplyPatchTool(),
    ]);
    const permissions = new PermissionEngine("full_access");
    const read = await registry.invoke(
      { id: "read", name: "read_file", arguments: { path: "safe.txt" } },
      toolContext,
      permissions,
      deny,
    );
    const expectedHash = read.metadata?.sha256;
    if (typeof expectedHash !== "string") {
      throw new TypeError("read_file did not return a revision hash");
    }
    const patch = [
      "--- a/safe.txt",
      "+++ b/safe.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "diff --git a/.env b/leaked.txt",
      "similarity index 100%",
      "rename from .env",
      "rename to leaked.txt",
      "",
    ].join("\n");

    await expect(
      registry.invoke(
        {
          id: "patch",
          name: "apply_patch",
          arguments: {
            patch,
            files: [{ path: "safe.txt", expected_hash: expectedHash }],
          },
        },
        toolContext,
        permissions,
        deny,
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(await readFile(path.join(cwd, ".env"), "utf8")).toBe(
      "TRACKED_CREDENTIAL_CANARY\n",
    );
    await expect(access(path.join(cwd, "leaked.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects markerless credential mode changes omitted from declarations", async () => {
    await writeFile(path.join(cwd, "safe.txt"), "before\n");
    await writeFile(path.join(cwd, ".env"), "TRACKED_MODE_CANARY\n");
    await chmod(path.join(cwd, ".env"), 0o600);
    await execFileAsync("git", ["add", "--force", "safe.txt", ".env"], {
      cwd,
    });
    const toolContext = context();
    const registry = new ToolRegistry([
      createReadFileTool(),
      createApplyPatchTool(),
    ]);
    const permissions = new PermissionEngine("full_access");
    const read = await registry.invoke(
      { id: "read", name: "read_file", arguments: { path: "safe.txt" } },
      toolContext,
      permissions,
      deny,
    );
    const expectedHash = read.metadata?.sha256;
    if (typeof expectedHash !== "string") {
      throw new TypeError("read_file did not return a revision hash");
    }
    const patch = [
      "--- a/safe.txt",
      "+++ b/safe.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "diff --git a/.env b/.env",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");

    await expect(
      registry.invoke(
        {
          id: "patch",
          name: "apply_patch",
          arguments: {
            patch,
            files: [{ path: "safe.txt", expected_hash: expectedHash }],
          },
        },
        toolContext,
        permissions,
        deny,
      ),
    ).rejects.toMatchObject({ code: "patch_files_mismatch" });
    expect((await lstat(path.join(cwd, ".env"))).mode & 0o111).toBe(0);
  });

  it("does not expand configured submodule diffs into credential content", async () => {
    const source = await mkdtemp(path.join(tmpdir(), "recurs-git-submodule-"));
    try {
      await execFileAsync("git", ["init", "--quiet"], { cwd: source });
      await writeFile(path.join(source, ".env"), "SUBMODULE_CANARY=before\n");
      await execFileAsync("git", ["add", "--force", ".env"], { cwd: source });
      await execFileAsync(
        "git",
        [
          "-c",
          "user.name=Recurs Test",
          "-c",
          "user.email=recurs@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "fixture",
        ],
        { cwd: source },
      );
      await execFileAsync(
        "git",
        [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          "--quiet",
          source,
          "vendor",
        ],
        { cwd },
      );
      await execFileAsync("git", ["config", "diff.submodule", "diff"], { cwd });
      const marker = path.join(source, "submodule-fsmonitor-invoked");
      const hook = path.join(source, "submodule-fsmonitor-hook");
      await writeFile(
        hook,
        `#!/bin/sh\nprintf invoked > ${shellQuote(marker)}\nexit 0\n`,
      );
      await chmod(hook, 0o700);
      await execFileAsync("git", ["config", "core.fsmonitor", hook], {
        cwd: path.join(cwd, "vendor"),
      });
      await writeFile(
        path.join(cwd, "vendor", ".env"),
        "SUBMODULE_CANARY=after\n",
      );

      const diff = await invoke(createGitDiffTool(), {});
      await invoke(createGitStatusTool(), {});

      expect(diff.output).not.toContain("SUBMODULE_CANARY");
      expect(diff.output).not.toContain(".env");
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });
});
