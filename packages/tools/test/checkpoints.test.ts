import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
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

describe("FileCheckpointStore", () => {
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

    await expect(
      registry.invoke(
        { id: "call-1", name: "partial_write", arguments: {} },
        context,
        new PermissionEngine("full_access"),
        { async request() { return "deny"; } },
      ),
    ).rejects.toThrow("tool failed");
    await store.undoLatest("s1", cwd);

    expect(await readFile(path.join(cwd, "a.txt"), "utf8")).toBe("before a\n");
  });
});
