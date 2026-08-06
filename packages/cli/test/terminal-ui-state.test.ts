import { describe, expect, it } from "vitest";

import {
  TerminalUiState,
  renderCompanyHome,
} from "../src/terminal-ui-state.js";

describe("TerminalUiState", () => {
  it("projects a truthful layered company from normalized runtime events", async () => {
    const state = new TerminalUiState({
      model: "gpt-5.6-sol",
      mode: "balanced_v6",
      permission: "approved_for_me",
    });

    await state.emit({
      type: "company_goal_started",
      sessionId: "parent-session",
      at: "2026-08-06T00:00:00.000Z",
      parentAgentId: "parent-agent",
      goalRunId: "goal-1",
      objective: "Ship a reviewed terminal interface",
      blueprintId: "company-1",
      blueprintRevision: 1,
      operatingModeId: "balanced_v6",
      assignmentCount: 2,
      topology: "recommended",
      maxActiveAgents: 4,
      maxConcurrentAgents: 2,
      maxDelegationDepth: 2,
      maxRepairRounds: 1,
      maxRequests: 30,
      maxReportedCostUsd: 2,
    });
    await state.emit({
      type: "company_assignment_started",
      sessionId: "parent-session",
      at: "2026-08-06T00:00:01.000Z",
      parentAgentId: "parent-agent",
      goalRunId: "goal-1",
      assignmentId: "lead-1",
      parentAssignmentId: null,
      departmentId: "engineering",
      roleId: "implementation-lead",
      roleName: "Implementation Lead",
      profileId: "explore_v1",
      childAgentId: "lead-agent",
      childSessionId: "lead-session",
    });
    await state.emit({
      type: "company_assignment_started",
      sessionId: "parent-session",
      at: "2026-08-06T00:00:02.000Z",
      parentAgentId: "parent-agent",
      goalRunId: "goal-1",
      assignmentId: "worker-1",
      parentAssignmentId: "lead-1",
      departmentId: "engineering",
      roleId: "builder",
      roleName: "Builder",
      profileId: "implement_v2",
      childAgentId: "worker-agent",
      childSessionId: "worker-session",
    });
    await state.emit({
      type: "agent_started",
      sessionId: "parent-session",
      at: "2026-08-06T00:00:02.500Z",
      parentAgentId: "parent-agent",
      childAgentId: "lead-agent",
      childSessionId: "lead-session",
      taskId: "task-0",
      description: "Lead implementation",
      operatingModeId: "balanced_v6",
      profileId: "explore_v1",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      backendStrategy: "inherit_parent",
    });
    await state.emit({
      type: "agent_started",
      sessionId: "parent-session",
      at: "2026-08-06T00:00:03.000Z",
      parentAgentId: "parent-agent",
      childAgentId: "worker-agent",
      childSessionId: "worker-session",
      taskId: "task-1",
      description: "Implement the terminal interface",
      operatingModeId: "balanced_v6",
      profileId: "implement_v2",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      backendStrategy: "role_candidate",
      backendReason: "eligible_role_candidate",
    });

    const snapshot = state.snapshot();
    expect(snapshot.goal).toMatchObject({
      id: "goal-1",
      status: "running",
      activeAgents: 2,
      maxActiveAgents: 4,
    });
    expect(snapshot.agents).toEqual([
      expect.objectContaining({
        assignmentId: "lead-1",
        parentAssignmentId: null,
        roleName: "Implementation Lead",
        depth: 1,
        status: "running",
      }),
      expect.objectContaining({
        assignmentId: "worker-1",
        parentAssignmentId: "lead-1",
        roleName: "Builder",
        depth: 2,
        model: "gpt-5.6-terra",
        effort: "medium",
        status: "running",
      }),
    ]);

    const rendered = renderCompanyHome(snapshot, 88, 0).join("\n");
    expect(rendered).toContain("IMPLEMENTATION LEAD");
    expect(rendered).toContain("BUILDER");
    expect(rendered).toContain("gpt-5.6-terra · medium");
    expect(rendered).toContain("···");
    expect(rendered).not.toContain("┌");
    expect(rendered).not.toContain("┐");
  });

  it("marks completed and failed agents without leaving them active", async () => {
    const state = new TerminalUiState({
      model: "parent-model",
      mode: "performance_v6",
      permission: "ask_always",
    });
    await state.emit({
      type: "company_assignment_started",
      sessionId: "parent-session",
      at: "2026-08-06T00:00:00.000Z",
      parentAgentId: "parent-agent",
      goalRunId: "goal-1",
      assignmentId: "review-1",
      parentAssignmentId: null,
      departmentId: "qa",
      roleId: "reviewer",
      roleName: "Independent Review",
      profileId: "review_v2",
      childAgentId: "review-agent",
      childSessionId: "review-session",
    });
    await state.emit({
      type: "agent_started",
      sessionId: "parent-session",
      at: "2026-08-06T00:00:00.500Z",
      parentAgentId: "parent-agent",
      childAgentId: "review-agent",
      childSessionId: "review-session",
      taskId: "task-1",
      description: "Review the candidate",
      operatingModeId: "performance_v6",
      profileId: "review_v2",
      modelId: "review-model",
      reasoningEffort: "medium",
      backendStrategy: "role_candidate",
      backendReason: "eligible_role_candidate",
    });
    await state.emit({
      type: "company_handoff_failed",
      sessionId: "parent-session",
      at: "2026-08-06T00:00:01.000Z",
      parentAgentId: "parent-agent",
      goalRunId: "goal-1",
      assignmentId: "review-1",
      parentAssignmentId: null,
      departmentId: "qa",
      roleId: "reviewer",
      childAgentId: "review-agent",
      childSessionId: "review-session",
      status: "failed",
      reason: "provider unavailable",
    });

    expect(state.snapshot().agents[0]).toMatchObject({
      status: "failed",
      detail: "provider unavailable",
    });
    expect(state.snapshot().goal?.activeAgents ?? 0).toBe(0);
  });

  it("does not depict a reserved assignment before its child activates", async () => {
    const state = new TerminalUiState({
      model: "parent-model",
      mode: "balanced_v6",
      permission: "approved_for_me",
    });
    await state.emit({
      type: "company_assignment_started",
      sessionId: "parent-session",
      at: "2026-08-06T00:00:00.000Z",
      parentAgentId: "parent-agent",
      goalRunId: "goal-1",
      assignmentId: "implement-1",
      parentAssignmentId: null,
      departmentId: "engineering",
      roleId: "implementer",
      roleName: "Implement",
      profileId: "implement_v2",
      childAgentId: "implement-agent",
      childSessionId: "implement-session",
    });
    await state.emit({
      type: "company_handoff_failed",
      sessionId: "parent-session",
      at: "2026-08-06T00:00:01.000Z",
      parentAgentId: "parent-agent",
      goalRunId: "goal-1",
      assignmentId: "implement-1",
      parentAssignmentId: null,
      departmentId: "engineering",
      roleId: "implementer",
      childAgentId: "implement-agent",
      childSessionId: "implement-session",
      status: "failed",
      reason: "route unavailable",
    });

    expect(state.snapshot().agents).toEqual([]);
    expect(renderCompanyHome(state.snapshot(), 80, 0).join("\n"))
      .not.toContain("IMPLEMENT");
  });

  it("never renders beyond a narrow terminal width", () => {
    const state = new TerminalUiState({
      model: "a-very-long-parent-model-name",
      mode: "balanced_v6",
      permission: "approved_for_me",
    });

    for (const line of renderCompanyHome(state.snapshot(), 20, 0)) {
      expect(Array.from(line).length).toBeLessThanOrEqual(20);
    }
  });

  it("moves connector dots between animation frames without changing layout", () => {
    const state = new TerminalUiState({
      model: "parent-model",
      mode: "balanced_v6",
      permission: "approved_for_me",
    });
    const first = renderCompanyHome(state.snapshot(), 80, 0);
    const second = renderCompanyHome(state.snapshot(), 80, 1);

    expect(first).not.toEqual(second);
    expect(first).toHaveLength(second.length);
    expect(first.map((line) => line.length)).toEqual(
      second.map((line) => line.length),
    );
  });
});
