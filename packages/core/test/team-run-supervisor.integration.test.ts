import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  createHostInvocation,
  deriveTrustedRunContext,
  getOperatingModePolicy,
  type CoordinatedRunInput,
  type RunCoordinator,
  type RunResult,
} from "@recurs/contracts";
import {
  FileCheckpointStore,
  permissionIntentKey,
  ToolError,
  type ToolContext,
  type runProcess,
} from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

import { AgentBackendRouter } from "../src/agent-backend-router.js";
import { AgentReviewPanel } from "../src/agent-review-panel.js";
import { createDelegationBudget } from "../src/agent-profile.js";
import { ChildAgentManager } from "../src/child-agent-manager.js";
import {
  approveCompanyBlueprintV2,
  compileCompanyBlueprintV2,
} from "../src/company-blueprint-v2.js";
import { CompanyGoalSupervisor } from "../src/company-goal-supervisor.js";
import { FileGitPatchArtifactStore } from "../src/file-git-patch-artifact-store.js";
import { FileCompanyBlueprintV2Store } from "../src/file-company-blueprint-v2-store.js";
import { GitPatchArtifactManager } from "../src/git-patch-artifacts.js";
import { GitWorktreeLeaseManager } from "../src/git-worktree-leases.js";
import { JsonlSessionStore } from "../src/jsonl-session-store.js";
import { JsonlCompanyGoalStore } from "../src/jsonl-company-goal-store.js";
import { JsonlTeamRunStore } from "../src/jsonl-team-run-store.js";
import { TeamRunOwnerLeaseManager } from "../src/team-run-owner-lease.js";
import {
  TEAM_APPLY_PERMISSION,
  TeamRunSupervisor,
} from "../src/team-run-supervisor.js";
import { createRootAgentDescriptor } from "../src/session-v2.js";
import { testAt, testBackendPin } from "../../../tests/support/backend.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function errorCode(error: unknown): string | number | null {
  return typeof error === "object" && error !== null && "code" in error &&
      (typeof error.code === "string" || typeof error.code === "number")
    ? error.code
    : null;
}

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"], { encoding: "utf8" });
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf8",
  })).stdout.trim();
}

const gitRunner: typeof runProcess = async (command, args, options) => {
  if (options.signal?.aborted === true) {
    throw new ToolError("cancelled", `${command} was cancelled`);
  }
  const processOptions = {
    cwd: options.cwd,
    signal: options.signal,
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes,
    encoding: "utf8" as const,
  };
  try {
    const result = options.stdin === undefined
      ? await execFileAsync(command, [...args], processOptions)
      : await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          const child = execFile(
            command,
            [...args],
            processOptions,
            (error, stdout, stderr) => {
              if (error === null) resolve({ stdout, stderr });
              else reject(Object.assign(error, { stdout, stderr }));
            },
          );
          child.stdin?.end(options.stdin);
        });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    if (options.signal?.aborted === true) {
      throw new ToolError("cancelled", `${command} was cancelled`, { cause: error });
    }
    const exitCode = errorCode(error);
    const numericExitCode = typeof exitCode === "number" ? exitCode : -1;
    if ((options.acceptableExitCodes ?? [0]).includes(numericExitCode)) {
      const stdout = typeof error === "object" && error !== null &&
          "stdout" in error && typeof error.stdout === "string"
        ? error.stdout
        : "";
      const stderr = typeof error === "object" && error !== null &&
          "stderr" in error && typeof error.stderr === "string"
        ? error.stderr
        : "";
      return { stdout, stderr, exitCode: numericExitCode };
    }
    throw new ToolError(
      "process_failed",
      `${command} exited with ${numericExitCode}`,
      { cause: error },
    );
  }
};

function idSequence(prefix: string): () => string {
  let next = 0;
  return () => `${prefix}-${++next}`;
}

