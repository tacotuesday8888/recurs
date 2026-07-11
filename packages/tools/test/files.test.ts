import {
  mkdir,
  mkdtemp,
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
): Promise<ToolResult> {
  return new ToolRegistry([tool]).invoke(
    { id: "call-1", name: tool.definition.name, arguments: arguments_ },
    toolContext,
    new PermissionEngine(mode),
    deny,
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
    });
    expect(toolContext.readRevisions.get(absolute)).toBe(result.metadata?.sha256);
  });

  it("requires approval for an explicit external path and honors Full Access", async () => {
    const externalFile = path.join(outside, "secret.txt");

    await expect(
      invoke(
        createReadFileTool(),
        { path: externalFile },
        context(),
        "approved_for_me",
      ),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect(
      (await invoke(createReadFileTool(), { path: externalFile })).output,
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

  it("lists files and searches fixed text without a shell", async () => {
    await writeFile(path.join(cwd, "src", "shell.ts"), "const value = '$(touch nope)';\n", "utf8");

    const listed = await invoke(createListFilesTool(), { path: "src" });
    const searched = await invoke(createSearchTextTool(), {
      query: "$(touch nope)",
      path: "src",
    });

    expect(listed.output).toContain("src/a.ts");
    expect(listed.output).toContain("src/shell.ts");
    expect(searched.output).toContain("src/shell.ts:1:");
    await expect(
      import("node:fs/promises").then(({ access }) => access(path.join(cwd, "nope"))),
    ).rejects.toBeDefined();
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
