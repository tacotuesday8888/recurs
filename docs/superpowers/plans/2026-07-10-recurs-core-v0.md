# Recurs Core v0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a usable single-agent coding harness with a streaming tool-call loop, safe workspace tools, durable sessions and goals, three permission modes, enforced Plan mode, checkpoints, a GLM-compatible provider, and an interactive/non-interactive `recurs` CLI.

**Architecture:** Four TypeScript workspaces separate provider transport, tool execution, orchestration, and presentation. The core owns immutable turn snapshots and an append-only session log; the CLI and scripted tests consume the same event stream. Tools enforce path, permission, checkpoint, and read-before-write rules independently of model prompts.

**Tech Stack:** Node.js 22.22+ (Node 24 LTS supported), TypeScript 6.0.3, npm workspaces, Vitest 4.1.10, ESLint 10.6.0, native `fetch`, native `readline`, and macOS `security` for Keychain integration.

## Global Constraints

- Build a first-party harness; do not fork or copy implementation code from the reference agents.
- Keep provider credentials out of transcripts, prompts, events, project files, and test snapshots.
- Default permission mode is `ask_always`; `full_access` never becomes a new-project default.
- Plan mode must hide and deny mutating tools at the execution boundary.
- Execute multiple tool calls sequentially in provider order for deterministic v0 behavior.
- Existing-file edits require a current-turn content hash captured by `read_file`.
- Checkpoints live outside project Git history and never run reset, clean, checkout, or commit against the user's repository.
- Persist completed messages and tool boundaries, not individual streaming deltas.
- No plugins, MCP marketplace, multi-agent orchestration, desktop UI, cloud workers, or branded command aliases in v0.
- Each task follows red-green-refactor and ends with the stated focused verification before its commit.

---

## File Map

```text
package.json                         Workspace scripts and pinned development dependencies
tsconfig.json                        Shared strict TypeScript settings and project references
eslint.config.mjs                    Type-aware lint rules
vitest.config.ts                     Workspace test discovery and coverage defaults
packages/providers/src/              Provider protocol, scripted provider, OpenAI-compatible transport
packages/tools/src/                  Tool protocol, permission engine, checkpoints, built-in tools
packages/core/src/                   Events, sessions, goals, modes, compaction, and agent loop
packages/cli/src/                    Commands, credentials, runtime assembly, REPL, and run mode
tests/e2e/                            Temporary-repository end-to-end harness proof
```

## Task 1: Bootstrap the Workspace and Provider Protocol

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `eslint.config.mjs`
- Create: `vitest.config.ts`
- Create: `packages/providers/package.json`
- Create: `packages/providers/tsconfig.json`
- Create: `packages/providers/src/types.ts`
- Create: `packages/providers/src/index.ts`
- Test: `packages/providers/test/types.test.ts`

**Interfaces:**
- Produces: `ModelMessage`, `ToolDefinition`, `ProviderRequest`, `ProviderEvent`, `ModelProvider`, `ProviderError`, and `collectProviderEvents()`.
- Consumers: all later provider, core, and tool-loop tasks.

- [ ] **Step 1: Write the protocol test**

```ts
import { describe, expect, it } from "vitest";
import { collectProviderEvents, ProviderError, type ProviderEvent } from "../src/index.js";

describe("provider protocol", () => {
  it("collects streamed text, tool calls, usage, and the stop reason", async () => {
    async function* events(): AsyncIterable<ProviderEvent> {
      yield { type: "text_delta", text: "hel" };
      yield { type: "text_delta", text: "lo" };
      yield { type: "tool_call", call: { id: "call-1", name: "read_file", arguments: { path: "a.ts" } } };
      yield { type: "usage", inputTokens: 10, outputTokens: 4 };
      yield { type: "done", stopReason: "tool_calls" };
    }

    await expect(collectProviderEvents(events())).resolves.toEqual({
      text: "hello",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "a.ts" } }],
      usage: { inputTokens: 10, outputTokens: 4 },
      stopReason: "tool_calls",
    });
  });

  it("marks normalized provider failures as retryable or terminal", () => {
    expect(new ProviderError("rate_limit", "slow down", true).retryable).toBe(true);
    expect(new ProviderError("authentication", "bad key", false).retryable).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and confirm the workspace is not implemented**

Run: `npm test -- --run packages/providers/test/types.test.ts`

Expected: FAIL because `package.json` and provider exports do not exist.

- [ ] **Step 3: Add the workspace configuration and complete provider types**

`package.json` must pin the verified versions and expose `build`, `typecheck`, `lint`, and `test` scripts. `packages/providers/src/types.ts` must define:

```json
{
  "name": "recurs",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "engines": { "node": ">=22.22.0" },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --pretty false",
    "lint": "eslint .",
    "test": "vitest run"
  },
  "devDependencies": {
    "@eslint/js": "10.0.1",
    "@types/node": "22.20.1",
    "eslint": "10.6.0",
    "typescript": "6.0.3",
    "typescript-eslint": "8.63.0",
    "vitest": "4.1.10"
  }
}
```

Then define the provider protocol:

```ts
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ModelMessage {
  id: string;
  role: MessageRole;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, JsonValue>;
}

