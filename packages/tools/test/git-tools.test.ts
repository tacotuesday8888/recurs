import { execFile } from "node:child_process";
import {
  access,
  chmod,
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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
