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
  parseAgentReviewVerdictV2,
  repairPrompt,
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
      requestsUsed: 1,
      evidenceSource: "host_tools",
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

function reviewPolicy(modeId: OperatingModeId) {
  const mode = getOperatingModePolicy(modeId);
  const team = mode.workflow.team;
  if (mode.version !== 4 || team === null) {
    throw new Error("Expected a version-4 team policy");
  }
  return {
    operatingModeId: mode.id,
    operatingModeVersion: 4 as const,
    qualityStandard: team.qualityStandard,
    initialReviewers: team.initialReviewers,
    maxReviewers: team.maxReviewers,
  };
}

function v2ChildResult(
  output: string,
  index: number,
  hostEvidence: readonly string[] = [`host evidence ${index}`],
  operatingModeId: OperatingModeId = "balanced_v4",
  evidenceSource: ChildDelegationResult["metadata"]["evidenceSource"] =
    "host_tools",
): ChildDelegationResult {
  const result = childResult(output, index);
  return {
    ...result,
    metadata: {
      ...result.metadata,
      operatingModeId,
      profileId: "review_v2",
      evidenceSource,
      evidence: [...hostEvidence],
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

describe("parseAgentReviewVerdictV2", () => {
  const finding = {
    path: "src/cache.ts",
    problem: "The empty namespace bypasses isolation.",
    acceptance: "Reject or isolate the empty namespace.",
    evidence: ["src/cache.ts:42 reaches the shared key"],
  } as const;

  it("accepts exact structured findings and finding-free approvals", () => {
    expect(parseAgentReviewVerdictV2(JSON.stringify({
      verdict: "request_changes",
      summary: "The empty namespace remains unsafe.",
      findings: [finding],
      evidence: ["src/cache.ts:42"],
    }))).toEqual({
      verdict: "request_changes",
      summary: "The empty namespace remains unsafe.",
      findings: [finding],
      evidence: ["src/cache.ts:42"],
    });
    expect(parseAgentReviewVerdictV2(JSON.stringify({
      verdict: "approve",
      summary: "The staged change satisfies the objective.",
      findings: [],
      evidence: ["test/cache.test.ts covers empty namespaces"],
    })).findings).toEqual([]);
  });

  it.each([
    {
      verdict: "approve",
      summary: "Approval cannot carry repairs.",
      findings: [finding],
      evidence: ["proof"],
    },
    {
      verdict: "request_changes",
      summary: "A change request needs a repair contract.",
      findings: [],
      evidence: ["proof"],
    },
    {
      verdict: "request_changes",
      summary: "Unsafe path.",
      findings: [{ ...finding, path: "../secret" }],
      evidence: ["proof"],
    },
    {
      verdict: "request_changes",
      summary: "Credential path.",
      findings: [{ ...finding, path: ".env" }],
      evidence: ["proof"],
    },
    {
      verdict: "request_changes",
      summary: "Too many findings.",
      findings: Array.from({ length: 13 }, (_, index) => ({
        ...finding,
        path: `src/file-${index}.ts`,
      })),
      evidence: ["proof"],
    },
  ])("rejects an unsafe or inconsistent structured verdict", (verdict) => {
    expect(() => parseAgentReviewVerdictV2(JSON.stringify(verdict)))
      .toThrow(/verdict contract/u);
  });
});

describe("repairPrompt", () => {
  it("encodes deterministic bounded repair data without host paths", () => {
    const findings = [{
      path: "src/cache.ts",
      problem: "The empty namespace bypasses isolation.",
      acceptance: "Reject or isolate the empty namespace.",
      evidence: ["src/cache.ts:42 reaches the shared key"],
    }] as const;
    const prompt = repairPrompt({
      objective: "Keep cache namespaces isolated.",
      changedFiles: ["src/cache.ts", "test/cache.test.ts"],
      findings,
      round: 1,
      maximumRounds: 2,
    });

    expect(prompt).toContain("Repair round 1 of 2");
    expect(prompt).toContain(JSON.stringify(findings));
    expect(prompt).toContain("change only the staged candidate");
    expect(prompt).toContain("Do not delegate, execute processes, use network resources");
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(32_768);
    expect(repairPrompt({
      objective: "Keep cache namespaces isolated.",
      changedFiles: ["src/cache.ts", "test/cache.test.ts"],
      findings,
      round: 1,
      maximumRounds: 2,
    })).toBe(prompt);
    const unicode = repairPrompt({
      objective: "Repair deterministic ordering.",
      changedFiles: ["ä.ts", "z.ts"],
      findings: [{
        path: "ä.ts",
        problem: "Ordering differs by locale.",
        acceptance: "Use stable code-unit ordering.",
        evidence: ["ö evidence", "a evidence"],
      }],
      round: 1,
      maximumRounds: 1,
    });
    expect(unicode).toContain('"changedFiles":["z.ts","ä.ts"]');
    expect(unicode).toContain('"evidence":["a evidence","ö evidence"]');
    const reorderedFinding = {
      evidence: [...findings[0].evidence],
      acceptance: findings[0].acceptance,
      problem: findings[0].problem,
      path: findings[0].path,
    };
    expect(repairPrompt({
      objective: "Keep cache namespaces isolated.",
      changedFiles: ["src/cache.ts", "test/cache.test.ts"],
      findings: [reorderedFinding],
      round: 1,
      maximumRounds: 2,
    })).toBe(prompt);
  });

  it("rejects invalid rounds and oversized aggregate findings", () => {
    const finding = {
      path: "src/cache.ts",
      problem: "x".repeat(20_000),
      acceptance: "y".repeat(20_000),
      evidence: ["src/cache.ts:42"],
    } as const;
    expect(() => repairPrompt({
      objective: "Repair cache isolation.",
      changedFiles: ["src/cache.ts"],
      findings: [finding],
      round: 1,
      maximumRounds: 1,
    })).toThrow(/repair prompt/u);
    expect(() => repairPrompt({
      objective: "Repair cache isolation.",
      changedFiles: ["src/cache.ts"],
      findings: [],
      round: 0,
      maximumRounds: 1,
    })).toThrow(/repair prompt/u);
  });
});

describe("AgentReviewPanel", () => {
  it("runs structured v2 review through the supervisor-owned delegation port", async () => {
    const setup = await harness("economy_v4", []);
    const calls: Array<{ index: number; profile: string; prompt: string }> = [];
    const result = await setup.panel.run(task, setup.context, {
      contract: "v2",
      policy: reviewPolicy("economy_v4"),
      async delegateReviewer(index, input) {
        calls.push({ index, profile: input.profile, prompt: input.prompt });
        return v2ChildResult(JSON.stringify({
          verdict: "approve",
          summary: "The staged candidate satisfies the objective.",
          findings: [],
          evidence: ["test/cache.test.ts covers isolation"],
        }), index, undefined, "economy_v4");
      },
    });

    expect(result).toMatchObject({
      contract: "v2",
      verdict: "approved",
      findings: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ index: 1, profile: "review_v2" });
    expect(calls[0]?.prompt).toContain("supplied staging workspace");
    expect(calls[0]?.prompt).toContain('"findings"');
    expect(calls[0]?.prompt).not.toContain(setup.context.cwd);
    expect(setup.calls).toHaveLength(0);
  });

  it("aggregates bounded structured findings only when every required review is valid", async () => {
    const setup = await harness("standard_v4", []);
    const outputs = [
      v2ChildResult(JSON.stringify({
        verdict: "request_changes",
        summary: "The empty namespace is unsafe.",
        findings: [{
          path: "src/cache.ts",
          problem: "The empty namespace reaches the shared key.",
          acceptance: "Reject or isolate empty namespaces.",
          evidence: ["src/cache.ts:42"],
        }],
        evidence: ["src/cache.ts:42"],
      }), 1, undefined, "standard_v4"),
      v2ChildResult(JSON.stringify({
        verdict: "approve",
        summary: "No additional issue was found.",
        findings: [],
        evidence: ["test/cache.test.ts covers non-empty namespaces"],
      }), 2, undefined, "standard_v4"),
    ];
    let cursor = 0;
    const result = await setup.panel.run(task, setup.context, {
      contract: "v2",
      policy: reviewPolicy("standard_v4"),
      async delegateReviewer() {
        return outputs[cursor++]!;
      },
    });

    expect(result).toMatchObject({
      contract: "v2",
      verdict: "changes_requested",
      escalated: true,
      findings: [{
        path: "src/cache.ts",
        acceptance: "Reject or isolate empty namespaces.",
      }],
    });
    expect(result.evidence).toEqual([
      "src/cache.ts:42",
      "host evidence 1",
      "test/cache.test.ts covers non-empty namespaces",
      "host evidence 2",
    ]);
  });

  it("fails structured review closed on invalid output or missing host evidence", async () => {
    for (const output of [
      v2ChildResult("not json", 1, undefined, "economy_v4"),
      v2ChildResult(JSON.stringify({
        verdict: "approve",
        summary: "Model-only evidence is insufficient.",
        findings: [],
        evidence: ["model assertion"],
      }), 1, [], "economy_v4"),
      v2ChildResult(JSON.stringify({
        verdict: "approve",
        summary: "Runtime-only evidence is insufficient.",
        findings: [],
        evidence: ["runtime assertion"],
      }), 1, ["runtime evidence"], "economy_v4", "runtime"),
    ]) {
      const setup = await harness("economy_v4", []);
      const result = await setup.panel.run(task, setup.context, {
        contract: "v2",
        policy: reviewPolicy("economy_v4"),
        async delegateReviewer() { return output; },
      });
      expect(result).toMatchObject({
        contract: "v2",
        verdict: "unverified",
        findings: [],
      });
      expect(result.reviews[0]?.status).toBe("invalid");
    }
  });

  it("keeps invalid review precedence and propagates durable callback failures", async () => {
    const mixed = await harness("standard_v4", []);
    const outputs = [
      v2ChildResult("not json", 1, undefined, "standard_v4"),
      v2ChildResult(JSON.stringify({
        verdict: "request_changes",
        summary: "A repair is required.",
        findings: [{
          path: "src/cache.ts",
          problem: "The shared key remains reachable.",
          acceptance: "Isolate the shared key.",
          evidence: ["src/cache.ts:42"],
        }],
        evidence: ["src/cache.ts:42"],
      }), 2, undefined, "standard_v4"),
    ];
    let cursor = 0;
    const result = await mixed.panel.run(task, mixed.context, {
      contract: "v2",
      policy: reviewPolicy("standard_v4"),
      async delegateReviewer() { return outputs[cursor++]!; },
    });
    expect(result).toMatchObject({
      contract: "v2",
      verdict: "unverified",
      findings: [],
    });

    const durableFailure = await harness("economy_v4", []);
    await expect(durableFailure.panel.run(task, durableFailure.context, {
      contract: "v2",
      policy: reviewPolicy("economy_v4"),
      async delegateReviewer() {
        throw new Error("journal append failed");
      },
    })).rejects.toThrow("journal append failed");
  });

  it("uses the canonical frozen policy and rejects reviewer metadata mismatches", async () => {
    const setup = await harness("economy_v4", []);
    await expect(setup.panel.run(task, setup.context, {
      contract: "v2",
      policy: { ...reviewPolicy("standard_v4"), maxReviewers: 99 },
      async delegateReviewer() {
        throw new Error("must not delegate");
      },
    })).rejects.toThrow(/frozen team policy/u);

    const frozen = await setup.panel.run(task, setup.context, {
      contract: "v2",
      policy: reviewPolicy("balanced_v4"),
      async delegateReviewer(index) {
        return v2ChildResult(JSON.stringify({
          verdict: "approve",
          summary: "The frozen balanced policy remains authoritative.",
          findings: [],
          evidence: ["model evidence"],
        }), index, ["host evidence"], "balanced_v4");
      },
    });
    expect(frozen).toMatchObject({
      contract: "v2",
      operatingModeId: "balanced_v4",
      verdict: "approved",
    });

    const mismatched = await setup.panel.run(task, setup.context, {
      contract: "v2",
      policy: reviewPolicy("economy_v4"),
      async delegateReviewer(index) {
        return v2ChildResult(JSON.stringify({
          verdict: "approve",
          summary: "The reviewer metadata is mismatched.",
          findings: [],
          evidence: ["model evidence"],
        }), index, ["host evidence"], "balanced_v4");
      },
    });
    expect(mismatched).toMatchObject({
      contract: "v2",
      verdict: "unverified",
      findings: [],
    });
    expect(mismatched.reviews[0]?.status).toBe("invalid");
  });

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