export interface ProviderRequest {
  model: string;
  messages: readonly ModelMessage[];
  tools: readonly ToolDefinition[];
  signal: AbortSignal;
}

export type StopReason = "complete" | "tool_calls" | "length" | "cancelled" | "error";
export type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; stopReason: StopReason };

export interface ModelProvider {
  readonly id: string;
  stream(request: ProviderRequest): AsyncIterable<ProviderEvent>;
}

export type ProviderErrorCode = "authentication" | "rate_limit" | "context_overflow" | "transport" | "cancelled" | "invalid_response";

export class ProviderError extends Error {
  constructor(public readonly code: ProviderErrorCode, message: string, public readonly retryable: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderError";
  }
}
```

Implement `collectProviderEvents()` as the tested deterministic reducer and export everything through `index.ts`.

- [ ] **Step 4: Verify the provider package**

Run: `npm install && npm test -- --run packages/providers/test/types.test.ts && npm run typecheck`

Expected: install succeeds; 2 tests pass; TypeScript reports no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json eslint.config.mjs vitest.config.ts packages/providers
git commit -m "build: bootstrap Recurs provider protocol"
```

## Task 2: Permission Modes and Tool Registry

**Files:**
- Create: `packages/tools/package.json`
- Create: `packages/tools/tsconfig.json`
- Create: `packages/tools/src/types.ts`
- Create: `packages/tools/src/permissions.ts`
- Create: `packages/tools/src/registry.ts`
- Create: `packages/tools/src/index.ts`
- Test: `packages/tools/test/permissions.test.ts`
- Test: `packages/tools/test/registry.test.ts`

**Interfaces:**
- Consumes: `ToolCall`, `ToolDefinition`, and `JsonValue` from `@recurs/providers`.
- Produces: `PermissionMode`, `ExecutionMode`, `PermissionIntent`, `PermissionEngine`, `ApprovalHandler`, `Tool`, `ToolContext`, `ToolResult`, and `ToolRegistry.invoke()`.

- [ ] **Step 1: Write failing permission-mode tests**

```ts
import { describe, expect, it } from "vitest";
import { PermissionEngine } from "../src/index.js";

const intents = {
  read: { category: "read", resource: "src/a.ts", risk: "normal" },
  write: { category: "write", resource: "src/a.ts", risk: "normal" },
  safeShell: { category: "shell", resource: "npm test", risk: "normal" },
  network: { category: "network", resource: "example.com", risk: "elevated" },
  destructive: { category: "shell", resource: "rm -rf .", risk: "destructive" },
} as const;

describe("PermissionEngine", () => {
  it("implements Ask Always", () => {
    const engine = new PermissionEngine("ask_always");
    expect(engine.evaluate(intents.read)).toBe("allow");
    expect(engine.evaluate(intents.write)).toBe("ask");
    expect(engine.evaluate(intents.safeShell)).toBe("ask");
    expect(engine.evaluate(intents.destructive)).toBe("ask");
  });

  it("implements Approved for Me", () => {
    const engine = new PermissionEngine("approved_for_me");
    expect(engine.evaluate(intents.write)).toBe("allow");
    expect(engine.evaluate(intents.safeShell)).toBe("allow");
    expect(engine.evaluate(intents.network)).toBe("ask");
    expect(engine.evaluate(intents.destructive)).toBe("ask");
  });

  it("implements Full Access without disabling integrity guards", () => {
    const engine = new PermissionEngine("full_access");
    expect(engine.evaluate(intents.destructive)).toBe("allow");
    expect(engine.integrityGuardsEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and verify red**

Run: `npm test -- --run packages/tools/test/permissions.test.ts`

Expected: FAIL because the tools package is missing.

- [ ] **Step 3: Implement exact permission and tool contracts**

Use these stable public types:

```ts
export type PermissionMode = "ask_always" | "approved_for_me" | "full_access";
export type ExecutionMode = "act" | "plan";
export type PermissionDecision = "allow" | "ask" | "deny";
export type PermissionCategory = "read" | "write" | "shell" | "network" | "external_path" | "sensitive" | "credential" | "deploy";
export type Risk = "normal" | "elevated" | "destructive";

export interface PermissionIntent {
  category: PermissionCategory;
  resource: string;
  risk: Risk;
}

export interface ApprovalHandler {
  request(intent: PermissionIntent): Promise<"allow_once" | "allow_session" | "deny">;
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  executionMode: ExecutionMode;
  readRevisions: Map<string, string>;
}

export interface ToolResult {
  output: string;
  metadata?: Record<string, unknown>;
}

