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

import { ProviderError, ScriptedProvider } from "@recurs/providers";
import {
  getOperatingModePolicy,
  createHostInvocation,
  type AgentSessionDescriptor,
  type ModelProvider,
  type SessionBackendPin,
} from "@recurs/contracts";
import {
  JsonlSessionStore,
  TEAM_APPLY_PERMISSION,
  createSessionState,
  isPinnedSessionState,
  reduceSessionRecord,
  type SessionRecord,
  type SessionState,
  type TeamRunResult,
  type TeamRunSnapshot,
} from "@recurs/core";
import type { Checkpoint } from "@recurs/tools";
import {
  CheckpointStore,
  ToolError,
  permissionIntentKey,
} from "@recurs/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyCommandSessionRecord,
  createCommandRegistry,
  type CommandContext,
  type CommandDependencies,
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
    invocation: createHostInvocation({
      invocation: "repl",
      userPresent: true,
      remote: false,
      scripted: false,
      embedding: "cli",
    }),
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

function teamSnapshot(
  overrides: Partial<TeamRunSnapshot> = {},
): TeamRunSnapshot {
  return {
    id: "team-run-1",
    execution: "background",
    operatingModeId: "balanced_v4",
    status: "ready_to_apply",
    phase: "review",
    round: 1,
    childrenReserved: 4,
    childrenFinished: 4,
    usage: { inputTokens: 120, outputTokens: 40 },
    reportedCostUsd: 0.0125,
    costCoverage: "complete",
    manualAttentionRequired: false,
    updatedAt: at,
    ...overrides,
  };
}

function appliedTeamResult(id = "team-run-1"): TeamRunResult {
  return {
    output: `Applied reviewed team candidate ${id}`,
    metadata: {
      teamId: id,
      status: "approved",
      operatingModeId: "balanced_v4",
      repairRounds: 0,
      accounting: {
        childrenReserved: 4,
        childrenFinished: 4,
        requestsReserved: 16,
        requestsUsed: 12,
        usage: { inputTokens: 120, outputTokens: 40 },
        usageReportedChildren: 4,
        usageMissingChildren: 0,
        reportedCostUsd: 0.0125,
        costReportedChildren: 4,
        costMissingChildren: 0,
        costCoverage: "complete",
      },
      changedFiles: ["src/cache.ts"],
      evidence: ["npm test"],
    },
  };
}

function teamRunControls(
  snapshot = teamSnapshot(),
): NonNullable<CommandDependencies["teamRuns"]> {
  return {
    list: vi.fn(async () => [snapshot]),
    status: vi.fn(async () => snapshot),
    wait: vi.fn(async () => ({ snapshot, timedOut: false })),
    cancel: vi.fn(async () => ({ result: "requested", snapshot })),
    resume: vi.fn(async () => ({ result: "started", snapshot })),
    apply: vi.fn(async () => appliedTeamResult(snapshot.id)),
  };
}

