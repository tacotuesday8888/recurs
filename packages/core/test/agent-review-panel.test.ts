import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createHostInvocation,
  deriveTrustedRunContext,
  getOperatingModePolicy,
  type OperatingModeId,
} from "@recurs/contracts";
import {
  ToolError,
  type ToolContext,
} from "@recurs/tools";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgentReviewPanel,
  JsonlSessionStore,
  createDelegationBudget,
  parseAgentReviewVerdict,
  type ChildAgentManager,
  type ChildDelegationOptions,
  type ChildDelegationResult,
} from "../src/index.js";
import { testAt, testBackendPin } from "../../../tests/support/backend.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function childResult(output: string, index: number): ChildDelegationResult {
  return {
    output,
    metadata: {
      childAgentId: `review-agent-${index}`,
      childSessionId: `review-session-${index}`,
      taskId: `review-task-${index}`,
      attempts: 1,
      retries: 0,
      operatingModeId: "balanced_v3",
      profileId: "review_v1",
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      usageSource: "provider",
      changedFiles: [],
      evidence: [`child evidence ${index}`],
      costLimitUsd: 3,
      costLimitExceeded: false,
      workflow: {
        childrenStarted: index,
        maxChildren: 4,
        requestsReserved: index * 8,
        requestsUsed: index,
        maxRequests: 32,
        reportedCostUsd: index * 0.01,
        maxReportedCostUsd: 3,
      },
    },
  };
}