export interface Tool<I = unknown> {
  readonly definition: ToolDefinition;
  readonly mutating: boolean;
  parse(input: unknown): I;
  permissions(input: I, context: ToolContext): PermissionIntent[];
  execute(input: I, context: ToolContext): Promise<ToolResult>;
}
```

`PermissionEngine` must store only session-scoped grants, evaluate Plan mode as deny for mutating tools, and make `ToolRegistry.invoke()` validate the tool and input before requesting approval or execution.

- [ ] **Step 4: Add registry tests for unknown tools, invalid input, Plan mode, and session grants**

Run: `npm test -- --run packages/tools/test/permissions.test.ts packages/tools/test/registry.test.ts`

Expected: all permission and registry tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/tools
git commit -m "feat: add Recurs permission modes and tool registry"
```

## Task 3: Durable Events, Sessions, Goals, and Modes

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/src/events.ts`
- Create: `packages/core/src/session.ts`
- Create: `packages/core/src/jsonl-session-store.ts`
- Create: `packages/core/src/goal.ts`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/test/session.test.ts`
- Test: `packages/core/test/goal.test.ts`

**Interfaces:**
- Consumes: normalized provider messages, permission/execution modes, and tool results.
- Produces: `RecursEvent`, `SessionState`, `SessionRecord`, `JsonlSessionStore`, `Goal`, and pure session reducers.

- [ ] **Step 1: Write recovery and goal tests**

