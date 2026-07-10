import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  RecursRuntime,
  createCommandRegistry,
} from "@recurs/cli";
import {
  AgentLoop,
  JsonlSessionStore,
  type RecursEvent,
} from "@recurs/core";
import {
  ScriptedProvider,
  type ProviderEvent,
} from "@recurs/providers";
import {
  FileCheckpointStore,
  PermissionEngine,
  ToolRegistry,
  createApplyPatchTool,
  createGitDiffTool,
  createGitStatusTool,
  createListFilesTool,
  createReadFileTool,
  createRunCommandTool,
  createSearchTextTool,
} from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function toolTurn(
  id: string,
  name: string,
  arguments_: unknown,
): ProviderEvent[] {
  return [
    { type: "tool_call", call: { id, name, arguments: arguments_ } },
    { type: "done", stopReason: "tool_calls" },
  ];
}

async function createFixture(): Promise<{
  root: string;
  project: string;
  initialHash: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "recurs-e2e-"));
  roots.push(root);
  const project = path.join(root, "project");
  await mkdir(path.join(project, "src"), { recursive: true });
  await mkdir(path.join(project, "test"), { recursive: true });
  const initial = "export const value = 1;\n";
  await writeFile(path.join(project, "src", "value.ts"), initial, "utf8");
  await writeFile(
    path.join(project, "package.json"),
    `${JSON.stringify(
      {
        name: "recurs-e2e-fixture",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(project, "test", "value.test.js"),
    [
      'import assert from "node:assert/strict";',
      'import { readFile } from "node:fs/promises";',
      'import test from "node:test";',
      "",
      'test("agent changed value", async () => {',
      '  const source = await readFile(new URL("../src/value.ts", import.meta.url), "utf8");',
      '  assert.match(source, /value = 2/);',
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  await execFileAsync("git", ["init", "--quiet"], { cwd: project });
  await execFileAsync("git", ["add", "package.json", "src/value.ts", "test/value.test.js"], {
    cwd: project,
  });
  return {
    root,
    project,
    initialHash: createHash("sha256").update(initial).digest("hex"),
  };
}

interface TestRuntime {
  runtime: RecursRuntime;
  events: RecursEvent[];
  provider: ScriptedProvider;
}

async function createTestRuntime(
  root: string,
  project: string,
  provider: ScriptedProvider,
  sessionId?: string,
): Promise<TestRuntime> {
  const sessions = new JsonlSessionStore(path.join(root, "sessions"));
  const checkpoints = new FileCheckpointStore(path.join(root, "checkpoints"));
  const id = sessionId ?? "session-1";
  if (sessionId === undefined) {
    await sessions.append(id, {
      version: 1,
      type: "session_created",
      sessionId: id,
      at: "2026-07-10T00:00:00.000Z",
      cwd: project,
      model: "scripted",
    });
  }
  const state = await sessions.loadState(id);
  const events: RecursEvent[] = [];
  const tools = new ToolRegistry([], { checkpoints });
  tools.register(createReadFileTool());
  tools.register(createListFilesTool());
  tools.register(createSearchTextTool());
  tools.register(createApplyPatchTool());
  tools.register(createRunCommandTool());
  tools.register(createGitStatusTool());
  tools.register(createGitDiffTool());
  const loop = new AgentLoop({
    provider,
    tools,
    permissions: new PermissionEngine(state.permissionMode),
    approvals: { async request() { return "allow_once"; } },
    sessions,
    async emit(event) {
      events.push(event);
    },
    createToolContext(session, signal) {
      return {
        sessionId: session.id,
        cwd: session.cwd,
        signal,
        executionMode: session.executionMode,
        readRevisions: new Map(),
      };
    },
  });
  const runtimeReference: { current?: RecursRuntime } = {};
  const commands = createCommandRegistry({
    sessions,
    provider,
    checkpoints,
    signal: () =>
      runtimeReference.current?.currentSignal() ?? new AbortController().signal,
  });
  const runtime = new RecursRuntime(
    {
      commands,
      loop,
      sessions,
      confirm: async () => true,
      now: () => "2026-07-10T00:00:00.000Z",
    },
    state,
  );
  runtimeReference.current = runtime;
  return { runtime, events, provider };
}

describe("Recurs end-to-end coding harness", () => {
  it("reads, patches, verifies, persists, resumes, reviews, and safely undoes", async () => {
    const fixture = await createFixture();
    const patch = [
      "diff --git a/src/value.ts b/src/value.ts",
      "--- a/src/value.ts",
      "+++ b/src/value.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      "",
    ].join("\n");
    const codingProvider = new ScriptedProvider([
      toolTurn("read-1", "read_file", { path: "src/value.ts" }),
      toolTurn("patch-1", "apply_patch", {
        patch,
        files: [
          { path: "src/value.ts", expected_hash: fixture.initialHash },
        ],
      }),
      toolTurn("test-1", "run_command", { command: "npm test" }),
      [
        {
          type: "text_delta",
          text: "Changed value to 2 and verified the fixture test passes.",
        },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const first = await createTestRuntime(
      fixture.root,
      fixture.project,
      codingProvider,
    );

    await first.runtime.submit("/permissions approved_for_me");
    await first.runtime.submit("/goal change value and verify tests");
    await first.runtime.submit("Change value to 2 and run tests");

    expect(codingProvider.requests[0]?.messages[0]?.content).toContain(
      "change value and verify tests",
    );

    expect(await readFile(path.join(fixture.project, "src", "value.ts"), "utf8")).toContain(
      "value = 2",
    );
    expect(first.events).toContainEqual(
      expect.objectContaining({
        type: "verification_recorded",
        evidence: ["npm test exited 0"],
      }),
    );
    expect(first.runtime.session.goal).toMatchObject({
      objective: "change value and verify tests",
      progress: "Changed value to 2 and verified the fixture test passes.",
      evidence: ["npm test exited 0"],
    });
    await first.runtime.submit("/goal complete");
    expect(first.runtime.session.goal?.status).toBe("completed");

    const reviewProvider = new ScriptedProvider([
      [
        { type: "text_delta", text: "No review findings." },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const resumed = await createTestRuntime(
      fixture.root,
      fixture.project,
      reviewProvider,
      first.runtime.session.id,
    );
    expect(resumed.runtime.session.goal).toMatchObject({
      objective: "change value and verify tests",
      status: "completed",
    });

    await resumed.runtime.submit("/review");
    expect(reviewProvider.requests[0]?.messages.at(-1)?.content).toContain(
      "+export const value = 2;",
    );
    expect(reviewProvider.requests[0]?.tools.map((tool) => tool.name)).not.toContain(
      "apply_patch",
    );
    await resumed.runtime.submit("/undo");

    expect(await readFile(path.join(fixture.project, "src", "value.ts"), "utf8")).toContain(
      "value = 1",
    );
  });
});
