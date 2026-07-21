import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PermissionEngine,
  ToolRegistry,
  createApplyPatchTool,
  createListFilesTool,
  createReadFileTool,
  createSearchTextTool,
  isCredentialPath,
  type ApprovalHandler,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "../src/index.js";
import { readStableTextFile } from "../src/stable-text-file.js";

let cwd: string;
let outside: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "recurs-files-"));
  outside = await mkdtemp(path.join(tmpdir(), "recurs-outside-"));
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "src", "a.ts"), "alpha\nbeta\ngamma\n", "utf8");
  await writeFile(path.join(outside, "secret.txt"), "outside\n", "utf8");
});

afterEach(async () => {
  await Promise.all([
    rm(cwd, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]);
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
  toolContext = context(),
  mode: "ask_always" | "approved_for_me" | "full_access" = "full_access",
  approvals: ApprovalHandler = deny,
): Promise<ToolResult> {
  return new ToolRegistry([tool]).invoke(
    { id: "call-1", name: tool.definition.name, arguments: arguments_ },
    toolContext,
    new PermissionEngine(mode),
    approvals,
  );
}

function searchRecords(result: ToolResult): Array<{
  path: string;
  line: number;
  text: string;
}> {
  return result.output.trimEnd().split("\n").filter(Boolean).map((line) =>
    JSON.parse(line) as { path: string; line: number; text: string }
  );
}

function listRecords(result: ToolResult): Array<{ path: string }> {
  return result.output.trimEnd().split("\n").filter(Boolean).map((line) =>
    JSON.parse(line) as { path: string }
  );
}

describe("workspace file tools", () => {
  it.each([
    ".env",
    "config/.ENV.local",
    "id_rsa",
    "keys/ID_ED25519",
    "nested/credentials",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "certs/client.PEM",
    "certs/client.key",
    "certs/client.p12",
    ".ssh/config",
    "home\\.AWS\\credentials",
    ".azure/profile.json",
    ".docker/config.json",
    ".gnupg/pubring.kbx",
    ".kube/config",
    "home/.config/gcloud/application_default_credentials.json",
  ])("classifies %s as a credential path", (candidate) => {
    expect(isCredentialPath(candidate)).toBe(true);
  });

  it.each(["safe.env", "environment.ts", "keys/public.crt", "src/config.ts"])(
    "does not over-classify %s",
    (candidate) => {
      expect(isCredentialPath(candidate)).toBe(false);
    },
  );

  it("reads bounded line ranges and records the exact file revision", async () => {
    const toolContext = context();
    const result = await invoke(
      createReadFileTool(),
      { path: "src/a.ts", startLine: 2, endLine: 3 },
      toolContext,
    );
    const absolute = await realpath(path.join(cwd, "src", "a.ts"));

    expect(result.output).toBe("beta\ngamma\n");
    expect(result.metadata).toMatchObject({
      path: "src/a.ts",
      startLine: 2,
      endLine: 3,
      totalLines: 3,
      sources: [expect.stringMatching(/^read src\/a\.ts:2-3 \(sha256 [0-9a-f]{64}\)$/u)],
    });
    expect(toolContext.readRevisions.get(absolute)).toBe(result.metadata?.sha256);
  });

  it("requires explicit approval for an external path in every preset", async () => {
    const externalFile = path.join(outside, "secret.txt");

    await expect(
      invoke(
        createReadFileTool(),
        { path: externalFile },
        context(),
        "approved_for_me",
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    await expect(
      invoke(createReadFileTool(), { path: externalFile }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(
      (
        await invoke(
          createReadFileTool(),
          { path: externalFile },
          context(),
          "full_access",
          { async request() { return "allow_once"; } },
        )
      ).output,
    ).toBe("outside\n");
  });

  it("rejects a hidden symlink escape outside the workspace", async () => {
    await symlink(outside, path.join(cwd, "link"));

    await expect(
      invoke(createReadFileTool(), { path: "link/secret.txt" }),
    ).rejects.toMatchObject({ code: "external_path" });
  });

  it("routes sensitive files through elevated permission", async () => {
    await writeFile(path.join(cwd, ".env"), "TOKEN=secret\n", "utf8");

    await expect(
      invoke(createReadFileTool(), { path: ".env" }, context(), "approved_for_me"),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("denies a readable symlink alias whose canonical target is a credential", async () => {
    await writeFile(path.join(cwd, ".env"), "TOKEN=secret\n", "utf8");
    await symlink(".env", path.join(cwd, "innocent.txt"));

    await expect(
      invoke(createReadFileTool(), { path: "innocent.txt" }),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("denies creating a file beneath a symlinked credential directory", async () => {
    await mkdir(path.join(cwd, ".ssh"));
    await symlink(".ssh", path.join(cwd, "innocent-dir"));

    await expect(
      invoke(createApplyPatchTool(), {
        patch: [
          "--- /dev/null",
          "+++ b/innocent-dir/new-key",
          "@@ -0,0 +1 @@",
          "+secret",
          "",
        ].join("\n"),
        files: [{ path: "innocent-dir/new-key", expected_hash: null }],
      }),
    ).rejects.toMatchObject({ code: "permission_denied" });
  });

  it("caps read output at 256 KiB", async () => {
    await writeFile(path.join(cwd, "large.txt"), "x".repeat(256 * 1024 + 1), "utf8");

    await expect(
      invoke(createReadFileTool(), { path: "large.txt" }),
    ).rejects.toMatchObject({ code: "output_limit" });
  });

  it("rejects invalid UTF-8, NUL bytes, and oversized source files", async () => {
    const file = path.join(cwd, "invalid.txt");
    const toolContext = context();
    await writeFile(file, Buffer.from([0xc3, 0x28]));

    await expect(invoke(
      createReadFileTool(),
      { path: "invalid.txt" },
      toolContext,
    )).rejects.toMatchObject({ code: "invalid_input" });
    expect(toolContext.readRevisions.size).toBe(0);

    await writeFile(file, Buffer.from([0x61, 0, 0x62]));
    await expect(invoke(createReadFileTool(), { path: "invalid.txt" }))
      .rejects.toMatchObject({ code: "invalid_input" });

    const exactLimit = Buffer.alloc(8 * 1024 * 1024, 0x61);
    exactLimit[1] = 0x0a;
    await writeFile(file, exactLimit);
    await expect(invoke(createReadFileTool(), {
      path: "invalid.txt",
      startLine: 1,
      endLine: 1,
    })).resolves.toMatchObject({ output: "a\n" });

    await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
    await expect(invoke(createReadFileTool(), { path: "invalid.txt" }))
      .rejects.toMatchObject({ code: "output_limit" });
  });

  it("fails closed when a regular file changes during its read", async () => {
    const file = path.join(cwd, "changing.txt");
    await writeFile(file, "alpha\n");
    let changed = false;

    await expect(readStableTextFile(file, "changing.txt", 1024, {
      lstat(candidate) {
        return lstat(candidate, { bigint: true });
      },
      async open(candidate, flags) {
        const handle = await open(candidate, flags);
        return {
          stat() {
            return handle.stat({ bigint: true });
          },
          async read(buffer, offset, length, position) {
            if (!changed) {
              changed = true;
              await writeFile(file, "omega\n");
            }
            return handle.read(buffer, offset, length, position);
          },
          close() {
            return handle.close();
          },
        };
      },
    })).rejects.toMatchObject({ code: "stale_file" });
    expect(changed).toBe(true);
  });

  it("lists files and searches fixed text without a shell", async () => {
    await writeFile(path.join(cwd, "src", "shell.ts"), "const value = '$(touch nope)';\n", "utf8");

    const listed = await invoke(createListFilesTool(), { path: "src" });
    const searched = await invoke(createSearchTextTool(), {
      query: "$(touch nope)",
      path: "src",
    });

    expect(listed.output).toContain("src/a.ts");
    expect(listed.output).toContain("src/shell.ts");
    expect(searchRecords(searched)).toEqual([{
      path: "src/shell.ts",
      line: 1,
      text: "const value = '$(touch nope)';",
    }]);
    expect(listed.metadata?.sources).toEqual([
      "listed src (2 of 2 files)",
    ]);
    expect(searched.metadata?.sources).toEqual([
      "searched src (1 of 1 matching lines)",
    ]);
    await expect(
      import("node:fs/promises").then(({ access }) => access(path.join(cwd, "nope"))),
    ).rejects.toBeDefined();
  });

  it("keeps fixed search as the default and makes regex search explicit", async () => {
    await writeFile(
      path.join(cwd, "src", "patterns.txt"),
      String.raw`alpha42
alpha\d+
alpha7
`,
      "utf8",
    );

    const fixed = await invoke(createSearchTextTool(), {
      query: String.raw`alpha\d+`,
      path: "src/patterns.txt",
    });
    const regex = await invoke(createSearchTextTool(), {
      query: String.raw`alpha\d+`,
      path: "src/patterns.txt",
      mode: "regex",
    });

    expect(searchRecords(fixed).map(({ line }) => line)).toEqual([2]);
    expect(fixed.metadata).toMatchObject({ mode: "fixed", truncated: false });
    expect(searchRecords(regex).map(({ line }) => line)).toEqual([1, 3]);
    expect(regex.metadata).toMatchObject({
      mode: "regex",
      matches: 2,
      matchedLines: 2,
      occurrences: 2,
      truncated: false,
    });
  });

  it("returns escaped structured matches under an explicit result limit", async () => {
    await writeFile(
      path.join(cwd, "src", "many.txt"),
      "MATCH one\u001b\nMATCH two\nMATCH three\nMATCH four\n",
      "utf8",
    );

    const result = await invoke(createSearchTextTool(), {
      query: "MATCH",
      path: "src/many.txt",
      limit: 2,
    });

    expect(result.output).not.toContain("\u001b");
    expect(searchRecords(result)).toEqual([
      { path: "src/many.txt", line: 1, text: "MATCH one\u001b" },
      { path: "src/many.txt", line: 2, text: "MATCH two" },
    ]);
    expect(result.metadata).toMatchObject({
      mode: "fixed",
      matches: 2,
      matchedLines: 3,
      occurrences: 3,
      omitted: 0,
      truncated: true,
    });
  });

  it("strictly validates bounded search inputs and invalid regexes", async () => {
    const invalidInputs: unknown[] = [
      [],
      { query: "alpha", extra: true },
      { query: "alpha", mode: "wildcard" },
      { query: "alpha", limit: 0 },
      { query: "alpha", limit: 1_001 },
      { query: "" },
      { query: "alpha\0beta" },
      { query: "x".repeat(16 * 1024 + 1) },
      { query: "alpha", glob: "" },
      { query: "alpha", glob: "x".repeat(1_025) },
    ];
    for (const invalid of invalidInputs) {
      await expect(invoke(createSearchTextTool(), invalid)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    await expect(invoke(createSearchTextTool(), {
      query: "(",
      mode: "regex",
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("lists a bounded glob without invoking a shell", async () => {
    await writeFile(path.join(cwd, "src", "a.js"), "javascript\n", "utf8");
    const globbed = await invoke(createListFilesTool(), {
      path: ".",
      glob: "**/*.ts",
      limit: 10,
    });
    const hostile = await invoke(createListFilesTool(), {
      path: ".",
      glob: "$(touch glob-pwned)",
    });

    expect(listRecords(globbed)).toEqual([{ path: "src/a.ts" }]);
    expect(globbed.metadata).toMatchObject({ count: 1, total: 1, truncated: false });
    expect(globbed.metadata?.sources).toEqual([
      'listed . matching "**/*.ts" (1 of 1 files)',
    ]);
    expect(hostile.output).toBe("");
    await expect(
      import("node:fs/promises").then(({ access }) => access(path.join(cwd, "glob-pwned"))),
    ).rejects.toBeDefined();
  });

  it("bounds list globs and keeps credential exclusions deny-last", async () => {
    await writeFile(path.join(cwd, ".env"), "SECRET\n", "utf8");
    await writeFile(path.join(cwd, "safe.env"), "SAFE\n", "utf8");

    const listed = await invoke(createListFilesTool(), {
      path: ".",
      glob: "*.env",
    });
    expect(listRecords(listed)).toEqual([{ path: "safe.env" }]);

    for (const glob of ["", 42, "x\0y", "x".repeat(1_025)]) {
      await expect(invoke(createListFilesTool(), {
        path: ".",
        glob,
      })).rejects.toMatchObject({ code: "invalid_input" });
    }
    for (const invalid of [[], { path: ".", unknown: true }]) {
      await expect(invoke(createListFilesTool(), invalid)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
  });

  it("lists adversarial paths as deterministic escaped records", async () => {
    if (path.sep !== "/") return;
    const writes = [
      writeFile(path.join(cwd, "src", "B.ts"), "B\n"),
      writeFile(path.join(cwd, "src", "line\nbreak.ts"), "newline\n"),
      writeFile(path.join(cwd, "src", "ä.ts"), "unicode\n"),
      writeFile(path.join(cwd, "src", "\uFEFFbom.ts"), "bom\n"),
    ];
    if (process.platform === "linux") {
      writes.push(writeFile(
        Buffer.concat([
          Buffer.from(path.join(cwd, "src", "invalid-")),
          Buffer.from([0xff]),
          Buffer.from(".ts"),
        ]),
        "invalid utf8 path\n",
      ));
    }
    await Promise.all(writes);

    const listed = await invoke(createListFilesTool(), {
      path: "src",
      glob: "*.ts",
      limit: 10,
    });
    expect(listed.output).not.toContain("line\nbreak.ts");
    expect(listRecords(listed)).toEqual([
      { path: "src/B.ts" },
      { path: "src/a.ts" },
      { path: "src/line\nbreak.ts" },
      { path: "src/ä.ts" },
      { path: "src/\uFEFFbom.ts" },
    ]);
    expect(listed.metadata).toMatchObject({
      count: 5,
      total: 5,
      omitted: process.platform === "linux" ? 1 : 0,
      truncated: process.platform === "linux",
    });

    const limited = await invoke(createListFilesTool(), {
      path: "src",
      glob: "*.ts",
      limit: 2,
    });
    expect(listRecords(limited)).toEqual([
      { path: "src/B.ts" },
      { path: "src/a.ts" },
    ]);
    expect(limited.metadata).toMatchObject({
      count: 2,
      total: 5,
      omitted: process.platform === "linux" ? 1 : 0,
      truncated: true,
    });
  });

  it("excludes credential descendants from listing and search", async () => {
    await writeFile(path.join(cwd, "src", "credentials"), "AGGREGATE_CANARY\n");
    await writeFile(path.join(cwd, "src", "safe.txt"), "AGGREGATE_CANARY\n");

    const listed = await invoke(createListFilesTool(), { path: "." });
    const searched = await invoke(createSearchTextTool(), {
      query: "AGGREGATE_CANARY",
      path: ".",
    });

    expect(listed.output).toContain("src/safe.txt");
    expect(listed.output).not.toContain("src/credentials");
    expect(searched.output).toContain("src/safe.txt");
    expect(searched.output).not.toContain("src/credentials");
  });

  it("excludes POSIX names containing credential-like backslash segments", async () => {
    if (path.sep !== "/") {
      return;
    }
    const names = [String.raw`nested\.env`, String.raw`nested\\.env`];
    for (const [index, name] of names.entries()) {
      expect(isCredentialPath(name)).toBe(true);
      await writeFile(
        path.join(cwd, name),
        `BACKSLASH_AGGREGATE_CANARY_${index}\n`,
      );
    }

    const listed = await invoke(createListFilesTool(), { path: "." });
    const searched = await invoke(createSearchTextTool(), {
      query: "BACKSLASH_AGGREGATE_CANARY",
      path: ".",
    });

    for (const name of names) {
      expect(listed.output).not.toContain(name);
      expect(searched.output).not.toContain(name);
    }
    expect(searched.output).not.toContain("BACKSLASH_AGGREGATE_CANARY");
  });

  it("keeps deny-last credential exclusions after a model include glob", async () => {
    await writeFile(path.join(cwd, ".env"), "REINCLUDE_CANARY\n");
    await writeFile(path.join(cwd, "safe.env"), "REINCLUDE_CANARY\n");

    const searched = await invoke(createSearchTextTool(), {
      query: "REINCLUDE_CANARY",
      path: ".",
      glob: ".env",
    });

    expect(searched.output).not.toContain("REINCLUDE_CANARY");
  });
});