```ts
it("recovers valid JSONL records and quarantines a partial trailing record", async () => {
  await writeFile(file, `${JSON.stringify({ version: 1, type: "session_created", sessionId: "s1", at: 1 })}\n{"broken"`);
  const loaded = await store.load("s1");
  expect(loaded.records).toHaveLength(1);
  expect(loaded.recoveredPartialRecord).toBe(true);
});

it("persists a goal and restores it in a later process", async () => {
  await store.append("s1", { version: 1, type: "goal_updated", sessionId: "s1", at: 1, goal: activeGoal("Ship auth") });
  expect((await store.loadState("s1")).goal?.objective).toBe("Ship auth");
});

it("exits plan mode to the previously active permission mode", () => {
  const planned = enterPlanMode(makeSession({ permissionMode: "approved_for_me" }));
  expect(exitPlanMode(planned).permissionMode).toBe("approved_for_me");
});
```

- [ ] **Step 2: Run the focused tests and confirm red**

Run: `npm test -- --run packages/core/test/session.test.ts packages/core/test/goal.test.ts`

Expected: FAIL because core persistence is absent.

- [ ] **Step 3: Implement the event union and append-only store**

`RecursEvent` must include session/turn lifecycle, model completion, tool boundaries, permission decisions, goal changes, warnings, retries, cancellation, changed files, verification, and errors. `JsonlSessionStore.append()` writes exactly one newline-terminated record and synchronizes the file. `load()` accepts only schema version `1`, ignores/quarantines one invalid trailing line, and rejects corruption in the middle of the log.

The goal type is exact:

```ts
export interface Goal {
  objective: string;
  status: "active" | "paused" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  stepBudget?: number;
  tokenBudget?: number;
  timeBudgetMs?: number;
  progress: string;
  blockers: string[];
  evidence: string[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface SerializableError {
  code: string;
  message: string;
  retryable: boolean;
}
```

The persisted union must be explicit rather than an untyped event bag:

```ts
export type SessionRecord =
  | { version: 1; type: "session_created"; sessionId: string; at: string; cwd: string; model: string }
  | { version: 1; type: "message_appended"; sessionId: string; at: string; message: ModelMessage }
  | { version: 1; type: "tool_started"; sessionId: string; at: string; call: ToolCall }
  | { version: 1; type: "tool_completed"; sessionId: string; at: string; callId: string; result: ToolResult }
  | { version: 1; type: "tool_failed"; sessionId: string; at: string; callId: string; error: SerializableError }
  | { version: 1; type: "permission_resolved"; sessionId: string; at: string; intent: PermissionIntent; decision: string }
  | { version: 1; type: "goal_updated"; sessionId: string; at: string; goal: Goal | null }
  | { version: 1; type: "mode_updated"; sessionId: string; at: string; executionMode: ExecutionMode; permissionMode: PermissionMode; prePlanPermissionMode?: PermissionMode }
  | { version: 1; type: "turn_completed"; sessionId: string; at: string; usage: Usage; evidence: string[] }
  | { version: 1; type: "turn_failed"; sessionId: string; at: string; error: SerializableError };
```

- [ ] **Step 4: Verify persistence and mode reducers**

Run: `npm test -- --run packages/core/test/session.test.ts packages/core/test/goal.test.ts && npm run typecheck`

Expected: all tests pass and no type errors remain.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat: persist Recurs sessions events and goals"
```

## Task 4: Scripted Provider and Agent Loop

**Files:**
- Create: `packages/providers/src/scripted-provider.ts`
- Modify: `packages/providers/src/index.ts`
- Create: `packages/core/src/agent-loop.ts`
- Create: `packages/core/src/loop-detector.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/agent-loop.test.ts`
- Test: `packages/core/test/loop-detector.test.ts`

**Interfaces:**
- Consumes: `ModelProvider`, `ToolRegistry`, `PermissionEngine`, `JsonlSessionStore`, `ApprovalHandler`, and an event sink.
- Produces: `ScriptedProvider` and `AgentLoop.run(input): Promise<RunResult>`.

- [ ] **Step 1: Write loop tests for text, tools, ordering, cancellation, and stuck detection**

```ts
it("feeds sequential tool results back to the provider before completing", async () => {
  const provider = new ScriptedProvider([
    [{ type: "tool_call", call: { id: "1", name: "echo", arguments: { text: "a" } } }, { type: "done", stopReason: "tool_calls" }],
    [{ type: "text_delta", text: "done" }, { type: "done", stopReason: "complete" }],
  ]);
  const result = await harness(provider).run({ sessionId: "s1", prompt: "work", maxSteps: 8 });
  expect(result.finalText).toBe("done");
  expect(provider.requests[1]?.messages.at(-1)?.role).toBe("tool");
});

it("stops repeated tool-call-and-result signatures", async () => {
  await expect(repeatingHarness().run({ sessionId: "s1", prompt: "loop", maxSteps: 20 }))
    .rejects.toMatchObject({ code: "stuck_loop" });
});
```

- [ ] **Step 2: Run the tests and verify red**

Run: `npm test -- --run packages/core/test/agent-loop.test.ts packages/core/test/loop-detector.test.ts`

Expected: FAIL because the loop is not implemented.

- [ ] **Step 3: Implement the immutable-turn loop**

`AgentLoop.run()` must:

1. append the user message;
2. build a snapshot with goal, execution mode, permission mode, instructions, messages, and visible tools;
3. stream provider events to the event sink;
4. execute requested tools sequentially through the registry;
5. append tool messages and repeat;
6. stop on final text, abort, budget, provider failure, or repeated signature;
7. append the final assistant message and terminal event.

Use a default `maxSteps` of `40`, retry transport/rate-limit errors at most twice with abortable backoff, and declare a stuck loop when the same SHA-256 signature of normalized tool name, input, and result occurs 3 times in the latest 8 tool interactions.

The public loop shape must remain small:

```ts
export interface RunInput {
  sessionId: string;
  prompt: string;
  maxSteps?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  finalText: string;
  usage: { inputTokens: number; outputTokens: number };
  steps: number;
  changedFiles: string[];
  evidence: string[];
}

export interface AgentLoopDependencies {
  provider: ModelProvider;
  tools: ToolRegistry;
  permissions: PermissionEngine;
  approvals: ApprovalHandler;
  sessions: JsonlSessionStore;
  emit(event: RecursEvent): Promise<void>;
  createToolContext(state: SessionState, signal: AbortSignal): ToolContext;
}

export class AgentLoop {
  constructor(private readonly deps: AgentLoopDependencies) {}
  async run(input: RunInput): Promise<RunResult> {
    return runAgentLoop(this.deps, input);
  }
}
```

- [ ] **Step 4: Verify the complete fake-provider loop**

Run: `npm test -- --run packages/core/test/agent-loop.test.ts packages/core/test/loop-detector.test.ts`

Expected: text, tool, ordering, cancellation, retry, budget, and loop-detection tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src packages/core/src packages/core/test
git commit -m "feat: implement the Recurs agent loop"
```

## Task 5: Safe Read, List, Search, and Patch Tools

**Files:**
- Create: `packages/tools/src/path-policy.ts`
- Create: `packages/tools/src/builtins/read-file.ts`
- Create: `packages/tools/src/builtins/list-files.ts`
- Create: `packages/tools/src/builtins/search-text.ts`
- Create: `packages/tools/src/builtins/apply-patch.ts`
- Create: `packages/tools/src/process.ts`
- Modify: `packages/tools/src/index.ts`
- Test: `packages/tools/test/files.test.ts`
- Test: `packages/tools/test/apply-patch.test.ts`

**Interfaces:**
- Produces: `createReadFileTool()`, `createListFilesTool()`, `createSearchTextTool()`, and `createApplyPatchTool()`.
- Updates: `ToolContext.readRevisions` with SHA-256 hashes for successful reads.

- [ ] **Step 1: Write path and stale-write tests**

```ts
it("rejects traversal and symlink escape outside the workspace", async () => {
  await expect(invokeRead("../secret.txt")).rejects.toMatchObject({ code: "external_path" });
  await expect(invokeRead("link/outside.txt")).rejects.toMatchObject({ code: "external_path" });
});

it("requires the exact hash from a current-turn read", async () => {
  const first = await read("src/a.ts");
  await writeFile(path.join(cwd, "src/a.ts"), "user edit\n");
  await expect(apply({ patch: patchForA, files: [{ path: "src/a.ts", expected_hash: first.metadata?.sha256 }] }))
    .rejects.toMatchObject({ code: "stale_file" });
});
```

- [ ] **Step 2: Confirm red**

Run: `npm test -- --run packages/tools/test/files.test.ts packages/tools/test/apply-patch.test.ts`

Expected: FAIL because built-in tools do not exist.

- [ ] **Step 3: Implement bounded tools**

Requirements:

- Resolve real paths and verify they remain within `cwd` unless an approved external-path intent exists.
- Treat `.env`, `.env.*`, private keys, credential directories, and configured patterns as sensitive.
- Bound read output by line range and 256 KiB.
- Run `rg --files` and `rg --line-number --no-heading` without shell interpolation; cap output at 512 KiB.
- Define patch input as `{ patch: string; files: Array<{ path: string; expected_hash: string | null }> }`.
- Check every existing path against `readRevisions`, run `git apply --check`, then `git apply --whitespace=nowarn` with the patch on stdin.

The write guard is enforced immediately before `git apply`, not only while parsing:

```ts
for (const file of input.files) {
  const absolute = await policy.resolveWritable(file.path);
  const current = await sha256FileOrNull(absolute);
  if (file.expected_hash !== null && context.readRevisions.get(absolute) !== file.expected_hash) {
    throw new ToolError("unread_file", `Read ${file.path} before editing it`);
  }
  if (current !== file.expected_hash) {
    throw new ToolError("stale_file", `${file.path} changed after it was read`);
  }
}
await runProcess("git", ["apply", "--check", "-"], { cwd: context.cwd, stdin: input.patch, signal: context.signal });
await runProcess("git", ["apply", "--whitespace=nowarn", "-"], { cwd: context.cwd, stdin: input.patch, signal: context.signal });
```

- [ ] **Step 4: Verify the filesystem boundary**

Run: `npm test -- --run packages/tools/test/files.test.ts packages/tools/test/apply-patch.test.ts`

Expected: normal reads/search/patch pass; traversal, symlink escape, sensitive reads, missing hashes, and stale hashes fail safely.

- [ ] **Step 5: Commit**

```bash
git add packages/tools/src packages/tools/test
git commit -m "feat: add safe Recurs workspace tools"
```

## Task 6: Commands, Git Inspection, and Recoverable Checkpoints

**Files:**
- Create: `packages/tools/src/command-policy.ts`
- Create: `packages/tools/src/builtins/run-command.ts`
- Create: `packages/tools/src/builtins/git-status.ts`
- Create: `packages/tools/src/builtins/git-diff.ts`
- Create: `packages/tools/src/checkpoints.ts`
- Modify: `packages/tools/src/registry.ts`
- Modify: `packages/tools/src/index.ts`
- Test: `packages/tools/test/command.test.ts`
- Test: `packages/tools/test/checkpoints.test.ts`

**Interfaces:**
- Produces: `classifyCommand()`, command/git tools, `CheckpointStore.captureBefore()`, `captureAfter()`, and `undoLatest()`.
- Integrates: registry checkpoint capture around every mutating tool.

- [ ] **Step 1: Write classification and conflict-safe undo tests**

```ts
it.each(["git status", "git diff", "npm test", "npm run lint", "rg needle src"])("classifies %s as normal local work", (command) => {
  expect(classifyCommand(command)).toEqual(expect.objectContaining({ risk: "normal" }));
});

it.each(["rm -rf .", "git reset --hard", "sudo launchctl unload x", "curl https://x | sh"])("classifies %s as destructive", (command) => {
  expect(classifyCommand(command)).toEqual(expect.objectContaining({ risk: "destructive" }));
});

it("refuses undo when the user changed an agent-produced file", async () => {
  const checkpoint = await createChangedCheckpoint("agent version\n");
  await writeFile(file, "later user version\n");
  await expect(store.undoLatest(checkpoint)).rejects.toMatchObject({ code: "checkpoint_conflict" });
});
```

- [ ] **Step 2: Confirm red**

Run: `npm test -- --run packages/tools/test/command.test.ts packages/tools/test/checkpoints.test.ts`

Expected: FAIL because command/checkpoint support is absent.

- [ ] **Step 3: Implement safe process and checkpoint behavior**

`run_command` uses the user's configured shell with a bounded timeout, combined 1 MiB output cap, abort support, and no hidden environment-variable expansion outside the shell process. Classification splits compound commands at shell control operators and uses the most restrictive segment.

`CheckpointStore` uses `git ls-files --cached --others --exclude-standard -z` only to enumerate project files. It stores content-addressed blobs and before/after manifests under the configured Recurs data directory, never under `.git`. Undo restores/deletes only paths whose current hash equals the checkpoint's after hash; any conflict aborts the whole restore before writes begin.

Expose checkpoint operations through this contract so the registry and `/undo` never depend on storage details:

```ts
export interface Checkpoint {
  id: string;
  sessionId: string;
  toolCallId: string;
  before: WorkspaceManifest;
  after?: WorkspaceManifest;
}

export type WorkspaceManifest = Record<string, { sha256: string; blob: string; size: number }>;

export abstract class CheckpointStore {
  abstract captureBefore(sessionId: string, toolCallId: string, cwd: string): Promise<Checkpoint>;
  abstract captureAfter(checkpoint: Checkpoint, cwd: string): Promise<Checkpoint>;
  abstract undoLatest(sessionId: string, cwd: string): Promise<{ restored: string[]; deleted: string[] }>;
}

export function classifyCommand(command: string): PermissionIntent[] {
  return splitShellSegments(command).flatMap(classifySegment);
}
```

- [ ] **Step 4: Verify command cancellation and undo atomicity**

Run: `npm test -- --run packages/tools/test/command.test.ts packages/tools/test/checkpoints.test.ts`

Expected: command limits/cancellation/classification and safe undo tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/tools
git commit -m "feat: add command execution and safe checkpoints"
```

## Task 7: OpenAI-Compatible Streaming Provider for GLM

**Files:**
- Create: `packages/providers/src/openai-compatible.ts`
- Create: `packages/providers/src/sse.ts`
- Modify: `packages/providers/src/index.ts`
- Test: `packages/providers/test/openai-compatible.test.ts`

**Interfaces:**
- Produces: `OpenAICompatibleProvider({ id, baseUrl, apiKey, model, fetch? })`.
- Implements: `ModelProvider.stream()` using Chat Completions SSE and function calls.

- [ ] **Step 1: Write mocked SSE tests**

```ts
it("assembles fragmented streaming tool arguments", async () => {
  const provider = providerWithSse([
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\\"pa"}}]}}]}\n\n`,
    `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\\":\\\"a.ts\\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n`,
    "data: [DONE]\n\n",
  ]);
  const events = await toArray(provider.stream(request));
  expect(events).toContainEqual({ type: "tool_call", call: { id: "c1", name: "read_file", arguments: { path: "a.ts" } } });
});
```

- [ ] **Step 2: Confirm red**

Run: `npm test -- --run packages/providers/test/openai-compatible.test.ts`

Expected: FAIL because the provider does not exist.

- [ ] **Step 3: Implement authenticated streaming and normalized errors**

POST to `${baseUrl}/chat/completions` with Bearer auth, `stream: true`, normalized messages, and function definitions. Parse SSE by event boundary, assemble text/reasoning/tool deltas by choice and tool index, validate JSON arguments at tool completion, and map HTTP 401/403, 429, context errors, aborts, and malformed streams to `ProviderError`.

The adapter constructor and secret boundary are exact:

```ts
export interface OpenAICompatibleOptions {
  id: string;
  baseUrl: string;
  model: string;
  apiKey: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  constructor(private readonly options: OpenAICompatibleOptions) {
    this.id = options.id;
  }
  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    const apiKey = await this.options.apiKey();
    yield* streamChatCompletions(this.options, apiKey, request);
  }
}
```

- [ ] **Step 4: Verify transport behavior without a real key**

Run: `npm test -- --run packages/providers/test/openai-compatible.test.ts`

Expected: streaming text, fragmented tool calls, usage, error mapping, and abort tests pass with mocked fetch.

- [ ] **Step 5: Commit**

```bash
git add packages/providers
git commit -m "feat: add GLM-compatible streaming provider"
```

## Task 8: Slash Command Router, Goals, Plan Mode, and Permissions

**Files:**
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/commands/types.ts`
- Create: `packages/cli/src/commands/parser.ts`
- Create: `packages/cli/src/commands/registry.ts`
- Create: `packages/cli/src/commands/foundation.ts`
- Create: `packages/cli/src/commands/goal.ts`
- Create: `packages/cli/src/commands/plan.ts`
- Create: `packages/cli/src/commands/permissions.ts`
- Create: `packages/cli/src/index.ts`
- Test: `packages/cli/test/commands.test.ts`

