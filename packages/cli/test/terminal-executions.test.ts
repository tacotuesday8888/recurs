import { describe, expect, it } from "vitest";
import type { AgentExecution, RecursEvent } from "@recurs/core";
import { companyBlueprintV2Fixture } from "../../contracts/test/company-v2-fixture.js";
import { TerminalUiState, renderCompanyHome } from "../src/terminal-ui-state.js";

function started(id: string, parentSessionId = "root-session", parentAgentId = "root-agent"): Extract<RecursEvent, { type: "agent_started" }> {
  return { type: "agent_started", sessionId: parentSessionId, at: "2026-09-09T00:00:00.000Z", parentAgentId, childAgentId: `${id}-agent`, childSessionId: id, taskId: `${id}-task`, description: `Task ${id}`, operatingModeId: "balanced_v6", profileId: "explore_v1", modelId: "worker-model", reasoningEffort: "high" };
}

describe("terminal execution identities", () => {
  it("keeps repeated profiles distinct in the actual tree", async () => {
    const state = new TerminalUiState({ model: "root-model", mode: "act", permission: "ask" });
    await state.emit(started("one"));
    await state.emit(started("two"));
    await state.emit(started("nested", "one", "one-agent"));
    const snapshot = state.snapshot();
    expect(snapshot.company.map((node) => node.roleId)).toEqual(["parent", "one", "nested", "two"]);
    expect(snapshot.company.find((node) => node.roleId === "nested")).toMatchObject({ reportsToRoleId: "one", representativeExecutionId: "nested" });
    expect(renderCompanyHome(snapshot, 100, 0).join("\n")).toContain("3 child executions");
    expect(renderCompanyHome(snapshot, 100, 0).join("\n")).not.toContain("configured roles");
  });

  it("scopes role outcomes and active counts to the displayed goal while retaining history", async () => {
    const blueprint = companyBlueprintV2Fixture();
    const roleId = "scoped_builder";
    const state = new TerminalUiState({ model: "root-model", mode: "act", permission: "ask" }, blueprint);
    const execution = (id: string, status: AgentExecution["status"], goal: string | null, at: string): AgentExecution => ({
      executionId: id, parentExecutionId: "root-session", agentId: id, roleId, roleName: "Builder", profileId: "implement_v2", description: id,
      depth: 1, model: "worker", effort: null, permissions: { executionMode: "act", parentExecutionMode: "act", permissionMode: "ask_always", parentPermissionMode: "ask_always" },
      limits: { maxDepth: 2, maxConcurrentChildren: 1, maxRetries: 0, maxRequests: 8, maxReportedCostUsd: 1 },
      status, recordedStatus: status === "unknown" ? "running" : status, updatedAt: at, usage: null, changedFiles: [], evidence: [], detail: null, teamRunId: null, companyGoalRunId: goal,
      capabilities: { cancel: status === "running", send: false, reason: "test" },
    });
    state.restoreExecutions([
      execution("old-failure", "failed", "old-goal", "2026-09-08T00:00:00Z"),
      execution("unrelated-live", "running", null, "2026-09-09T00:00:00Z"),
      execution("z-first", "unknown", "next-goal", "2026-09-09T01:00:00Z"),
      execution("a-latest", "completed", "next-goal", "2026-09-09T02:00:00Z"),
    ]);
    await state.emit({ type: "company_goal_started", sessionId: "root-session", at: "2026-09-09T00:00:01.000Z", parentAgentId: "root-agent", goalRunId: "next-goal", objective: "Next work", blueprintId: blueprint.id, blueprintRevision: 1, operatingModeId: "balanced_v6", assignmentCount: 1, topology: "hierarchical", maxActiveAgents: 4, maxConcurrentAgents: 2, maxDelegationDepth: 2, maxRepairRounds: 1, maxRequests: 20, maxReportedCostUsd: 2 });
    const snapshot = state.snapshot();
    expect(snapshot.agents).toHaveLength(4);
    expect(snapshot.goal?.activeAgents).toBe(0);
    expect(snapshot.company.find((node) => node.roleId === roleId)).toMatchObject({ status: "completed", representativeExecutionId: "a-latest", assignmentIds: ["z-first", "a-latest"] });
    expect(renderCompanyHome(snapshot, 120, 0).join("\n")).toContain("Goal limits: depth 2 · 4 active roles · 2 concurrent");
    for (const height of [1, 2, 4, 8, 12]) {
      const lines = renderCompanyHome(snapshot, 80, 0, undefined, height);
      expect(lines).toHaveLength(height);
      expect(lines.at(-1)).toContain("Ctrl+G chat");
    }
  });

  it("represents ordinary, batch and team execution events without company assignments", async () => {
    const state = new TerminalUiState({ model: "root-model", mode: "act", permission: "ask" });
    await state.emit(started("ordinary"));
    await state.emit({ ...started("batch"), batchId: "batch-run", batchIndex: 0 });
    await state.emit({ ...started("team"), teamId: "team-run", teamIndex: 0 });
    await state.emit(started("grandchild", "ordinary", "ordinary-agent"));
    const agents = state.snapshot().agents;
    expect(agents).toHaveLength(4);
    expect(agents.find((agent) => agent.executionId === "grandchild")).toMatchObject({ parentExecutionId: "ordinary", depth: 2, model: "worker-model" });
    await state.emit({ type: "agent_cancelled", sessionId: "root-session", at: "2026-09-09T00:00:01.000Z", parentAgentId: "root-agent", childAgentId: "ordinary-agent", childSessionId: "ordinary", profileId: "explore_v1", reason: "User cancelled" });
    expect(state.snapshot().agents.find((agent) => agent.executionId === "ordinary")?.status).toBe("cancelled");
    expect(state.snapshot().agents.find((agent) => agent.executionId === "batch")?.status).toBe("running");
  });

  it("retains completed execution history when another company goal starts", async () => {
    const state = new TerminalUiState({ model: "root-model", mode: "act", permission: "ask" });
    await state.emit(started("earlier"));
    await state.emit({ type: "company_goal_started", sessionId: "root-session", at: "2026-09-09T00:00:01.000Z", parentAgentId: "root-agent", goalRunId: "next-goal", objective: "Next work", blueprintId: "company", blueprintRevision: 1, operatingModeId: "balanced_v6", assignmentCount: 1, topology: "hierarchical", maxActiveAgents: 4, maxConcurrentAgents: 2, maxDelegationDepth: 2, maxRepairRounds: 1, maxRequests: 20, maxReportedCostUsd: 2 });
    expect(state.snapshot().agents.map((agent) => agent.executionId)).toEqual(["earlier"]);
  });
});