describe("session commands", () => {
  it("persists an exact child-agent operating mode without changing the backend", async () => {
    const initial = await storeSession("agent-mode-session");
    const commands = createCommandRegistry({ sessions });
    const commandContext = context(initial);

    expect(await commands.execute("/agents", commandContext)).toMatchObject({
      type: "message",
      text: expect.stringMatching(
          /Balanced \(balanced_v5\)[\s\S]*Policy version: 5[\s\S]*explicit saved role candidates[\s\S]*metered_api[\s\S]*concurrency 3[\s\S]*Workflow: 7 children, 56 total requests, 8 reserved per child[\s\S]*Team: up to 2 Implement workers, 1 initial and 2 maximum Review workers[\s\S]*Review rule: unanimous, balanced quality standard[\s\S]*Repair rounds: 1/u,
      ),
    });
    const profiles = await commands.execute("/agents profiles", commandContext);
    expect(profiles).toMatchObject({
      type: "message",
      text: expect.stringMatching(
        /Explore \(explore_v1, v1\)[\s\S]*Implement \(implement_v1, v1\)[\s\S]*Review \(review_v1, v1\)/u,
      ),
    });
    expect(profiles).toMatchObject({
      text: expect.stringMatching(
        /Act parent required[\s\S]*run_verification[\s\S]*Team workflow: legacy execution uses version-3 policies/u,
      ),
    });
    expect(profiles).toMatchObject({
      text: expect.stringContaining(
        "read-only diff/file and Implement-evidence inspection; no repository execution or verification artifacts",
      ),
    });
    expect(profiles).toMatchObject({
      text: expect.stringMatching(
        /Implement \(implement_v2, v2\)[\s\S]*Review \(review_v2, v2\)[\s\S]*Repair \(repair_v1, v1\)[\s\S]*no repository process execution/u,
      ),
    });
    expect(await commands.execute("/agents profiles extra", commandContext))
      .toMatchObject({ level: "error" });
    expect(await commands.execute("/agents mode economy", commandContext)).toMatchObject({
      type: "message",
      text: expect.stringMatching(
          /Economy \(economy_v5\)[\s\S]*local_compute[\s\S]*concurrency 1 \(sequential fallback\)[\s\S]*Workflow: 2 children, 8 total requests, 4 reserved per child[\s\S]*Team: up to 1 Implement worker, 1 initial and 1 maximum Review worker/u,
      ),
    });
    const reloaded = await sessions.loadState("agent-mode-session");
    expect(reloaded).toMatchObject({
      agent: {
        operatingMode: { id: "economy_v5", version: 5 },
        limits: { maxRequests: 8, maxDepth: 1, maxConcurrentChildren: 1 },
      },
      backend: initial.backend,
    });
    expect(await commands.execute("/agents mode eco", commandContext)).toMatchObject({
      level: "error",
      text: expect.stringContaining("Choose /agents mode"),
    });
    expect(await commands.execute("/agents mode economy_v1", commandContext))
      .toMatchObject({
        text: expect.stringMatching(
          /Economy \(economy_v1\)[\s\S]*Policy version: 1[\s\S]*Workflow: 2 children, 16 total requests, 8 reserved per child/u,
        ),
      });
    expect(await sessions.loadState("agent-mode-session")).toMatchObject({
      agent: { operatingMode: { id: "economy_v1", version: 1 } },
    });
    expect(await commands.execute("/agents mode balanced_v4", commandContext))
      .toMatchObject({
        text: expect.stringMatching(
          /Balanced \(balanced_v4\)[\s\S]*Policy version: 4[\s\S]*Repair rounds: 1/u,
        ),
      });
    expect(await commands.execute("/agents mode balanced", commandContext))
      .toMatchObject({
        text: expect.stringMatching(/Balanced \(balanced_v5\)[\s\S]*Policy version: 5/u),
      });
  });

  it("lists and inspects parent-scoped durable child activity without private paths", async () => {
    const initial = await storeSession("activity-parent");
    if (initial.version !== 2) throw new Error("expected pinned parent");
    const mode = getOperatingModePolicy("balanced_v3");
    const childCwd = "/private/recurs/worktrees/activity-child";
    const agent: AgentSessionDescriptor = {
      id: "activity-child-agent",
      role: "child",
      profile: { id: "implement_v1", version: 1 },
      parentAgentId: initial.agent.id,
      parentSessionId: initial.id,
      depth: 1,
      task: {
        id: "activity-task",
        description: "Fix cache isolation",
        prompt: "private task prompt must remain hidden",
      },
      operatingMode: { id: mode.id, version: mode.version },
      backend: {
        strategy: "inherit_parent",
        adapterId: initial.backend.pin.adapterId,
        connectionId: initial.backend.pin.connectionId,
        modelId: initial.backend.pin.modelId,
      },
      permissions: {
        parentExecutionMode: "act",
        executionMode: "act",
        parentPermissionMode: "ask_always",
        permissionMode: "ask_always",
      },
      limits: { ...mode.orchestration, maxRequests: 8 },
      workspace: {
        kind: "git_worktree",
        version: 1,
        leaseId: "activity-lease",
        repositoryRoot: cwd,
        worktreeRoot: childCwd,
        revision: "b".repeat(40),
      },
    };
    await sessions.createPinnedSession({
      id: "activity-child-session",
      cwd: childCwd,
      backend: initial.backend.pin,
      agent,
      at: "2026-07-10T00:01:00.000Z",
    });
    const commands = createCommandRegistry({ sessions });
    const commandContext = context(initial);

    const list = await commands.execute("/agents activity", commandContext);
    expect(list).toMatchObject({
      type: "message",
      text: expect.stringMatching(
        /1 child agent[\s\S]*ready[\s\S]*Implement[\s\S]*Fix cache isolation[\s\S]*activity-child-session/u,
      ),
    });
    const detail = await commands.execute(
      "/agents activity activity-child-agent",
      commandContext,
    );
    expect(detail).toMatchObject({
      type: "message",
      text: expect.stringMatching(
        /Agent: Fix cache isolation[\s\S]*Status: ready[\s\S]*Profile: Implement \(implement_v1\)[\s\S]*Isolation: Git worktree at b{12}/u,
      ),
    });
    expect(JSON.stringify([list, detail])).not.toContain("private task prompt");
    expect(JSON.stringify([list, detail])).not.toContain("/private/recurs");
    expect(await commands.execute(
      "/agents activity activity",
      commandContext,
    )).toMatchObject({ level: "error", text: expect.stringContaining("not found") });
    expect(await createCommandRegistry().execute(
      "/agents activity",
      commandContext,
    )).toMatchObject({
      level: "error",
      text: "Durable agent activity is unavailable",
    });
    const shell = context(createSessionState({
      id: "activity-shell",
      cwd,
      model: "unconfigured",
    }));
    expect(await commands.execute("/agents activity", shell)).toMatchObject({
      level: "warning",
      text: expect.stringContaining("model connection"),
    });
  });

  it("lists, inspects, waits for, and cancels only safe team-run projections", async () => {
    const initial = await storeSession("team-controls-parent");
    const snapshot = {
      ...teamSnapshot(),
      internalPrompt: "PRIVATE TEAM PROMPT",
      backend: { apiKey: "PRIVATE BACKEND KEY" },
      artifactPath: "/private/recurs/team-candidate.patch",
    };
    const teamRuns = teamRunControls(snapshot);
    const signal = new AbortController().signal;
    const commands = createCommandRegistry({
      sessions,
      teamRuns,
      signal: () => signal,
    });
    const commandContext = context(initial);

    const results = await Promise.all([
      commands.execute("/agents teams", commandContext),
      commands.execute("/agents team team-run-1", commandContext),
      commands.execute("/agents wait team-run-1", commandContext),
      commands.execute("/agents cancel team-run-1", commandContext),
    ]);

    expect(results[0]).toMatchObject({
      type: "message",
      text: expect.stringMatching(
        /1 durable team run[\s\S]*ready_to_apply \| review \| round 1 \| 4\/4 children \| team-run-1/u,
      ),
    });
    expect(results[1]).toMatchObject({
      type: "message",
      text: expect.stringMatching(
        /Team run: team-run-1[\s\S]*Execution: background[\s\S]*Mode: balanced_v4[\s\S]*Usage: 120 input, 40 output tokens[\s\S]*Cost: \$0\.0125 \(complete coverage\)/u,
      ),
    });
    expect(results[2]).toMatchObject({
      type: "message",
      text: expect.stringContaining("Timed out: no"),
    });
    expect(results[3]).toMatchObject({
      type: "message",
      text: expect.stringContaining("Cancellation: requested"),
    });
    expect(JSON.stringify(results)).not.toMatch(
      /PRIVATE TEAM PROMPT|PRIVATE BACKEND KEY|team-candidate\.patch|internalPrompt|artifactPath/u,
    );
    expect(teamRuns.list).toHaveBeenCalledWith(initial.id);
    expect(teamRuns.status).toHaveBeenCalledWith(initial.id, "team-run-1");
    expect(teamRuns.wait).toHaveBeenCalledWith(
      initial.id,
      "team-run-1",
      30_000,
      signal,
    );
    expect(teamRuns.cancel).toHaveBeenCalledWith(
      initial.id,
      "team-run-1",
      "Cancelled from the Recurs CLI",
    );
  });

  it("does not disclose whether a missing team run belongs to another parent", async () => {
    const initial = await storeSession("team-not-found-parent");
    const teamRuns = teamRunControls();
    vi.mocked(teamRuns.status).mockRejectedValueOnce(new ToolError(
      "not_found",
      "Foreign team belongs to private-parent-session",
    ));
    vi.mocked(teamRuns.wait).mockRejectedValueOnce(new ToolError(
      "not_found",
      "Missing team journal at /private/recurs/team.jsonl",
    ));
    const commands = createCommandRegistry({ sessions, teamRuns });
    const commandContext = context(initial);

    await expect(commands.execute(
      "/agents team foreign-team",
      commandContext,
    )).resolves.toEqual({
      type: "message",
      level: "error",
      text: "Team run not found",
    });
    await expect(commands.execute(
      "/agents wait missing-team",
      commandContext,
    )).resolves.toEqual({
      type: "message",
      level: "error",
      text: "Team run not found",
    });
  });

  it("requires Full Access to resume and passes the trusted CLI context", async () => {
    const initial = await storeSession("team-resume-parent");
    const teamRuns = teamRunControls(teamSnapshot({ status: "interrupted" }));
    const commands = createCommandRegistry({ sessions, teamRuns });
    const commandContext = context(initial);

    expect(await commands.execute(
      "/agents resume team-run-1",
      commandContext,
    )).toEqual({
      type: "message",
      level: "error",
      text: "Resuming a background team requires Full Access",
    });
    expect(teamRuns.resume).not.toHaveBeenCalled();

    await commands.execute("/permissions full", commandContext);
    expect(await commands.execute(
      "/agents resume team-run-1",
      commandContext,
    )).toMatchObject({
      type: "message",
      text: expect.stringMatching(/Resume: started[\s\S]*Status: interrupted/u),
    });
    expect(teamRuns.resume).toHaveBeenCalledTimes(1);
    const resumeContext = vi.mocked(teamRuns.resume).mock.calls[0]![2];
    expect(resumeContext).toMatchObject({
      sessionId: initial.id,
      cwd,
      executionMode: "act",
      runContext: {
        invocation: "repl",
        presence: "present",
        location: "local",
        automation: "manual",
      },
    });
    expect(resumeContext.approvedIntents).toBeUndefined();
  });

  it("applies in Approved for Me only after an exact explicit approval", async () => {
    const initial = await storeSession("team-apply-parent");
    const teamRuns = teamRunControls();
    const confirm = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const commands = createCommandRegistry({ sessions, teamRuns });
    const commandContext = context(initial, confirm);
    await commands.execute("/permissions approved", commandContext);

    expect(await commands.execute(
      "/agents apply team-run-1",
      commandContext,
    )).toEqual({
      type: "message",
      level: "warning",
      text: "Team apply was not approved",
    });
    expect(teamRuns.apply).not.toHaveBeenCalled();

    expect(await commands.execute(
      "/agents apply team-run-1",
      commandContext,
    )).toMatchObject({
      type: "message",
      text: "Applied reviewed team candidate team-run-1",
    });
    expect(confirm).toHaveBeenNthCalledWith(
      1,
      "Apply reviewed team candidate team-run-1 to the current workspace?",
    );
    expect(confirm).toHaveBeenNthCalledWith(
      2,
      "Apply reviewed team candidate team-run-1 to the current workspace?",
    );
    expect(teamRuns.apply).toHaveBeenCalledTimes(1);
    const applyContext = vi.mocked(teamRuns.apply).mock.calls[0]![2];
    expect(applyContext.approvedIntents).toEqual(new Set([
      permissionIntentKey(TEAM_APPLY_PERMISSION),
    ]));
  });

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

  it("lists saved model connections and activates only one exact confirmed choice", async () => {
    const original = await storeSession("model-original");
    const nextBackend = {
      ...testBackendPin(),
      providerId: "second-provider",
      connectionId: "second-connection",
      modelId: "second-model",
      providerResolvedModelRevisionAtCreation: "second-model",
      accountSubjectFingerprint: "sha256:second-account",
    };
    const switched = await storeSession(
      "model-switched",
      at,
      [],
      nextBackend,
    );
    const options = [{
      connectionId: original.backend.type === "pinned"
        ? original.backend.pin.connectionId
        : "missing",
      label: "Current model",
      providerId: original.backend.type === "pinned"
        ? original.backend.pin.providerId
        : "missing",
      modelId: original.model,
      primary: true,
      execution: "Act + Plan" as const,
      billingSources: ["metered_api" as const],
    }, {
      connectionId: "second-connection",
      label: "Second model",
      providerId: "second-provider",
      modelId: "second-model",
      primary: false,
      execution: "Act + Plan" as const,
      billingSources: ["metered_api" as const],
    }];
    const models: NonNullable<CommandDependencies["models"]> = {
      list: vi.fn(async () => options),
      create: vi.fn(async () => ({ status: "created", session: switched })),
    };
    const commands = createCommandRegistry({ sessions, models });
    const confirm = vi.fn(async () => true);
    const commandContext = context(original, confirm);

    expect(await commands.execute("/model", commandContext)).toMatchObject({
      text: expect.stringMatching(
        /Current: scripted\/scripted[\s\S]*\[active, primary\][\s\S]*second-connection[\s\S]*Use \/model <exact-connection-id>/u,
      ),
    });
    expect(await commands.execute(
      "/model second-connection",
      commandContext,
    )).toMatchObject({
      text: expect.stringContaining("Started session model-switched"),
    });
    expect(commandContext.session.id).toBe("model-switched");
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(
      /second-provider\/second-model[\s\S]*Billing: metered_api[\s\S]*primary connection will remain unchanged/u,
    ));
    expect(models.create).toHaveBeenCalledWith(expect.objectContaining({
      expected: options[1],
      current: original,
      at,
    }));
  });

  it("rejects model selection outside a local manual terminal", async () => {
    const original = await storeSession("model-unattended");
    const models: NonNullable<CommandDependencies["models"]> = {
      list: vi.fn(async () => [{
        connectionId: "second-connection",
        label: "Second model",
        providerId: "second-provider",
        modelId: "second-model",
        primary: false,
        execution: "Act + Plan" as const,
        billingSources: ["metered_api" as const],
      }]),
      create: vi.fn(),
    };
    const commands = createCommandRegistry({ sessions, models });
    const commandContext = context(original);
    commandContext.invocation = createHostInvocation({
      invocation: "one_shot",
      userPresent: false,
      remote: false,
      scripted: true,
      embedding: "cli",
    });

    expect(await commands.execute(
      "/model second-connection",
      commandContext,
    )).toMatchObject({
      level: "error",
      text: expect.stringContaining("local, user-present, manual terminal"),
    });
    expect(models.create).not.toHaveBeenCalled();
  });

  it("preserves Plan and permission safety when creating another session", async () => {
    const original = await storeSession("s1");
    const registry = createCommandRegistry({ sessions });
    const commandContext = context(original);
    await registry.execute("/permissions approved", commandContext);
    await registry.execute("/agents mode performance", commandContext);
    await registry.execute("/plan", commandContext);

    await registry.execute("/new", commandContext);

    expect(commandContext.session).toMatchObject({
      executionMode: "plan",
      permissionMode: "approved_for_me",
      prePlanPermissionMode: "approved_for_me",
      agent: { operatingMode: { id: "performance_v5", version: 5 } },
    });
    await expect(sessions.loadState(commandContext.session.id)).resolves
      .toMatchObject({
        executionMode: "plan",
        permissionMode: "approved_for_me",
        agent: { operatingMode: { id: "performance_v5", version: 5 } },
      });
  });

  it("forks completed direct context with policy while resetting branch-local state", async () => {
    const messages = Array.from({ length: 8 }, (_, index) => ({
      id: `fork-message-${index}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `fork message ${index}`,
    }));
    const original = await storeSession("fork-source", at, messages);
    const provider = new ScriptedProvider([[
      { type: "text_delta", text: "Forked history summary" },
      { type: "done", stopReason: "complete" },
    ]]);
    const registry = createCommandRegistry({ sessions, provider });
    const commandContext = context(original);
    await registry.execute("/compact", commandContext);
    await registry.execute("/agents mode performance", commandContext);
    await registry.execute("/permissions approved", commandContext);
    await registry.execute("/plan", commandContext);
    await registry.execute("/goal continue the source objective", commandContext);
    const source = commandContext.session;
    if (!isPinnedSessionState(source)) throw new Error("expected pinned source");

    const result = await registry.execute("/fork", commandContext);

    expect(result).toMatchObject({
      type: "message",
      text: expect.stringContaining("Forked session fork-source as"),
    });
    const fork = commandContext.session;
    if (!isPinnedSessionState(fork)) throw new Error("expected pinned fork");
    expect(fork.id).not.toBe(source.id);
    expect(fork).toMatchObject({
      forkedFrom: { sessionId: source.id, sequence: source.lastSequence },
      backend: source.backend,
      summary: source.summary,
      messages: source.messages,
      messageTurnIds: source.messageTurnIds,
      permissionMode: "approved_for_me",
      executionMode: "plan",
      prePlanPermissionMode: "approved_for_me",
      goal: null,
      usage: { inputTokens: 0, outputTokens: 0 },
      evidence: [],
      changedFiles: [],
      pendingToolCalls: [],
      openTurnId: null,
      agent: {
        role: "parent",
        operatingMode: { id: "performance_v5", version: 5 },
      },
    });
    expect(fork.agent.id).toBe(`${fork.id}:agent`);
    expect(await registry.execute("/status", commandContext)).toMatchObject({
      text: expect.stringContaining(
        `Forked from: ${source.id} at sequence ${source.lastSequence}`,
      ),
    });
    await expect(sessions.loadState(fork.id)).resolves.toEqual(fork);
    await expect(sessions.loadState(source.id)).resolves.toMatchObject({
      goal: { objective: "continue the source objective", status: "active" },
    });
    expect(await registry.execute("/fork extra", commandContext)).toMatchObject({
      level: "error",
    });
  });

  it("fails closed for legacy, delegated-runtime, active, and stale forks", async () => {
    const registry = createCommandRegistry({ sessions });
    const legacy = context(createSessionState({ id: "legacy", cwd, model: "legacy" }));
    expect(await registry.execute("/fork", legacy)).toMatchObject({
      level: "error",
      text: expect.stringContaining("Legacy"),
    });

    const delegatedBackend: SessionBackendPin = {
      ...testBackendPin(),
      kind: "agent_runtime",
      runtimeCapabilityProfileRevisionAtCreation: "runtime-capabilities-v1",
    };
    const delegated = context(await storeSession("delegated-fork", at, [], delegatedBackend));
    expect(await registry.execute("/fork", delegated)).toMatchObject({
      level: "error",
      text: expect.stringContaining("Delegated runtime"),
    });

    const active = await storeSession("active-fork");
    if (!isPinnedSessionState(active)) throw new Error("expected pinned active session");
    await sessions.withSessionMutation(active.id, active.lastSequence, async (lease) => {
      await lease.append({
        type: "turn_started",
        turnId: "active-turn",
        prompt: "still running",
        at,
      });
    });
    await expect(sessions.forkPinnedSession({
      sourceId: active.id,
      expectedSourceSequence: active.lastSequence + 1,
      id: "active-target",
      at,
    })).rejects.toMatchObject({ code: "session_conflict" });

    const stable = await storeSession("stale-fork");
    if (!isPinnedSessionState(stable)) throw new Error("expected pinned stable session");
    await sessions.withSessionMutation(stable.id, stable.lastSequence, async (lease) => {
      await lease.append({
        type: "goal_updated",
        source: "command",
        goal: null,
        at,
      });
    });
    await expect(sessions.forkPinnedSession({
      sourceId: stable.id,
      expectedSourceSequence: stable.lastSequence,
      id: "stale-target",
      at,
    })).rejects.toMatchObject({ code: "session_conflict" });
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
        { type: "usage", inputTokens: 80, outputTokens: 12 },
        { type: "done", stopReason: "complete" },
      ],
    ]);
    const registry = createCommandRegistry({ sessions, provider });
    const commandContext = context(state);

    await registry.execute("/compact", commandContext);

    expect(commandContext.session.summary).toBe("Earlier work summarized");
    expect(commandContext.session.messages).toEqual(durableMessages.slice(-6));
    expect(commandContext.session.usage).toEqual({
      inputTokens: 80,
      outputTokens: 12,
    });
    expect((await sessions.loadState("s1")).summary).toBe("Earlier work summarized");
    expect((await sessions.load("s1")).records.slice(-2).map((record) =>
      record.type
    )).toEqual(["compaction_started", "session_compacted"]);
  });

  it("persists compaction start before provider work and a safe typed failure", async () => {
    const state = await storeSession(
      "failed-compaction",
      at,
      Array.from({ length: 8 }, (_, index) => ({
        id: `failure-${index}`,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: `failure message ${index}`,
      })),
    );
    const canary = "RECURS_COMPACTION_FAILURE_CANARY";
    let observedStarted = false;
    const provider: ModelProvider = {
      id: "failing-provider",
      stream() {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                const records = (await sessions.load("failed-compaction")).records;
                observedStarted = records.at(-1)?.type === "compaction_started";
                throw new ProviderError("context_overflow", canary, false);
              },
            };
          },
        };
      },
    };
    const registry = createCommandRegistry({ sessions, provider });
    const commandContext = context(state);

    await expect(
      registry.execute("/compact", commandContext),
    ).resolves.toMatchObject({
      type: "message",
      level: "error",
      text: "Provider context limit exceeded",
    });

    expect(observedStarted).toBe(true);
    const loaded = await sessions.load("failed-compaction");
    expect(loaded.records.slice(-2).map((record) => record.type)).toEqual([
      "compaction_started",
      "compaction_failed",
    ]);
    expect(loaded.records.at(-1)).toMatchObject({
      type: "compaction_failed",
      error: {
        domain: "provider",
        code: "context_overflow",
        safeMessage: "Provider context limit exceeded",
        retryable: false,
      },
      usage: null,
      usageSource: "unknown",
    });
    expect(JSON.stringify(loaded)).not.toContain(canary);
    expect((await sessions.loadState("failed-compaction")).pendingCompaction)
      .toBeNull();
  });

  it("resolves the compaction provider from the active session pin", async () => {
    const messages = Array.from({ length: 8 }, (_, index) => ({
      id: `dynamic-${index}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `dynamic message ${index}`,
    }));
    const state = await storeSession("dynamic", at, messages);
    const startupProvider = new ScriptedProvider([
      [
        { type: "text_delta", text: "wrong provider" },
        { type: "done", stopReason: "complete" },
      ],
    ], "startup-provider");
    const pinnedProvider = new ScriptedProvider([
      [
        { type: "text_delta", text: "pinned provider summary" },
        { type: "done", stopReason: "complete" },
      ],
    ], "pinned-provider");
    const resolveProvider = vi.fn(async (session: SessionState) => {
      expect(session.id).toBe("dynamic");
      return pinnedProvider;
    });
    const registry = createCommandRegistry({
      sessions,
      provider: startupProvider,
      resolveProvider,
    });
    const commandContext = context(state);

    await registry.execute("/compact", commandContext);

    expect(resolveProvider).toHaveBeenCalledOnce();
    expect(startupProvider.requests).toHaveLength(0);
    expect(pinnedProvider.requests).toHaveLength(1);
    expect(commandContext.session.summary).toBe("pinned provider summary");
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
    const resolveProvider = vi.fn(async () => provider);
    const registry = createCommandRegistry({
      sessions,
      provider,
      resolveProvider,
    });
    const commandContext = context(state);

    await expect(registry.execute("/compact", commandContext)).resolves.toMatchObject({
      type: "message",
      level: "error",
      text: expect.stringMatching(/delegated/iu),
    });
    expect(stream).not.toHaveBeenCalled();
    expect(resolveProvider).not.toHaveBeenCalled();
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