**Interfaces:**
- Produces: `Command`, `CommandContext`, `CommandResult`, `parseCommand()`, and `createCommandRegistry()`.
- Commands: `/help`, `/model`, `/goal`, `/plan`, `/permissions`, `/status`, `/cancel`, `/quit`, and `/exit`.

- [ ] **Step 1: Write parser and state-transition tests**

```ts
it("parses command names, aliases, and inline arguments", () => {
  expect(parseCommand("/goal ship auth")).toEqual({ name: "goal", args: "ship auth" });
  expect(parseCommand("/exit")).toEqual({ name: "exit", args: "" });
  expect(parseCommand("normal prompt")).toBeNull();
});

it("enters Plan mode and restores Approved for Me on exit", async () => {
  const ctx = commandContext({ permissionMode: "approved_for_me" });
  await registry.execute("/plan inspect auth", ctx);
  expect(ctx.session.executionMode).toBe("plan");
  await registry.execute("/plan exit", ctx);
  expect(ctx.session.executionMode).toBe("act");
  expect(ctx.session.permissionMode).toBe("approved_for_me");
});
```

- [ ] **Step 2: Confirm red**

Run: `npm test -- --run packages/cli/test/commands.test.ts`

Expected: FAIL because CLI commands do not exist.

- [ ] **Step 3: Implement local command dispatch**

