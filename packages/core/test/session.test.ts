import {
  appendFile,
  lstat,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JsonlSessionStore,
  SessionStoreError,
  activeGoal,
} from "../src/index.js";
import { acquireSessionLock } from "../src/session-mutation-lease.js";
import { testBackendPin } from "../../../tests/support/backend.js";

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

    await store.createPinnedSession({
      id: "s1",
      at: createdAt,
      cwd: "/workspace",
      backend: testBackendPin(),
    });
    await store.withSessionMutation("s1", 0, async (lease) => {
      await lease.append({
        type: "goal_updated",
        source: "command",
        at: createdAt,
        goal: activeGoal("Ship auth", createdAt),
      });
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

  it("keeps ordinary recovery reads non-mutating while the writer lock is held", async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, "s1.jsonl");
    const quarantine = `${file}.quarantine`;
    const valid = {
      version: 1,
      type: "session_created",
      sessionId: "s1",
      at: createdAt,
      cwd: "/workspace",
      model: "scripted",
    } as const;
    await writeFile(file, `${JSON.stringify(valid)}\n{"broken"`, "utf8");
    await writeFile(quarantine, "older quarantined tail\n", "utf8");
    const journalBefore = await readFile(file);
    const quarantineBefore = await readFile(quarantine);
    const store = new JsonlSessionStore(directory);
    const lock = await acquireSessionLock(directory, "s1");

    try {
      for (const read of [
        () => store.load("s1"),
        () => store.loadState("s1"),
        () => store.list(),
      ]) {
        await expect(read()).rejects.toMatchObject({ code: "session_busy" });
        expect(await readFile(file)).toEqual(journalBefore);
        expect(await readFile(quarantine)).toEqual(quarantineBefore);
      }
    } finally {
      await lock.release();
    }
  });

  it("repairs exactly the torn suffix on the same inode after the writer releases", async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, "s1.jsonl");
    const quarantine = `${file}.quarantine`;
    const valid = {
      version: 1,
      type: "session_created",
      sessionId: "s1",
      at: createdAt,
      cwd: "/workspace",
      model: "scripted",
    } as const;
    const durablePrefix = `${JSON.stringify(valid)}\n`;
    const tornSuffix = "{\"broken\"";
    await writeFile(file, `${durablePrefix}${tornSuffix}`, "utf8");
    await writeFile(quarantine, "older quarantined tail\n", "utf8");
    const inode = (await lstat(file)).ino;
    const store = new JsonlSessionStore(directory);
    const lock = await acquireSessionLock(directory, "s1");
    await lock.release();

    const loaded = await store.load("s1");

    expect(loaded).toEqual({
      records: [valid],
      recoveredPartialRecord: true,
    });
    expect(await readFile(file, "utf8")).toBe(durablePrefix);
    expect(await readFile(quarantine, "utf8"))
      .toBe(`older quarantined tail\n${tornSuffix}\n`);
    expect((await lstat(file)).ino).toBe(inode);
  });

  it("repairs a complete-looking undurable V2 tail before appending under its mutation lock", async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, "s1.jsonl");
    const store = new JsonlSessionStore(directory);
    await store.createPinnedSession({
      id: "s1",
      at: createdAt,
      cwd: "/workspace",
      backend: testBackendPin(),
    });
    await appendFile(file, JSON.stringify({
      version: 2,
      type: "goal_updated",
      sessionId: "s1",
      sequence: 1,
      source: "command",
      at: createdAt,
      goal: activeGoal("Undurable goal", createdAt),
    }), "utf8");

    await store.withSessionMutation("s1", 0, async (lease) => {
      await lease.append({
        type: "goal_updated",
        source: "command",
        at: createdAt,
        goal: activeGoal("Durable goal", createdAt),
      });
    });

    const loaded = await store.load("s1");
    expect(loaded.recoveredPartialRecord).toBe(false);
    expect(loaded.records).toHaveLength(2);
    expect(await store.loadState("s1")).toMatchObject({
      lastSequence: 1,
      goal: { objective: "Durable goal" },
    });
    expect(await readFile(file, "utf8")).not.toContain("Undurable goal");
  });

  it("restores an interrupted tool call as pending until a terminal record", async () => {
    const directory = await temporaryDirectory();
    const store = new JsonlSessionStore(directory);
    const call = { id: "call-1", name: "read_file", arguments: { path: "a.ts" } };
    await store.createPinnedSession({
      id: "s1",
      at: createdAt,
      cwd: "/workspace",
      backend: testBackendPin(),
    });
    await store.withSessionMutation("s1", 0, async (lease) => {
      await lease.append({
        type: "turn_started",
        turnId: "turn-1",
        prompt: "inspect",
        at: createdAt,
      });
      await lease.append({
        type: "model_completed",
        turnId: "turn-1",
        at: createdAt,
        message: {
          id: "assistant-1",
          role: "assistant",
          content: "",
          toolCalls: [call],
        },
        usage: null,
        stopReason: "tool_calls",
      });
      await lease.append({
        type: "tool_started",
        turnId: "turn-1",
        at: createdAt,
        call,
      });
    });

    expect((await store.loadState("s1")).pendingToolCalls).toEqual([call]);

    await store.withSessionMutation("s1", 3, async (lease) => {
      await lease.append({
        type: "tool_failed",
        turnId: "turn-1",
        at: createdAt,
        callId: call.id,
        error: {
          domain: "tool",
          phase: "started",
          code: "tool_failed",
          safeMessage: "Tool error [interrupted]: Interrupted",
          diagnosticId: "interrupted-test",
          retryable: false,
        },
      });
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

  it("rejects invalid UTF-8 in a newline-committed record", async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, "s1.jsonl");
    const beforeInvalidByte = Buffer.from(
      `{"version":1,"type":"session_created","sessionId":"s1","at":"${createdAt}","cwd":"/workspace","model":"`,
      "utf8",
    );
    const afterInvalidByte = Buffer.from("\"}\n", "utf8");
    const journal = Buffer.concat([
      beforeInvalidByte,
      Buffer.from([0xc3, 0x28]),
      afterInvalidByte,
    ]);
    await writeFile(file, journal);

    await expect(new JsonlSessionStore(directory).load("s1")).rejects.toMatchObject({
      code: "corrupt_log",
    });
    expect(await readFile(file)).toEqual(journal);
  });

  it("rejects malformed version 2 records", async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, "s1.jsonl");
    await writeFile(
      file,
      `${JSON.stringify({ version: 2, type: "session_created", sessionId: "s1" })}\n`,
      "utf8",
    );

    await expect(new JsonlSessionStore(directory).load("s1")).rejects.toMatchObject({
      code: "invalid_record",
    });
  });
});