async function harness(
  modeId: OperatingModeId,
  outcomes: Array<ChildDelegationResult | Error>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "recurs-review-panel-"));
  directories.push(root);
  const sessions = new JsonlSessionStore(path.join(root, "sessions"));
  let parent = await sessions.createPinnedSession({
    id: "review-parent",
    cwd: root,
    backend: testBackendPin(),
    at: testAt,
  });
  const mode = getOperatingModePolicy(modeId);
  await sessions.withSessionMutation(parent.id, parent.lastSequence, async (lease) => {
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
  });
  parent = await sessions.loadState(parent.id) as typeof parent;
  const calls: Array<{
    description: string;
    prompt: string;
    options?: ChildDelegationOptions;
  }> = [];
  let index = 0;
  const children: Pick<ChildAgentManager, "delegate"> = {
    async delegate(input, _context, options) {
      calls.push({ description: input.description, prompt: input.prompt, options });
      const outcome = outcomes[index++];
      if (outcome === undefined) throw new Error("review outcome exhausted");
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  const context: ToolContext = {
    sessionId: parent.id,
    cwd: parent.cwd,
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
  return {
    panel: new AgentReviewPanel({ sessions, children }),
    calls,
    context,
  };
}

const task = {
  description: "Review cache isolation",
  instructions: "Check behavior, tests, and security regressions.",
  changedFiles: ["src/cache.ts", "test/cache.test.ts"],
} as const;

describe("parseAgentReviewVerdict", () => {
  it("accepts only exact bounded JSON with evidence", () => {
    expect(parseAgentReviewVerdict(JSON.stringify({
      verdict: "approve",
      summary: "The change is scoped and verified.",
      evidence: ["cache.test.ts covers namespace isolation"],
    }))).toEqual({
      verdict: "approve",
      summary: "The change is scoped and verified.",
      evidence: ["cache.test.ts covers namespace isolation"],
    });
    expect(parseAgentReviewVerdict(JSON.stringify({
      verdict: "request_changes",
      summary: "A regression remains.",
      evidence: ["cache.test.ts omits the empty namespace case"],
    }))).toMatchObject({ verdict: "request_changes" });
  });

  it.each([
    "```json\n{\"verdict\":\"approve\"}\n```",
    JSON.stringify({ verdict: "approve", summary: "ok", evidence: [] }),
    JSON.stringify({ verdict: "approve", summary: "ok", evidence: ["proof"], extra: true }),
    JSON.stringify({ verdict: "maybe", summary: "ok", evidence: ["proof"] }),
    JSON.stringify({ verdict: "approve", summary: "", evidence: ["proof"] }),
    JSON.stringify({ verdict: "approve", summary: "x".repeat(1001), evidence: ["proof"] }),
    JSON.stringify({ verdict: "approve", summary: "ok", evidence: ["x".repeat(513)] }),
    "x".repeat(8193),
  ])("rejects malformed or unbounded output", (output) => {
    expect(() => parseAgentReviewVerdict(output)).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });
});

describe("AgentReviewPanel", () => {
  it("stops after the initial unanimous approvals selected by the mode", async () => {
    const approve = (index: number) => childResult(JSON.stringify({
      verdict: "approve",
      summary: `Reviewer ${index} approved.`,
      evidence: [`verification ${index} passed`],
    }), index);
    const setup = await harness("performance_v3", [approve(1), approve(2)]);

    const result = await setup.panel.run(task, setup.context, {
      team: { id: "team-1", indexOffset: 2 },
    });

    expect(result).toMatchObject({
      verdict: "approved",
      qualityStandard: "thorough",
      initialReviewers: 2,
      maxReviewers: 3,
      escalated: false,
    });
    expect(result.reviews).toHaveLength(2);
    expect(result.evidence).toEqual([
      "verification 1 passed",
      "child evidence 1",
      "verification 2 passed",
      "child evidence 2",
    ]);
    expect(setup.calls).toHaveLength(2);
    expect(setup.calls[0]?.prompt).toContain("Return exactly one JSON object");
    expect(setup.calls[0]?.prompt).toContain("thorough");
    expect(setup.calls[0]?.prompt).toContain("src/cache.ts");
    expect(setup.calls[0]?.prompt).toContain(
      "inspect the uncommitted parent-workspace diff, relevant files, and existing Implement evidence",
    );
    expect(setup.calls[0]?.prompt).toContain(
      "Do not execute repository code or create verification artifacts.",
    );
    expect(setup.calls[0]?.prompt).not.toContain("run only relevant fixed verification");
    expect(setup.calls.map((call) => call.options?.team)).toEqual([
      { id: "team-1", index: 3 },
      { id: "team-1", index: 4 },
    ]);
  });

  it("preserves bounded multi-line review instructions in the reviewer prompt", async () => {
    const setup = await harness("economy_v3", [childResult(JSON.stringify({
      verdict: "approve",
      summary: "The requested checks passed.",
      evidence: ["Targeted verification passed"],
    }), 1)]);

    const result = await setup.panel.run({
      ...task,
      instructions: "Check the public behavior.\nRun the targeted regression test.",
    }, setup.context);

    expect(result.verdict).toBe("approved");
    expect(setup.calls[0]?.prompt).toContain(
      "Check the public behavior.\nRun the targeted regression test.",
    );
  });

  it("escalates malformed and failed reviews to the mode maximum without approving", async () => {
    const setup = await harness("performance_v3", [
      childResult("not json", 1),
      new ToolError("execution_failed", "Reviewer two failed"),
      childResult(JSON.stringify({
        verdict: "approve",
        summary: "The final reviewer approved.",
        evidence: ["targeted verification passed"],
      }), 3),
    ]);

    const result = await setup.panel.run(task, setup.context);

    expect(result).toMatchObject({
      verdict: "unverified",
      escalated: true,
      initialReviewers: 2,
      maxReviewers: 3,
    });
    expect(result.reviews.map((review) => review.status)).toEqual([
      "invalid",
      "failed",
      "completed",
    ]);
    expect(setup.calls).toHaveLength(3);
  });

  it("preserves any concrete change request after adaptive corroboration", async () => {
    const setup = await harness("standard_v3", [
      childResult(JSON.stringify({
        verdict: "request_changes",
        summary: "The empty namespace case is missing.",
        evidence: ["No empty-namespace test exists"],
      }), 1),
      childResult(JSON.stringify({
        verdict: "approve",
        summary: "The main case passes.",
        evidence: ["Main cache test passed"],
      }), 2),
    ]);

    const result = await setup.panel.run(task, setup.context);

    expect(result).toMatchObject({
      verdict: "changes_requested",
      escalated: true,
      initialReviewers: 1,
      maxReviewers: 2,
    });
    expect(result.reviews).toHaveLength(2);
  });

  it("stops truthfully on budget exhaustion and propagates cancellation", async () => {
    const exhausted = await harness("max_v3", [
      new ToolError("permission_denied", "Agent child limit reached (8)"),
    ]);
    const result = await exhausted.panel.run(task, exhausted.context);
    expect(result).toMatchObject({ verdict: "unverified", escalated: true });
    expect(result.reviews).toHaveLength(1);
    expect(exhausted.calls).toHaveLength(1);

    const cancelled = await harness("economy_v3", [
      new ToolError("cancelled", "Parent cancelled"),
    ]);
    await expect(cancelled.panel.run(task, cancelled.context)).rejects
      .toMatchObject({ code: "cancelled" });
  });

  it("rejects Plan parents, historical modes, and unbounded task input", async () => {
    const plan = await harness("balanced_v3", []);
    await expect(plan.panel.run(task, { ...plan.context, executionMode: "plan" }))
      .rejects.toMatchObject({ code: "plan_mode_denied" });
    const historical = await harness("balanced_v2", []);
    await expect(historical.panel.run(task, historical.context)).rejects
      .toMatchObject({ code: "tool_unavailable" });
    await expect(plan.panel.run({
      ...task,
      changedFiles: Array.from({ length: 257 }, (_, index) => `file-${index}.ts`),
    }, plan.context)).rejects.toMatchObject({ code: "invalid_input" });
  });
});