Commands return one of:

```ts
export type CommandResult =
  | { type: "message"; level: "info" | "warning" | "error"; text: string }
  | { type: "submit_prompt"; prompt: string }
  | { type: "quit" };
```

`/goal complete` requires summary/evidence already present in session state. `/permissions full_access` requires `CommandContext.confirm()` before changing state. `/plan` saves `prePlanPermissionMode` and filters tools through execution-mode enforcement, not just displayed command state.

- [ ] **Step 4: Verify all foundation commands**

Run: `npm test -- --run packages/cli/test/commands.test.ts`

Expected: parser, aliases, goal lifecycle, plan transition, permission confirmation, status, cancellation, and quit tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat: add Recurs foundation slash commands"
```

## Task 9: Remaining Usable-Agent Commands and Compaction

**Files:**
- Create: `packages/core/src/compaction.ts`
- Create: `packages/cli/src/credentials.ts`
- Create: `packages/cli/src/commands/session.ts`
- Create: `packages/cli/src/commands/repository.ts`
- Create: `packages/cli/src/commands/auth.ts`
- Modify: `packages/cli/src/commands/registry.ts`
- Test: `packages/core/test/compaction.test.ts`
- Test: `packages/cli/test/session-commands.test.ts`

**Interfaces:**
- Adds commands: `/login`, `/logout`, `/init`, `/new`, `/resume`, `/compact`, `/diff`, `/review`, and `/undo`.
- Produces: `CredentialStore`, `EnvironmentCredentialStore`, `MacOsKeychainCredentialStore`, and `compactSession()`.

- [ ] **Step 1: Write compaction, secret, and repository-command tests**

```ts
it("compaction retains goal, recent turns, changed files, and blockers", async () => {
  const compacted = await compactSession(longSession, scriptedSummaryProvider);
  expect(compacted.summary).toContain("Ship auth");
  expect(compacted.summary).toContain("src/auth.ts");
  expect(compacted.summary).toContain("Blocked by missing migration");
  expect(compacted.retainedMessages).toEqual(longSession.messages.slice(-6));
});