describe("TeamRunSupervisor Git integration", () => {
  it("applies two isolated worker patches through one durable approved candidate", async (test) => {
    if (!await gitAvailable()) {
      test.skip();
      return;
    }

    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "recurs-team-supervisor-git-")),
    );
    directories.push(root);
    const repository = path.join(root, "repository");
    await mkdir(repository);
    await git(repository, ["init", "--quiet"]);
    await writeFile(path.join(repository, "alpha.txt"), "alpha before\n", "utf8");
    await writeFile(path.join(repository, "beta.txt"), "beta before\n", "utf8");
    await git(repository, ["add", "--", "alpha.txt", "beta.txt"]);
    await git(repository, [
      "-c", "user.name=Recurs Tests",
      "-c", "user.email=tests@recurs.invalid",
      "commit", "--quiet", "-m", "initial",
    ]);
    const revision = await git(repository, ["rev-parse", "HEAD"]);

    const sessions = new JsonlSessionStore(path.join(root, "sessions"));
    const runs = new JsonlTeamRunStore(path.join(root, "team-runs"));
    const worktreeRoot = path.join(root, "worktrees");
    const worktrees = new GitWorktreeLeaseManager({
      rootDirectory: worktreeRoot,
      createId: idSequence("lease"),
      processRunner: gitRunner,
    });
    const patches = new GitPatchArtifactManager({
      createId: idSequence("patch"),
      processRunner: gitRunner,
      leases: worktrees,
      store: new FileGitPatchArtifactStore(path.join(root, "patch-artifacts")),
    });
    const checkpoints = new FileCheckpointStore(path.join(root, "checkpoints"));
    const router = new AgentBackendRouter();
    const pin = testBackendPin("team-integration-model");
    let parent = await sessions.createPinnedSession({
      id: "parent-session",
      cwd: repository,
      backend: pin,
      at: testAt,
    });
    const mode = getOperatingModePolicy("balanced_v4");
    await sessions.withSessionMutation(
      parent.id,
      parent.lastSequence,
      async (lease) => {
        await lease.append({
          type: "mode_updated",
          source: "command",
          executionMode: "act",
          permissionMode: "approved_for_me",
          at: testAt,
        });
        await lease.append({
          type: "agent_policy_updated",
          operatingModeId: mode.id,
          operatingModeVersion: mode.version,
          at: testAt,
        });
      },
    );
    parent = await sessions.loadState(parent.id) as typeof parent;

    const coordinator: RunCoordinator = {
      async start(input: CoordinatedRunInput) {
        const child = await sessions.loadState(input.sessionId);
        if (child.version !== 2 || child.agent.role !== "child" ||
          child.agent.team === undefined || child.agent.workspace === undefined) {
          throw new Error("Expected a durable isolated team child");
        }
        const correlation = child.agent.team;
        const turnId = `turn-${child.id}`;
        await sessions.withSessionMutation(
          child.id,
          child.lastSequence,
          async (lease) => {
            await lease.append({
              type: "turn_started",
              turnId,
              prompt: input.prompt,
              at: testAt,
            });
          },
        );

        let finalText: string;
        let changedFiles: readonly string[];
        if (correlation.role === "implement") {
          const file = correlation.taskIndex === 1 ? "alpha.txt" : "beta.txt";
          await writeFile(
            path.join(child.agent.workspace.worktreeRoot, file),
            correlation.taskIndex === 1
              ? "alpha implemented\n"
              : "beta implemented\n",
            "utf8",
          );
          finalText = `Implemented ${file}`;
          changedFiles = [file];
        } else if (correlation.role === "review") {
          finalText = JSON.stringify({
            verdict: "approve",
            summary: "The complete staged candidate satisfies the objective.",
            findings: [],
            evidence: ["Inspected both staged file changes."],
          });
          changedFiles = [];
        } else {
          throw new Error("This approved integration path must not repair");
        }
        const result: RunResult = {
          finalText,
          usage: { inputTokens: 5, outputTokens: 2, costUsd: 0.01 },
          usageSource: "provider",
          steps: 1,
          changedFiles,
          changedFilesSource: changedFiles.length === 0 ? "none" : "host_tools",
          evidence: [
            correlation.role === "review"
              ? "reviewed staged candidate"
              : `edited ${changedFiles[0]}`,
          ],
          evidenceSource: "host_tools",
        };
        const running = await sessions.loadState(child.id);
        await sessions.withSessionMutation(
          child.id,
          running.lastSequence ?? 0,
          async (lease) => {
            await lease.append({ type: "turn_completed", turnId, result, at: testAt });
          },
        );
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          outcome: Promise.resolve({ ok: true as const, result }),
        };
      },
    };
    const children = new ChildAgentManager({
      sessions,
      backendRouter: router,
      getCoordinator: () => coordinator,
      async emit() {},
      createId: idSequence("child"),
      now: () => testAt,
    });
    const supervisor = new TeamRunSupervisor({
      sessions,
      runs,
      owners: new TeamRunOwnerLeaseManager({ rootDirectory: root }),
      children,
      worktrees,
      patches,
      reviews: new AgentReviewPanel({ sessions, children }),
      router,
      checkpoints,
      backendCandidates(candidateParent) {
        return [{
          id: "parent",
          pin: candidateParent.backend.pin,
          parent: true,
          roles: ["implement", "review", "repair"],
          executionModes: ["act"],
          permissionModes: [candidateParent.permissionMode],
          hostTools: true,
          background: true,
          ready: true,
        }];
      },
      async emit() {},
      createId: idSequence("team"),
      now: () => testAt,
    });
    const context: ToolContext = {
      sessionId: parent.id,
      cwd: repository,
      executionMode: "act",
      signal: new AbortController().signal,
      readRevisions: new Map(),
      runContext: deriveTrustedRunContext(createHostInvocation({
        invocation: "repl",
        userPresent: true,
        remote: false,
        scripted: false,
        embedding: "cli",
      })),
      delegationBudget: createDelegationBudget(parent.agent),
    };

    const result = await supervisor.startForeground({
      description: "Update both independent files",
      tasks: [
        { description: "Update alpha", prompt: "Update only alpha.txt." },
        { description: "Update beta", prompt: "Update only beta.txt." },
      ],
      review: { instructions: "Review both staged changes together." },
    }, context);
    const state = await runs.load(result.metadata.teamId);

    expect(result.metadata).toMatchObject({
      status: "approved",
      repairRounds: 0,
      changedFiles: ["alpha.txt", "beta.txt"],
    });
    expect(state).toMatchObject({
      status: "approved",
      apply: { committed: true },
      candidate: { changedFiles: ["alpha.txt", "beta.txt"] },
    });
    expect(state.children.map((child) => child.reservation.role)).toEqual([
      "implement",
      "implement",
      "review",
    ]);
    expect(state.children.every((child) => child.result?.status === "completed"))
      .toBe(true);
    expect(await readFile(path.join(repository, "alpha.txt"), "utf8"))
      .toBe("alpha implemented\n");
    expect(await readFile(path.join(repository, "beta.txt"), "utf8"))
      .toBe("beta implemented\n");
    expect(await git(repository, ["diff", "--name-only", "--"])).toBe(
      "alpha.txt\nbeta.txt",
    );
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(revision);
    expect(await worktrees.recoverStale({ repositoryRoot: repository }))
      .toEqual({ removedLeaseIds: [], busyLeaseIds: [] });
    for (const leaseId of ["lease-1", "lease-2", "lease-3"]) {
      await expect(access(path.join(worktreeRoot, leaseId)))
        .rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await git(repository, ["worktree", "list", "--porcelain"]))
      .not.toContain(`${path.sep}worktrees${path.sep}lease-`);
  }, 20_000);

  it("runs lead to parallel builders to review, repair, apply, and company synthesis", async (test) => {
    if (!await gitAvailable()) {
      test.skip();
      return;
    }
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "recurs-company-team-integration-")),
    );
    directories.push(root);
    const repository = path.join(root, "repository");
    await mkdir(repository);
    await git(repository, ["init", "--quiet"]);
    await writeFile(path.join(repository, "alpha.txt"), "alpha before\n", "utf8");
    await writeFile(path.join(repository, "beta.txt"), "beta before\n", "utf8");
    await git(repository, ["add", "--", "alpha.txt", "beta.txt"]);
    await git(repository, [
      "-c", "user.name=Recurs Tests",
      "-c", "user.email=tests@recurs.invalid",
      "commit", "--quiet", "-m", "initial",
    ]);

    const blueprint = approveCompanyBlueprintV2(compileCompanyBlueprintV2({
      id: "company-blueprint-1",
      companyId: "company-1",
      revision: 1,
      previousBlueprintId: null,
      createdAt: "2026-07-21T23:59:00.000Z",
      onboardingRunId: "onboarding-1",
      onboardingDepth: "guided",
      generatedBy: "deterministic",
      designMode: "guardrailed_dynamic",
      project: {
        type: "existing_project",
        stage: "active",
        purpose: "Apply two independently reviewed file changes.",
        users: ["Maintainers"],
        successCriteria: ["Both changes pass independent review."],
        constraints: ["Use isolated worktrees."],
        risks: ["A boundary case may be missed."],
        architecturePreferences: ["Keep changes scoped."],
        deploymentTargets: ["CLI"],
        repository: {
          inspected: true,
          markers: [".git"],
          evidence: [{ path: ".git", finding: "A Git repository is present." }],
        },
      },
      permissionMode: "approved_for_me",
      operatingModeId: "balanced_v6",
      organization: {
        departments: [{
          key: "delivery",
          displayName: "Delivery",
          purpose: "Plan and implement bounded changes.",
        }, {
          key: "quality",
          displayName: "Quality",
          purpose: "Review the complete staged candidate independently.",
        }],
        roles: [{
          key: "root",
          displayName: "Root Orchestrator",
          kind: "orchestrator",
          departmentKey: "delivery",
          responsibility: "Own the company goal and budget.",
          instructions: "Delegate only through the approved graph.",
          reportsToKey: null,
          capabilities: ["plan"],
          executionProfileId: null,
          permissionMode: "approved_for_me",
          toolBundles: ["project_context_v1"],
          expectedEvidence: ["A complete synthesis."],
          activation: "always",
        }, {
          key: "lead",
          displayName: "Engineering Lead",
          kind: "lead",
          departmentKey: "delivery",
          responsibility: "Prepare the bounded implementation handoff.",
          instructions: "Return the exact file scope.",
          reportsToKey: "root",
          capabilities: ["plan", "research"],
          executionProfileId: "explore_v1",
          permissionMode: "approved_for_me",
          toolBundles: ["project_context_v1"],
          expectedEvidence: ["The target files."],
          activation: "always",
        }, {
          key: "alpha_builder",
          displayName: "Alpha Builder",
          kind: "worker",
          departmentKey: "delivery",
          responsibility: "Implement and repair alpha.txt.",
          instructions: "Change only alpha.txt.",
          reportsToKey: "lead",
          capabilities: ["implement", "repair"],
          executionProfileId: "implement_v2",
          permissionMode: "approved_for_me",
          toolBundles: ["implementation_v1", "source_control_v1"],
          expectedEvidence: ["The alpha.txt patch."],
          activation: "always",
        }, {
          key: "beta_builder",
          displayName: "Beta Builder",
          kind: "worker",
          departmentKey: "delivery",
          responsibility: "Implement beta.txt.",
          instructions: "Change only beta.txt.",
          reportsToKey: "lead",
          capabilities: ["implement"],
          executionProfileId: "implement_v2",
          permissionMode: "approved_for_me",
          toolBundles: ["implementation_v1", "source_control_v1"],
          expectedEvidence: ["The beta.txt patch."],
          activation: "always",
        }, {
          key: "reviewer",
          displayName: "Independent Reviewer",
          kind: "reviewer",
          departmentKey: "quality",
          responsibility: "Review every staged change.",
          instructions: "Request repair for the missing alpha boundary.",
          reportsToKey: "root",
          capabilities: ["review"],
          executionProfileId: "review_v2",
          permissionMode: "ask_always",
          toolBundles: ["quality_v1"],
          expectedEvidence: ["A staged-diff verdict."],
          activation: "always",
        }],
        rootRoleKey: "root",
        independentReviewRoleKeys: ["reviewer"],
        defaultActiveRoleKeys: [
          "root", "lead", "alpha_builder", "beta_builder", "reviewer",
        ],
      },
      availableToolBundles: [
        "project_context_v1", "source_control_v1", "implementation_v1",
        "quality_v1",
      ],
      initialGoal: "Apply and independently review both file changes.",
      roadmap: ["Complete the first company-directed implementation."],
    }), testAt);
    const roles = Object.fromEntries(blueprint.roles.map((role) => [
      role.displayName,
      role,
    ]));
    const sessions = new JsonlSessionStore(path.join(root, "sessions"));
    const blueprints = new FileCompanyBlueprintV2Store(path.join(root, "blueprints"));
    const goals = new JsonlCompanyGoalStore(path.join(root, "goals"));
    const runs = new JsonlTeamRunStore(path.join(root, "team-runs"));
    await blueprints.create(blueprint);
    const pin = testBackendPin("company-team-model");
    const parent = await sessions.createPinnedSession({
      id: "parent-session",
      cwd: repository,
      backend: pin,
      at: testAt,
      agent: createRootAgentDescriptor(
        "parent-session",
        pin,
        "balanced_v6",
        "approved_for_me",
        "act",
        {
          blueprintId: blueprint.id,
          blueprintVersion: 2,
          blueprintRevision: blueprint.revision,
          roleId: blueprint.authorityAnchors.rootRoleId,
          roleVersion: 1,
        },
      ),
    });
    const worktrees = new GitWorktreeLeaseManager({
      rootDirectory: path.join(root, "worktrees"),
      createId: idSequence("lease"),
      processRunner: gitRunner,
    });
    const patches = new GitPatchArtifactManager({
      createId: idSequence("patch"),
      processRunner: gitRunner,
      leases: worktrees,
      store: new FileGitPatchArtifactStore(path.join(root, "patch-artifacts")),
    });
    const checkpoints = new FileCheckpointStore(path.join(root, "checkpoints"));
    let reviewRound = 0;
    const observedRoles: string[] = [];
    const coordinator: RunCoordinator = {
      async start(input: CoordinatedRunInput) {
        const child = await sessions.loadState(input.sessionId);
        if (child.version !== 2 || child.agent.role !== "child") {
          throw new Error("Expected a company child");
        }
        const turnId = `turn-${child.id}`;
        await sessions.withSessionMutation(child.id, child.lastSequence, async (lease) => {
          await lease.append({ type: "turn_started", turnId, prompt: input.prompt, at: testAt });
        });
        const team = child.agent.team;
        let finalText = `Prepared ${child.agent.company?.roleId}`;
        let changedFiles: readonly string[] = [];
        if (team?.role === "implement") {
          const file = team.taskIndex === 1 ? "alpha.txt" : "beta.txt";
          await writeFile(
            path.join(child.agent.workspace!.worktreeRoot, file),
            team.taskIndex === 1
              ? "alpha implemented without boundary\n"
              : "beta implemented\n",
            "utf8",
          );
          changedFiles = [file];
          finalText = `Implemented ${file}`;
        } else if (team?.role === "repair") {
          await writeFile(
            path.join(child.agent.workspace!.worktreeRoot, "alpha.txt"),
            "alpha implemented with boundary\n",
            "utf8",
          );
          changedFiles = ["alpha.txt"];
          finalText = "Repaired alpha boundary";
        } else if (team?.role === "review") {
          const requestChanges = reviewRound++ === 0;
          finalText = JSON.stringify(requestChanges
            ? {
                verdict: "request_changes",
                summary: "The alpha boundary is missing.",
                findings: [{
                  path: "alpha.txt",
                  problem: "The boundary marker is absent.",
                  acceptance: "Add the alpha boundary marker.",
                  evidence: ["The staged alpha text says without boundary."],
                }],
                evidence: ["Inspected the complete staged candidate."],
              }
            : {
                verdict: "approve",
                summary: "The repaired candidate satisfies the goal.",
                findings: [],
                evidence: ["Verified the repaired alpha and beta changes."],
              });
        }
        observedRoles.push(team?.role ?? "lead");
        const result: RunResult = {
          finalText,
          usage: { inputTokens: 5, outputTokens: 2, costUsd: 0.01 },
          usageSource: "provider",
          steps: 1,
          changedFiles,
          changedFilesSource: changedFiles.length === 0 ? "none" : "host_tools",
          evidence: [team === undefined
            ? "Identified alpha.txt and beta.txt."
            : `${team.role} evidence for ${team.taskIndex}`],
          evidenceSource: "host_tools",
        };
        const running = await sessions.loadState(child.id);
        await sessions.withSessionMutation(
          child.id,
          running.lastSequence ?? 0,
          async (lease) => {
            await lease.append({ type: "turn_completed", turnId, result, at: testAt });
          },
        );
        return {
          events: { async *[Symbol.asyncIterator]() {} },
          outcome: Promise.resolve({ ok: true as const, result }),
        };
      },
    };
    const router = new AgentBackendRouter();
    const children = new ChildAgentManager({
      sessions,
      backendRouter: router,
      getCoordinator: () => coordinator,
      async emit() {},
      createId: idSequence("child"),
      now: () => testAt,
    });
    const team = new TeamRunSupervisor({
      sessions,
      runs,
      owners: new TeamRunOwnerLeaseManager({ rootDirectory: root }),
      children,
      worktrees,
      patches,
      reviews: new AgentReviewPanel({ sessions, children }),
      router,
      checkpoints,
      backendCandidates(candidateParent) {
        return [{
          id: "parent",
          pin: candidateParent.backend.pin,
          parent: true,
          roles: ["implement", "review", "repair"],
          executionModes: ["act"],
          permissionModes: [candidateParent.permissionMode],
          hostTools: true,
          background: true,
          ready: true,
        }];
      },
      async emit() {},
      createId: idSequence("team"),
      now: () => testAt,
    });
    const company = new CompanyGoalSupervisor({
      sessions,
      blueprints,
      runs: goals,
      children,
      team,
      async emit() {},
      createId: idSequence("company"),
      now: () => testAt,
    });
    const context: ToolContext = {
      sessionId: parent.id,
      cwd: repository,
      executionMode: "act",
      signal: new AbortController().signal,
      readRevisions: new Map(),
      runContext: deriveTrustedRunContext(createHostInvocation({
        invocation: "repl",
        userPresent: true,
        remote: false,
        scripted: false,
        embedding: "cli",
      })),
      delegationBudget: createDelegationBudget(parent.agent),
      approvedIntents: new Set([permissionIntentKey(TEAM_APPLY_PERMISSION)]),
    };

    const result = await company.start({
      objective: "Plan, implement, review, and repair alpha and beta.",
      assignments: [{
        id: "lead-assignment",
        roleId: roles["Engineering Lead"]!.id,
        parentAssignmentId: null,
        dependsOn: [],
        description: "Plan the bounded file changes",
        prompt: "Identify the two target files and hand off exact scope.",
        acceptance: ["Name alpha.txt and beta.txt."],
      }, {
        id: "alpha-assignment",
        roleId: roles["Alpha Builder"]!.id,
        parentAssignmentId: "lead-assignment",
        dependsOn: [],
        description: "Implement alpha",
        prompt: "Update alpha.txt only.",
        acceptance: ["alpha.txt contains the approved result."],
      }, {
        id: "beta-assignment",
        roleId: roles["Beta Builder"]!.id,
        parentAssignmentId: "lead-assignment",
        dependsOn: [],
        description: "Implement beta",
        prompt: "Update beta.txt only.",
        acceptance: ["beta.txt contains the approved result."],
      }, {
        id: "review-assignment",
        roleId: roles["Independent Reviewer"]!.id,
        parentAssignmentId: null,
        dependsOn: ["lead-assignment", "alpha-assignment", "beta-assignment"],
        description: "Review the staged candidate",
        prompt: "Review both files and require the alpha boundary marker.",
        acceptance: ["Approve only after the repair."],
      }],
    }, context);
    expect(result.output).toContain("Company goal completed");
    expect(observedRoles).toEqual([
      "lead", "implement", "implement", "review", "review", "repair", "review",
    ]);
    expect(await readFile(path.join(repository, "alpha.txt"), "utf8"))
      .toBe("alpha implemented with boundary\n");
    expect(await readFile(path.join(repository, "beta.txt"), "utf8"))
      .toBe("beta implemented\n");
    const goal = await goals.load("company-1");
    expect(goal.state).toMatchObject({
      status: "completed",
      budget: {
        assignmentsStarted: 4,
        requestsReserved: 66,
        requestsUsed: 7,
        reportedCostUsd: 0.07,
      },
    });
    expect(goal.state.plan.assignments.map((assignment) => assignment.status))
      .toEqual(["completed", "completed", "completed", "completed"]);
    expect(goal.state.plan.assignments.slice(1).every((assignment) =>
      assignment.execution !== undefined && "teamRunId" in assignment.execution
    )).toBe(true);
    const alpha = goal.state.plan.assignments.find(
      (assignment) => assignment.id === "alpha-assignment",
    );
    expect(alpha?.result?.evidence).toEqual(expect.arrayContaining([
      "implement evidence for 1",
      "repair evidence for 1",
    ]));
    expect(await git(repository, ["diff", "--name-only", "--"]))
      .toBe("alpha.txt\nbeta.txt");
  }, 30_000);
});
