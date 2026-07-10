import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ScriptedProvider } from "@recurs/providers";
import {
  JsonlSessionStore,
  createSessionState,
  reduceSessionRecord,
  type SessionRecord,
  type SessionState,
} from "@recurs/core";
import type { Checkpoint } from "@recurs/tools";
import { CheckpointStore, ToolError } from "@recurs/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCommandRegistry,
  type CommandContext,
} from "../src/index.js";

const execFileAsync = promisify(execFile);
const at = "2026-07-10T00:00:00.000Z";
let root: string;
let cwd: string;
let sessions: JsonlSessionStore;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "recurs-session-commands-"));
  cwd = path.join(root, "project");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(cwd));
  sessions = new JsonlSessionStore(path.join(root, "sessions"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function storeSession(
  id: string,
  createdAt = at,
  messages: SessionState["messages"] = [],
): Promise<SessionState> {
  await sessions.append(id, {
    version: 1,
    type: "session_created",
    sessionId: id,
    at: createdAt,
    cwd,
    model: "scripted",
  });
  for (const message of messages) {
    await sessions.append(id, {
      version: 1,
      type: "message_appended",
      sessionId: id,
      at: createdAt,
      message,
    });
  }
  return sessions.loadState(id);
}

function context(
  state: SessionState,
  confirm = vi.fn(async () => true),
): CommandContext {
  const commandContext: CommandContext = {
    session: state,
    confirm,
    async cancelActiveRun() {
      return false;
    },
    now() {
      return at;
    },
    async applyRecord(record: SessionRecord) {
      await sessions.append(commandContext.session.id, record);
      commandContext.session = reduceSessionRecord(commandContext.session, record);
    },
  };
  return commandContext;
}

class FakeCheckpointStore extends CheckpointStore {
  readonly undo = vi.fn(async () => ({ restored: ["a.txt"], deleted: ["new.txt"] }));

  async captureBefore(): Promise<Checkpoint> {
    throw new Error("not used");
  }

  async captureAfter(): Promise<Checkpoint> {
    throw new Error("not used");
  }

  async undoLatest(sessionId: string, workingDirectory: string) {
    return this.undo(sessionId, workingDirectory);
  }
}

describe("session commands", () => {
  it("creates AGENTS.md once after confirmation and never overwrites it", async () => {
    const state = createSessionState({ id: "s1", cwd, model: "scripted" });
    const registry = createCommandRegistry({ sessions });
    const commandContext = context(state);

    expect(await registry.execute("/init", commandContext)).toMatchObject({ level: "info" });
    const initialized = await readFile(path.join(cwd, "AGENTS.md"), "utf8");
    expect(initialized).toContain("Recurs project instructions");
    expect(await registry.execute("/init", commandContext)).toMatchObject({
      level: "warning",
    });
    expect(await readFile(path.join(cwd, "AGENTS.md"), "utf8")).toBe(initialized);
  });

  it("creates a new durable session and resumes only an exact id", async () => {
    const original = await storeSession("s1");
    const registry = createCommandRegistry({ sessions });
    const commandContext = context(original);

    await registry.execute("/new", commandContext);
    const newId = commandContext.session.id;
    expect(newId).not.toBe("s1");
    expect((await sessions.loadState(newId)).id).toBe(newId);

    const listed = await registry.execute("/resume", commandContext);
    expect(listed).toMatchObject({ text: expect.stringContaining("s1") });
    await registry.execute("/resume s1", commandContext);
    expect(commandContext.session.id).toBe("s1");
    expect(await registry.execute("/resume s", commandContext)).toMatchObject({
      level: "error",
    });
  });

  it("lists resumable sessions newest first", async () => {
    const older = await storeSession("older", "2026-07-10T00:00:00.000Z");
    await storeSession("newer", "2026-07-10T01:00:00.000Z");
    const registry = createCommandRegistry({ sessions });

    const listed = await registry.execute("/resume", context(older));
    expect(listed.type).toBe("message");
    if (listed.type !== "message") {
      throw new Error("Expected session listing");
    }
    expect(listed.text.indexOf("newer")).toBeLessThan(listed.text.indexOf("older"));
  });

  it("compacts durable context through the injected provider", async () => {
    const messages = Array.from({ length: 8 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message ${index}`,
    }));
    const state = await storeSession("s1", at, messages);
    const provider = new ScriptedProvider([
      [
        { type: "text_delta", text: "Earlier work summarized" },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const registry = createCommandRegistry({ sessions, provider });
    const commandContext = context(state);

    await registry.execute("/compact", commandContext);

    expect(commandContext.session.summary).toBe("Earlier work summarized");
    expect(commandContext.session.messages).toEqual(messages.slice(-6));
    expect((await sessions.loadState("s1")).summary).toBe("Earlier work summarized");
  });
});

describe("repository commands", () => {
  it("shows diff and submits review with a temporary read-only override", async () => {
    await execFileAsync("git", ["init", "--quiet"], { cwd });
    await writeFile(path.join(cwd, "a.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "a.txt"], { cwd });
    await writeFile(path.join(cwd, "a.txt"), "after\n", "utf8");
    const state = createSessionState({ id: "s1", cwd, model: "scripted" });
    const registry = createCommandRegistry({ sessions });
    const commandContext = context(state);

    expect(await registry.execute("/diff a.txt", commandContext)).toMatchObject({
      text: expect.stringContaining("+after"),
    });
    const review = await registry.execute("/review", commandContext);
    expect(review).toMatchObject({
      type: "submit_prompt",
      executionMode: "plan",
      prompt: expect.stringContaining("+after"),
    });
    expect(commandContext.session.executionMode).toBe("act");
  });

  it("undoes through the checkpoint abstraction and reports conflicts", async () => {
    const checkpoints = new FakeCheckpointStore();
    const state = createSessionState({ id: "s1", cwd, model: "scripted" });
    const registry = createCommandRegistry({ sessions, checkpoints });
    const commandContext = context(state);

    expect(await registry.execute("/undo", commandContext)).toMatchObject({
      text: expect.stringContaining("a.txt"),
    });
    expect(checkpoints.undo).toHaveBeenCalledWith("s1", cwd);

    checkpoints.undo.mockRejectedValueOnce(
      new ToolError("checkpoint_conflict", "user changed a.txt"),
    );
    expect(await registry.execute("/undo", commandContext)).toMatchObject({
      level: "error",
      text: expect.stringContaining("user changed a.txt"),
    });
  });

  it("blocks workspace mutations while Plan mode is active", async () => {
    const checkpoints = new FakeCheckpointStore();
    const state = createSessionState({ id: "s1", cwd, model: "scripted" });
    state.executionMode = "plan";
    const registry = createCommandRegistry({ sessions, checkpoints });
    const commandContext = context(state);

    expect(await registry.execute("/init", commandContext)).toMatchObject({ level: "error" });
    expect(await registry.execute("/undo", commandContext)).toMatchObject({ level: "error" });
    await expect(readFile(path.join(cwd, "AGENTS.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