it("never serializes a credential returned by login", async () => {
  await registry.execute("/login zai", contextWithSecret("top-secret"));
  expect(await readFile(sessionLog, "utf8")).not.toContain("top-secret");
});
```

- [ ] **Step 2: Confirm red**

Run: `npm test -- --run packages/core/test/compaction.test.ts packages/cli/test/session-commands.test.ts`

Expected: FAIL because the commands and compaction are missing.

- [ ] **Step 3: Implement complete command behavior**

- `/login` accepts a key through hidden input, stores it in macOS Keychain under service `dev.recurs.cli`, and emits only provider/status metadata.
- `/init` creates `AGENTS.md` only after confirming it does not exist.
- `/resume` lists durable sessions newest-first and selects by exact ID.
- `/compact` asks the provider for a structured summary and keeps the latest six messages.
- `/review` submits a read-only prompt containing `git_diff` output; the active execution mode remains unchanged.
- `/undo` calls `CheckpointStore.undoLatest()` and reports conflicts without partial restore.

Credential storage must be replaceable and never expose values through status commands:

```ts
export interface CredentialStore {
  get(providerId: string): Promise<string | undefined>;
  set(providerId: string, value: string): Promise<void>;
  delete(providerId: string): Promise<void>;
  has(providerId: string): Promise<boolean>;
}

export interface CompactionResult {
  summary: string;
  retainedMessages: ModelMessage[];
}

export async function compactSession(state: SessionState, provider: ModelProvider, signal: AbortSignal): Promise<CompactionResult> {
  const retainedMessages = state.messages.slice(-6);
  const summary = await requestCompactionSummary(provider, state, retainedMessages, signal);
  return { summary, retainedMessages };
}
```

- [ ] **Step 4: Verify all command handlers**

Run: `npm test -- --run packages/core/test/compaction.test.ts packages/cli/test/session-commands.test.ts`

Expected: compaction, auth redaction, initialization, session lifecycle, diff/review, and undo tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core packages/cli
git commit -m "feat: complete the Recurs basic command set"
```

## Task 10: Interactive CLI and Structured Run Mode

**Files:**
- Create: `packages/cli/src/runtime.ts`
- Create: `packages/cli/src/render.ts`
- Create: `packages/cli/src/repl.ts`
- Create: `packages/cli/src/main.ts`
- Modify: `packages/cli/package.json`
- Test: `packages/cli/test/runtime.test.ts`
- Test: `packages/cli/test/run-mode.test.ts`

