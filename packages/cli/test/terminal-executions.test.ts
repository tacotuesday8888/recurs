import { describe, expect, it } from "vitest";
import type { RecursEvent } from "@recurs/core";
import { TerminalUiState } from "../src/terminal-ui-state.js";

function started(id: string, parentSessionId = "root-session", parentAgentId = "root-agent"): Extract<RecursEvent, { type: "agent_started" }> {
  return { type: "agent_started", sessionId: parentSessionId, at: "2026-09-09T00:00:00.000Z", parentAgentId, childAgentId: `${id}-agent`, childSessionId: id, taskId: `${id}-task`, description: `Task ${id}`, operatingModeId: "balanced_v6", profileId: "explore_v1", modelId: "worker-model", reasoningEffort: "high" };
}

describe("terminal execution identities", () => {
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
