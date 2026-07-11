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
import type { ModelProvider, SessionBackendPin } from "@recurs/contracts";
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
  applyCommandSessionRecord,
  createCommandRegistry,
  type CommandContext,
} from "../src/index.js";
import { testBackendPin } from "../../../tests/support/backend.js";

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
  backend: SessionBackendPin = testBackendPin(),
): Promise<SessionState> {
  await sessions.createPinnedSession({
    id,
    at: createdAt,
    cwd,
    backend,
  });
  if (messages.length > 0) {
    await sessions.withSessionMutation(id, 0, async (lease) => {
      let turnId: string | null = null;
      for (const [index, message] of messages.entries()) {
        if (message.role === "user") {
          turnId = `seed-turn-${index}`;
          await lease.append({
            type: "turn_started",
            turnId,
            prompt: message.content,
            at: createdAt,
          });
        } else if (message.role === "assistant" && turnId !== null) {
          await lease.append({
            type: "model_completed",
            turnId,
            message,
            usage: null,
            stopReason: "complete",
            at: createdAt,
          });
          await lease.append({
            type: "turn_completed",
            turnId,
            at: createdAt,
            result: {
              finalText: message.content,
              usage: null,
              usageSource: "unavailable",
              steps: 1,
              changedFiles: [],
              changedFilesSource: "host_tools",
              evidence: [],
              evidenceSource: "none",
            },
          });
          turnId = null;
        }
      }
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
      commandContext.session = commandContext.session.version === 2
        ? await applyCommandSessionRecord(
            sessions,
            commandContext.session,
            record,
          )
        : reduceSessionRecord(commandContext.session, record);
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

  it("preserves Plan and permission safety when creating another session", async () => {
    const original = await storeSession("s1");
    const registry = createCommandRegistry({ sessions });
    const commandContext = context(original);
    await registry.execute("/permissions approved", commandContext);
    await registry.execute("/plan", commandContext);

    await registry.execute("/new", commandContext);

    expect(commandContext.session).toMatchObject({
      executionMode: "plan",
      permissionMode: "approved_for_me",
      prePlanPermissionMode: "approved_for_me",
    });
    await expect(sessions.loadState(commandContext.session.id)).resolves
      .toMatchObject({
        executionMode: "plan",
        permissionMode: "approved_for_me",
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
    const durableMessages = state.messages;
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
    expect(commandContext.session.messages).toEqual(durableMessages.slice(-6));
    expect((await sessions.loadState("s1")).summary).toBe("Earlier work summarized");
  });

  it("rejects delegated compaction before invoking a provider", async () => {
    const backend: SessionBackendPin = {
      ...testBackendPin(),
      kind: "agent_runtime",
      runtimeCapabilityProfileRevisionAtCreation: "runtime-capabilities-v1",
    };
    const state = await storeSession("delegated", at, [], backend);
    const stream = vi.fn(async function* () {
      yield { type: "done", stopReason: "complete" } as const;
    });
    const provider: ModelProvider = { id: "must-not-run", stream };
    const registry = createCommandRegistry({ sessions, provider });
    const commandContext = context(state);

    await expect(registry.execute("/compact", commandContext)).resolves.toMatchObject({
      type: "message",
      level: "error",
      text: expect.stringMatching(/delegated/iu),
    });
    expect(stream).not.toHaveBeenCalled();
    expect((await sessions.load("delegated")).records).toHaveLength(1);
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
    const conflict = await registry.execute("/undo", commandContext);
    expect(conflict).toMatchObject({
      level: "error",
      text: expect.stringMatching(
        /^Unexpected failure \(diagnostic [0-9a-f-]{36}\)$/u,
      ),
    });
    expect(JSON.stringify(conflict)).not.toContain("user changed a.txt");
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