**Interfaces:**
- Produces: executable `recurs`, interactive REPL, and `recurs run <prompt> --format text|jsonl`.
- Consumes: all prior core/provider/tool/command interfaces without alternate execution logic.

- [ ] **Step 1: Write runtime assembly and JSONL tests**

```ts
it("emits normalized JSONL events in run mode", async () => {
  const output = await runCli(["run", "inspect", "--format", "jsonl"], fakeRuntime());
  const events = output.trim().split("\n").map((line) => JSON.parse(line));
  expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["turn_started", "assistant_completed", "turn_completed"]));
});

it("routes slash commands locally and prompts through the same loop", async () => {
  const runtime = fakeRuntime();
  await runtime.submit("/goal ship auth");
  await runtime.submit("inspect the repo");
  expect(runtime.session.goal?.objective).toBe("ship auth");
  expect(runtime.provider.requests).toHaveLength(1);
});
```

- [ ] **Step 2: Confirm red**

Run: `npm test -- --run packages/cli/test/runtime.test.ts packages/cli/test/run-mode.test.ts`

Expected: FAIL because the executable runtime is missing.

- [ ] **Step 3: Implement the CLI shell**

Use `node:readline/promises` for the REPL, `AbortController` for Ctrl-C, and the event renderer for streamed text/tool/approval/status output. Running `recurs` opens the current directory with `ask_always`; running `recurs run` creates or resumes one session and uses the exact same runtime object. Exit codes are `0` success, `1` terminal agent failure, `2` usage/configuration failure, and `130` cancellation.

All input goes through one submission method:

```ts
export interface RuntimeDependencies {
  commands: CommandRegistry;
  loop: AgentLoop;
  sessions: JsonlSessionStore;
  events: EventSink;
}

export class RecursRuntime {
  constructor(private readonly deps: RuntimeDependencies, public session: SessionState) {}

  async submit(input: string): Promise<CommandResult | RunResult> {
    const command = parseCommand(input);
    if (command) return this.deps.commands.execute(command, this.commandContext());
    return this.deps.loop.run({ sessionId: this.session.id, prompt: input, signal: this.currentSignal() });
  }
}
```

- [ ] **Step 4: Build and smoke-test the executable**

Run: `npm run build && node packages/cli/dist/main.js --help && npm test -- --run packages/cli/test/runtime.test.ts packages/cli/test/run-mode.test.ts`

Expected: build succeeds, help lists the command surface, and runtime tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli
git commit -m "feat: ship the Recurs interactive CLI foundation"
```

## Task 11: End-to-End Coding Proof and Documentation

**Files:**
- Create: `tests/e2e/coding-agent.test.ts`
- Create: `docs/CLI.md`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Verifies: the complete objective against a temporary Git repository using only public Recurs interfaces.

- [ ] **Step 1: Write the end-to-end scripted coding session**

```ts
it("reads, patches, verifies, persists, resumes, reviews, and safely undoes", async () => {
  const project = await createFixtureRepo({ "src/value.ts": "export const value = 1;\n", "package.json": testPackage });
  const runtime = await createTestRuntime(project, scriptedCodingProvider());
  await runtime.submit("/permissions approved_for_me");
  await runtime.submit("/goal change value and verify tests");
  await runtime.submit("Change value to 2 and run tests");

  expect(await readFile(path.join(project, "src/value.ts"), "utf8")).toContain("value = 2");
  expect(runtime.events).toContainEqual(expect.objectContaining({ type: "verification_recorded" }));

  const resumed = await createTestRuntime(project, scriptedReviewProvider(), runtime.session.id);
  expect(resumed.session.goal?.objective).toBe("change value and verify tests");
  await resumed.submit("/review");
  await resumed.submit("/undo");
  expect(await readFile(path.join(project, "src/value.ts"), "utf8")).toContain("value = 1");
});
```

- [ ] **Step 2: Run the end-to-end test and fix only proven integration gaps**

Run: `npm test -- --run tests/e2e/coding-agent.test.ts`

Expected: the full coding session passes without network credentials.

- [ ] **Step 3: Document the usable surface**

`docs/CLI.md` must explain installation from source, Z.AI key setup, Keychain behavior, the three permission modes, Plan/Act mode, `/goal`, every slash command, session location, checkpoint/undo conflicts, JSONL run mode, and current security limitations. `README.md` must link the CLI guide and clearly label plugins, multi-agent company behavior, and desktop as future work.

- [ ] **Step 4: Run the completion suite**

Run: `npm run lint && npm run typecheck && npm test && npm run build`

Expected: all commands exit 0 with no skipped Recurs tests.

- [ ] **Step 5: Perform the goal audit and commit**

Check every acceptance criterion in `docs/superpowers/specs/2026-07-10-recurs-core-v0-design.md` against a named passing test or CLI smoke result, then run:

```bash
git add README.md docs/CLI.md tests/e2e package.json package-lock.json
git commit -m "test: prove the Recurs harness end to end"
```
