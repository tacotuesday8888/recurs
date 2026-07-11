import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileCheckpointStore,
  PermissionEngine,
  ToolRegistry,
  type ApprovalHandler,
  type Tool,
  type ToolContext,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
let root: string;
let cwd: string;
let dataDirectory: string;
let store: FileCheckpointStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "recurs-checkpoint-"));
  cwd = path.join(root, "project");
  dataDirectory = path.join(root, "data");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd));
  await execFileAsync("git", ["init", "--quiet"], { cwd });
  await writeFile(path.join(cwd, "a.txt"), "before a\n", "utf8");
  await writeFile(path.join(cwd, "b.txt"), "before b\n", "utf8");
  await execFileAsync("git", ["add", "a.txt", "b.txt"], { cwd });
  store = new FileCheckpointStore(dataDirectory);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

describe("FileCheckpointStore", () => {
  it("never reads or stores a tracked credential file", async () => {
    await writeFile(path.join(cwd, ".env"), "CHECKPOINT_CANARY=never-store\n");
    await execFileAsync("git", ["add", "--force", ".env"], { cwd });

    const checkpoint = await store.captureBefore("s1", "call-1", cwd);
    const storedFiles = await allStoredFileText(dataDirectory);

    expect(checkpoint.before).not.toHaveProperty(".env");
    expect(storedFiles).not.toContain("CHECKPOINT_CANARY");
  });

  it("never follows a tracked parent alias into a credential directory", async () => {
    const alias = path.join(cwd, "alias");
    await mkdir(alias);
    await writeFile(path.join(alias, "key"), "safe placeholder\n");
    await execFileAsync("git", ["add", "alias/key"], { cwd });
    await rm(alias, { recursive: true });
    await mkdir(path.join(cwd, ".ssh"));
    await writeFile(
      path.join(cwd, ".ssh", "key"),
      "CHECKPOINT_ALIAS_CANARY=never-store\n",
    );
    await symlink(".ssh", alias);

    const checkpoint = await store.captureBefore("s1", "call-1", cwd);
    const storedFiles = await allStoredFileText(dataDirectory);

    expect(checkpoint.before).not.toHaveProperty("alias/key");
    expect(storedFiles).not.toContain("CHECKPOINT_ALIAS_CANARY");
  });

  it("disables repository fsmonitor execution during capture", async () => {
    const marker = path.join(cwd, ".git", "fsmonitor-invoked");
    const hook = path.join(cwd, ".git", "fsmonitor-hook");
    await writeFile(
      hook,
      `#!/bin/sh\nprintf invoked > ${shellQuote(marker)}\nexit 0\n`,
    );
    await chmod(hook, 0o700);
    await execFileAsync("git", ["config", "core.fsmonitor", hook], { cwd });

    try {
      await store.captureBefore("s1", "call-1", cwd);
    } catch {
      // An invalid hook response still proves execution if the marker exists.
    }

    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a nonempty unversioned legacy store without mutating it", async () => {
    await mkdir(path.join(dataDirectory, "sessions", "s1"), { recursive: true });
    const legacy = path.join(dataDirectory, "sessions", "s1", "legacy.json");
    await writeFile(legacy, "LEGACY_CHECKPOINT_CANARY\n");

    await expect(store.initialize()).rejects.toMatchObject({
      code: "checkpoint_migration_required",
    });
    expect(await readFile(legacy, "utf8")).toBe("LEGACY_CHECKPOINT_CANARY\n");
  });

  it("rejects an orphan blob in an unversioned store", async () => {
    await mkdir(path.join(dataDirectory, "blobs"), { recursive: true });
    const orphan = path.join(dataDirectory, "blobs", "a".repeat(64));
    await writeFile(orphan, "ORPHAN_CHECKPOINT_CANARY\n");

    await expect(store.initialize()).rejects.toMatchObject({
      code: "checkpoint_migration_required",
    });
    expect(await readFile(orphan, "utf8")).toBe("ORPHAN_CHECKPOINT_CANARY\n");
  });

  it("converges concurrent initialization on one valid format marker", async () => {
    const first = new FileCheckpointStore(dataDirectory);
    const second = new FileCheckpointStore(dataDirectory);

    await Promise.all([first.initialize(), second.initialize()]);

    expect(await readdir(dataDirectory)).toEqual([".format.json"]);
    expect(JSON.parse(await readFile(path.join(dataDirectory, ".format.json"), "utf8")))
      .toEqual({ version: 2, credentialPathsExcluded: true });
    expect((await lstat(path.join(dataDirectory, ".format.json"))).mode & 0o777)
      .toBe(0o600);
  });

  it("rejects a symlinked format marker", async () => {
    const outsideMarker = path.join(root, "outside-format.json");
    await mkdir(dataDirectory);
    await writeFile(
      outsideMarker,
      `${JSON.stringify({ version: 2, credentialPathsExcluded: true })}\n`,
    );
    await symlink(outsideMarker, path.join(dataDirectory, ".format.json"));

    await expect(store.initialize()).rejects.toMatchObject({
      code: "checkpoint_migration_required",
    });
    expect(await readFile(outsideMarker, "utf8")).toContain('"version":2');
  });

  it("restores modified/deleted files and deletes files created by the agent", async () => {
    const checkpoint = await store.captureBefore("s1", "call-1", cwd);
    await writeFile(path.join(cwd, "a.txt"), "agent a\n", "utf8");
    await rm(path.join(cwd, "b.txt"));
    await writeFile(path.join(cwd, "new.txt"), "agent new\n", "utf8");
    await store.captureAfter(checkpoint, cwd);

    const undone = await store.undoLatest("s1", cwd);

    expect(undone.restored.sort()).toEqual(["a.txt", "b.txt"]);
    expect(undone.deleted).toEqual(["new.txt"]);
    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("before a\n");
    expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("before b\n");
    await expect(readFile(path.join(cwd, "new.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses the entire undo when the user changed an agent-produced file", async () => {
    const checkpoint = await store.captureBefore("s1", "call-1", cwd);
    await writeFile(path.join(cwd, "a.txt"), "agent a\n", "utf8");
    await writeFile(path.join(cwd, "b.txt"), "agent b\n", "utf8");
    await store.captureAfter(checkpoint, cwd);
    await writeFile(path.join(cwd, "a.txt"), "later user a\n", "utf8");

    await expect(store.undoLatest("s1", cwd)).rejects.toMatchObject({
      code: "checkpoint_conflict",
    });
    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("later user a\n");
    expect(await readFile(path.join(cwd, "b.txt"), "utf8")).toBe("agent b\n");
  });

  it("does not alter Git state while capturing checkpoints", async () => {
    const before = await execFileAsync("git", ["status", "--short"], { cwd });

    const checkpoint = await store.captureBefore("s1", "call-1", cwd);
    await store.captureAfter(checkpoint, cwd);

    const after = await execFileAsync("git", ["status", "--short"], { cwd });
    expect(after.stdout).toBe(before.stdout);
  });

  it("skips newer no-op checkpoints when selecting what to undo", async () => {
    const changed = await store.captureBefore("s1", "change", cwd);
    await writeFile(path.join(cwd, "a.txt"), "agent a\n", "utf8");
    await store.captureAfter(changed, cwd);
    const noOp = await store.captureBefore("s1", "verify", cwd);
    await store.captureAfter(noOp, cwd);

    await store.undoLatest("s1", cwd);

    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("before a\n");
  });

  it("rejects checkpoint storage inside the project", async () => {
    const unsafeStore = new FileCheckpointStore(path.join(cwd, ".recurs"));

    await expect(
      unsafeStore.captureBefore("s1", "call-1", cwd),
    ).rejects.toMatchObject({ code: "checkpoint_storage" });
  });

  it("refuses restore through a parent symlink created after capture", async () => {
    const nested = path.join(cwd, "nested");
    const outside = path.join(root, "outside");
    await mkdir(nested);
    await mkdir(outside);
    await writeFile(path.join(nested, "inside.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "nested/inside.txt"], { cwd });
    const checkpoint = await store.captureBefore("s1", "call-1", cwd);
    await rm(nested, { recursive: true });
    await store.captureAfter(checkpoint, cwd);
    await symlink(outside, nested);

    await expect(store.undoLatest("s1", cwd)).rejects.toMatchObject({
      code: "checkpoint_conflict",
    });
    await expect(
      readFile(path.join(outside, "inside.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("wraps mutating registry tools with a recoverable checkpoint", async () => {
    const tool: Tool = {
      definition: {
        name: "write_a",
        description: "write a",
        inputSchema: { type: "object", additionalProperties: false },
      },
      executionClass: "in_process",
      mutating: true,
      parse() {
        return {};
      },
      permissions() {
        return [{ category: "write", resource: "a.txt", risk: "normal" }];
      },
      async execute() {
        await writeFile(path.join(cwd, "a.txt"), "agent a\n", "utf8");
        return { output: "changed" };
      },
    };
    const context: ToolContext = {
      sessionId: "s1",
      cwd,
      signal: new AbortController().signal,
      executionMode: "act",
      readRevisions: new Map(),
    };
    const approvals: ApprovalHandler = {
      async request() {
        return "deny";
      },
    };
    const registry = new ToolRegistry([tool], { checkpoints: store });

    await registry.invoke(
      { id: "call-1", name: "write_a", arguments: {} },
      context,
      new PermissionEngine("full_access"),
      approvals,
    );
    await store.undoLatest("s1", cwd);

    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("before a\n");
  });

  it("captures the after-state when a mutating tool fails partway", async () => {
    const tool: Tool = {
      definition: {
        name: "partial_write",
        description: "write then fail",
        inputSchema: { type: "object", additionalProperties: false },
      },
      executionClass: "in_process",
      mutating: true,
      parse() {
        return {};
      },
      permissions() {
        return [{ category: "write", resource: "a.txt", risk: "normal" }];
      },
      async execute() {
        await writeFile(path.join(cwd, "a.txt"), "partial agent a\n", "utf8");
        throw new Error("tool failed");
      },
    };
    const context: ToolContext = {
      sessionId: "s1",
      cwd,
      signal: new AbortController().signal,
      executionMode: "act",
      readRevisions: new Map(),
    };
    const registry = new ToolRegistry([tool], { checkpoints: store });

    let thrown: unknown;
    try {
      await registry.invoke(
        { id: "call-1", name: "partial_write", arguments: {} },
        context,
        new PermissionEngine("full_access"),
        { async request() { return "deny"; } },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "execution_failed",
      message: "Tool partial_write failed",
    });
    expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    await store.undoLatest("s1", cwd);

    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("before a\n");
  });
});

async function allStoredFileText(directory: string): Promise<string> {
  let output = "";
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      output += await allStoredFileText(target);
    } else if (entry.isFile()) {
      output += await readFile(target, "utf8");
    }
  }
  return output;
}
