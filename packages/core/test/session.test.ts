import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JsonlSessionStore,
  SessionStoreError,
  activeGoal,
} from "../src/index.js";

const createdAt = "2026-07-10T00:00:00.000Z";
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-core-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonlSessionStore", () => {
  it("appends newline-terminated records and restores session state", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonlSessionStore(directory);

    await store.append("s1", {
      version: 1,
      type: "session_created",
      sessionId: "s1",
      at: createdAt,
      cwd: "/workspace",
      model: "scripted",
    });
    await store.append("s1", {
      version: 1,
      type: "goal_updated",
      sessionId: "s1",
      at: createdAt,
      goal: activeGoal("Ship auth", createdAt),
    });

    const serialized = await readFile(path.join(directory, "s1.jsonl"), "utf8");
    expect(serialized.endsWith("\n")).toBe(true);
    expect((await store.loadState("s1")).goal?.objective).toBe("Ship auth");
  });

  it("recovers valid records and quarantines a partial trailing record", async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, "s1.jsonl");
    const valid = {
      version: 1,
      type: "session_created",
      sessionId: "s1",
      at: createdAt,
      cwd: "/workspace",
      model: "scripted",
    } as const;
    await writeFile(file, `${JSON.stringify(valid)}\n{"broken"`, "utf8");

    const loaded = await new JsonlSessionStore(directory).load("s1");

    expect(loaded.records).toEqual([valid]);
    expect(loaded.recoveredPartialRecord).toBe(true);
    expect(await readFile(`${file}.quarantine`, "utf8")).toContain("{\"broken\"");
    expect(await readFile(file, "utf8")).toBe(`${JSON.stringify(valid)}\n`);
  });

  it("restores an interrupted tool call as pending until a terminal record", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonlSessionStore(directory);
    const call = { id: "call-1", name: "read_file", arguments: { path: "a.ts" } };
    await store.append("s1", {
      version: 1,
      type: "session_created",
      sessionId: "s1",
      at: createdAt,
      cwd: "/workspace",
      model: "scripted",
    });
    await store.append("s1", {
      version: 1,
      type: "tool_started",
      sessionId: "s1",
      at: createdAt,
      call,
    });

    expect((await store.loadState("s1")).pendingToolCalls).toEqual([call]);

    await store.append("s1", {
      version: 1,
      type: "tool_failed",
      sessionId: "s1",
      at: createdAt,
      callId: call.id,
      error: { code: "interrupted", message: "Interrupted", retryable: false },
    });
    expect((await store.loadState("s1")).pendingToolCalls).toEqual([]);
  });

  it("rejects corruption in the middle of a log", async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, "s1.jsonl");
    const created = JSON.stringify({
      version: 1,
      type: "session_created",
      sessionId: "s1",
      at: createdAt,
      cwd: "/workspace",
      model: "scripted",
    });
    const goal = JSON.stringify({
      version: 1,
      type: "goal_updated",
      sessionId: "s1",
      at: createdAt,
      goal: null,
    });
    await writeFile(file, `${created}\n{"broken"\n${goal}\n`, "utf8");

    await expect(new JsonlSessionStore(directory).load("s1")).rejects.toBeInstanceOf(
      SessionStoreError,
    );
  });

  it("rejects unsupported record versions", async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, "s1.jsonl");
    await writeFile(
      file,
      `${JSON.stringify({ version: 2, type: "session_created", sessionId: "s1" })}\n`,
      "utf8",
    );

    await expect(new JsonlSessionStore(directory).load("s1")).rejects.toMatchObject({
      code: "unsupported_version",
    });
  });
});
