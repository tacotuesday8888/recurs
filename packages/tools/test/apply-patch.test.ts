import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PermissionEngine,
  ToolRegistry,
  createApplyPatchTool,
  createReadFileTool,
  type ApprovalHandler,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "../src/index.js";

let cwd: string;
let toolContext: ToolContext;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "recurs-patch-"));
  await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, "src", "a.ts"), "export const value = 1;\n", "utf8");
  toolContext = {
    sessionId: "s1",
    cwd,
    signal: new AbortController().signal,
    executionMode: "act",
    readRevisions: new Map(),
  };
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const deny: ApprovalHandler = {
  async request() {
    return "deny";
  },
};

async function invoke(tool: Tool, arguments_: unknown): Promise<ToolResult> {
  return new ToolRegistry([tool]).invoke(
    { id: "call-1", name: tool.definition.name, arguments: arguments_ },
    toolContext,
    new PermissionEngine("full_access"),
    deny,
  );
}

const updatePatch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-export const value = 1;",
  "+export const value = 2;",
  "",
].join("\n");

describe("apply_patch", () => {
  it("applies a declared patch after an exact current-turn read", async () => {
    const read = await invoke(createReadFileTool(), { path: "src/a.ts" });

    const result = await invoke(createApplyPatchTool(), {
      patch: updatePatch,
      files: [{ path: "src/a.ts", expected_hash: read.metadata?.sha256 }],
    });

    expect(await readFile(path.join(cwd, "src", "a.ts"), "utf8")).toContain(
      "value = 2",
    );
    expect(result.metadata).toMatchObject({ changedFiles: ["src/a.ts"] });
  });

  it("rejects an existing file that was not read this turn", async () => {
    const hash = (await invoke(createReadFileTool(), { path: "src/a.ts" })).metadata?.sha256;
    toolContext.readRevisions.clear();

    await expect(
      invoke(createApplyPatchTool(), {
        patch: updatePatch,
        files: [{ path: "src/a.ts", expected_hash: hash }],
      }),
    ).rejects.toMatchObject({ code: "unread_file" });
  });

  it("rejects a file changed after its current-turn read", async () => {
    const read = await invoke(createReadFileTool(), { path: "src/a.ts" });
    await writeFile(path.join(cwd, "src", "a.ts"), "user edit\n", "utf8");

    await expect(
      invoke(createApplyPatchTool(), {
        patch: updatePatch,
        files: [{ path: "src/a.ts", expected_hash: read.metadata?.sha256 }],
      }),
    ).rejects.toMatchObject({ code: "stale_file" });
  });

  it("creates a declared new file with a null expected hash", async () => {
    const patch = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+export const created = true;",
      "",
    ].join("\n");

    await invoke(createApplyPatchTool(), {
      patch,
      files: [{ path: "src/new.ts", expected_hash: null }],
    });

    expect(await readFile(path.join(cwd, "src", "new.ts"), "utf8")).toContain(
      "created = true",
    );
  });

  it("rejects files changed by the patch but omitted from the declaration", async () => {
    const read = await invoke(createReadFileTool(), { path: "src/a.ts" });

    await expect(
      invoke(createApplyPatchTool(), {
        patch: updatePatch,
        files: [],
      }),
    ).rejects.toMatchObject({ code: "patch_files_mismatch" });
    expect(read.metadata?.sha256).toBeDefined();
  });
});
