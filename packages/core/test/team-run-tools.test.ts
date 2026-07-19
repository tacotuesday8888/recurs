import type { ToolContext } from "@recurs/tools";
import { ToolError } from "@recurs/tools";
import { describe, expect, it, vi } from "vitest";

import {
  TEAM_APPLY_PERMISSION,
  createTeamRunTools,
  type TeamRunSnapshot,
  type TeamRunSupervisor,
} from "../src/index.js";

const snapshot: TeamRunSnapshot = Object.freeze({
  id: "team-1",
  execution: "background",
  operatingModeId: "balanced_v4",
  status: "ready_to_apply",
  phase: "review",
  round: 1,
  childrenReserved: 4,
  childrenFinished: 4,
  usage: { inputTokens: 10, outputTokens: 5 },
  reportedCostUsd: 0.02,
  costCoverage: "complete",
  manualAttentionRequired: false,
  updatedAt: "2026-07-18T00:00:00.000Z",
});

function fixture() {
  const status = vi.fn(async (_parent: string, id: string) => {
    if (id === "foreign") throw new ToolError("not_found", "Team run not found");
    return snapshot;
  });
  const wait = vi.fn(async () => ({ snapshot, timedOut: false }));
  const cancel = vi.fn(async () => ({ result: "requested" as const, snapshot }));
  const resume = vi.fn(async () => ({ result: "started" as const, snapshot }));
  const apply = vi.fn(async () => ({
    output: "Team team-1: approved",
    metadata: {
      teamId: "team-1",
      status: "approved" as const,
      operatingModeId: "balanced_v4" as const,
      repairRounds: 1,
      accounting: {
        childrenReserved: 4,
        childrenFinished: 4,
        requestsReserved: 32,
        requestsUsed: 4,
        usage: null,
        usageReportedChildren: 0,
        usageMissingChildren: 4,
        reportedCostUsd: null,
        costReportedChildren: 0,
        costMissingChildren: 4,
        costCoverage: "none" as const,
      },
      changedFiles: ["src/value.ts"],
      evidence: [],
    },
  }));
  const controls = { status, wait, cancel, resume, apply } satisfies Pick<
    TeamRunSupervisor,
    "status" | "wait" | "cancel" | "resume" | "apply"
  >;
  const tools = createTeamRunTools(controls);
  const byName = (name: string) => {
    const found = tools.find((tool) => tool.definition.name === name);
    if (found === undefined) throw new Error(`Missing ${name}`);
    return found;
  };
  const context: ToolContext = {
    sessionId: "parent-session",
    cwd: "/workspace",
    executionMode: "act",
    signal: new AbortController().signal,
    readRevisions: new Map(),
  };
  return { tools, byName, context, controls };
}

describe("team run model controls", () => {
  it("exposes only the five exact scoped controls with truthful mutation classes", () => {
    const { tools, byName, context } = fixture();
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "team_status",
      "wait_team",
      "cancel_team",
      "resume_team",
      "apply_team",
    ]);
    for (const name of ["team_status", "wait_team", "cancel_team"]) {
      expect(byName(name).mutating).toBe(false);
    }
    for (const name of ["resume_team", "apply_team"]) {
      expect(byName(name)).toMatchObject({
        mutating: true,
        executionClass: "in_process",
        checkpointOwnership: "self_managed",
      });
    }
    expect(byName("apply_team").permissions({ id: "team-1" }, context))
      .toEqual([TEAM_APPLY_PERMISSION]);
  });

  it("parses exact bounded IDs, waits, and cancellation reasons", () => {
    const { byName } = fixture();
    expect(byName("team_status").parse({ id: "team-1" })).toEqual({ id: "team-1" });
    expect(() => byName("team_status").parse({ id: "team-1", extra: true }))
      .toThrow("unexpected fields");
    expect(byName("wait_team").parse({ id: "team-1", timeoutMs: 30_000 }))
      .toEqual({ id: "team-1", timeoutMs: 30_000 });
    expect(() => byName("wait_team").parse({ id: "team-1", timeoutMs: 30_001 }))
      .toThrow("between 0 and 30000");
    expect(() => byName("cancel_team").parse({ id: "team-1", reason: "\n" }))
      .toThrow("reason is invalid");
  });

  it("scopes every lookup to the current parent and returns only safe snapshots", async () => {
    const { byName, context, controls } = fixture();
    const status = byName("team_status");
    const result = await status.execute(status.parse({ id: "team-1" }), context);
    expect(controls.status).toHaveBeenCalledWith("parent-session", "team-1");
    expect(result).toMatchObject({
      output: expect.stringContaining("Status: ready_to_apply"),
      metadata: { snapshot },
    });
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain("prompt");
    expect(rendered).not.toContain("repositoryRoot");
    await expect(status.execute(status.parse({ id: "foreign" }), context))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("forwards wait, cancel, resume, and apply with exact parent context", async () => {
    const { byName, context, controls } = fixture();
    const wait = byName("wait_team");
    await wait.execute(wait.parse({ id: "team-1", timeoutMs: 12 }), context);
    expect(controls.wait).toHaveBeenCalledWith(
      "parent-session",
      "team-1",
      12,
      context.signal,
    );
    const cancel = byName("cancel_team");
    await cancel.execute(cancel.parse({ id: "team-1", reason: "No longer needed" }), context);
    expect(controls.cancel).toHaveBeenCalledWith(
      "parent-session",
      "team-1",
      "No longer needed",
    );
    const resume = byName("resume_team");
    await resume.execute(resume.parse({ id: "team-1" }), context);
    expect(controls.resume).toHaveBeenCalledWith("parent-session", "team-1", context);
    const apply = byName("apply_team");
    await apply.execute(apply.parse({ id: "team-1" }), context);
    expect(controls.apply).toHaveBeenCalledWith("parent-session", "team-1", context);
  });
});
