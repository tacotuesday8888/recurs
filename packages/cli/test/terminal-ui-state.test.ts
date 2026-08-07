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

  it("shows the generated wordmark at wide widths and the compact mark when narrow", () => {
    const state = new TerminalUiState({
      model: "parent-model",
      mode: "balanced_v6",
      permission: "approved_for_me",
    });

    const wide = renderCompanyHome(state.snapshot(), 80, 0);
    const narrow = renderCompanyHome(state.snapshot(), 24, 0);

    expect(wide).toEqual(expect.arrayContaining([
      expect.stringContaining("████   █████   ████"),
      expect.stringContaining("█   █  █████   ████"),
    ]));
    expect(narrow).toEqual(expect.arrayContaining([
      expect.stringContaining("▗█▀▀█▖"),
      expect.stringContaining("◀▀  ▝▀"),
    ]));
    expect(narrow).not.toEqual(expect.arrayContaining([
      expect.stringContaining("████   █████   ████"),
    ]));
    expect(narrow).toMatchInlineSnapshot(`
      [
        "          ▗█▀▀█▖",
        "          █▌ ▗█▘",
        "          ▜█▀▜▙",
        "         ◀▀  ▝▀",
        "    RECURS / COMPANY",
        "THE BEST CODING MODEL I…",
        "",
        "▚▟██▙▞  ◆ PARENT  paren…",
        "    ╭······┴······╮",
        "READY · START A COMPANY…",
        "",
        "balanced_v6 · approved_…",
        "  ENTER CHAT   Q QUIT",
      ]
    `);
  });

  it("projects review, repair, handoff, evidence, request, and partial usage activity", async () => {
    const state = new TerminalUiState({
      model: "parent-model",
      mode: "balanced_v6",
      permission: "approved_for_me",
    });
    await state.emit({
      type: "company_goal_started",
      sessionId: "parent-session",
      at: "2026-08-07T00:00:00.000Z",
      parentAgentId: "parent-agent",
      goalRunId: "goal-activity",
      objective: "Repair and verify the release",
      blueprintId: "company-1",
      blueprintRevision: 1,
      operatingModeId: "balanced_v6",
      assignmentCount: 2,
      topology: "hierarchical",
      maxActiveAgents: 4,
      maxConcurrentAgents: 2,
      maxDelegationDepth: 2,
      maxRepairRounds: 2,
      maxRequests: 30,
      maxReportedCostUsd: 3,
    });
    await state.emit({
      type: "company_handoff_completed",
      sessionId: "parent-session",
      at: "2026-08-07T00:00:01.000Z",
      parentAgentId: "parent-agent",
      goalRunId: "goal-activity",
      assignmentId: "implement-1",
      parentAssignmentId: null,
      departmentId: "engineering",
      roleId: "implement",
      childAgentId: "child-1",
      childSessionId: "child-session-1",
      usage: { inputTokens: 1200, outputTokens: 340, costUsd: 0.08 },
      evidence: ["tests passed", "diff reviewed"],
      workflow: { modelRequests: 1, toolCalls: 3 },
    });
    await state.emit({
      type: "company_handoff_completed",
      sessionId: "parent-session",
      at: "2026-08-07T00:00:02.000Z",
      parentAgentId: "parent-agent",
      goalRunId: "goal-activity",
      assignmentId: "review-1",
      parentAssignmentId: null,
      departmentId: "quality",
      roleId: "review",
      childAgentId: "child-2",
      childSessionId: "child-session-2",
      usage: null,
      evidence: ["review recorded"],
      workflow: { modelRequests: 1, toolCalls: 0 },
    });
    await state.emit({
      type: "agent_team_activity",
      sessionId: "parent-session",
      at: "2026-08-07T00:00:03.000Z",
      parentAgentId: "parent-agent",
      teamId: "team-1",
      sequence: 8,
      status: "running",
      phase: "repair",
      round: 1,
      operatingModeId: "balanced_v6",
      execution: "worktree",
      activity: "review_recorded",
      counts: {
        childrenReserved: 3,
        childrenFinished: 2,
        requestsReserved: 4,
        requestsUsed: 3,
        costReportedChildren: 1,
        costMissingChildren: 1,
        costCoverage: "partial",
      },
      role: "review",
      reviewVerdict: "changes_requested",
      findingCount: 2,
      goalRunId: "goal-activity",
    });

    const rendered = renderCompanyHome(state.snapshot(), 100, 0).join("\n");

    expect(rendered).toContain("REPAIR 1");
    expect(rendered).toContain("REVIEW CHANGES REQUESTED · 2 FINDINGS");
    expect(rendered).toContain("HANDOFFS 2 DONE");
    expect(rendered).toContain("EVIDENCE 3");
    expect(rendered).toContain("REQUESTS 3/30");
    expect(rendered).toContain("USAGE PARTIAL · 1.2K IN · 340 OUT · COST UNKNOWN");
    expect(rendered).not.toContain("TOTAL USAGE");
  });

  it("never converts token-only handoff usage into a reported zero cost", async () => {
    const state = new TerminalUiState({
      model: "parent-model",
      mode: "balanced_v6",
      permission: "approved_for_me",
    });
    await state.emit({
      type: "company_goal_started",
      sessionId: "parent-session",
      at: "2026-08-07T00:00:00.000Z",
      parentAgentId: "parent-agent",
      goalRunId: "goal-no-cost",
      objective: "Verify unknown cost",
      blueprintId: "company-1",
      blueprintRevision: 1,
      operatingModeId: "balanced_v6",
      assignmentCount: 1,
      topology: "recommended",
      maxActiveAgents: 2,
      maxConcurrentAgents: 1,
      maxDelegationDepth: 1,
      maxRepairRounds: 0,
      maxRequests: 10,
      maxReportedCostUsd: 1,
    });
    await state.emit({
      type: "company_handoff_completed",
      sessionId: "parent-session",
      at: "2026-08-07T00:00:01.000Z",
      parentAgentId: "parent-agent",
      goalRunId: "goal-no-cost",
      assignmentId: "implement-1",
      parentAssignmentId: null,
      departmentId: "engineering",
      roleId: "implement",
      childAgentId: "child-1",
      childSessionId: "child-session-1",
      usage: { inputTokens: 800, outputTokens: 200 },
      evidence: [],
      workflow: { modelRequests: 1, toolCalls: 0 },
    });

    const rendered = renderCompanyHome(state.snapshot(), 80, 0).join("\n");
    expect(rendered).toContain("USAGE PARTIAL · 800 IN · 200 OUT · COST UNKNOWN");
    expect(rendered).not.toContain("$0.00 REPORTED");
  });

  it("uses authoritative terminal request and deduplicated evidence totals", async () => {
    const state = new TerminalUiState({
      model: "parent-model",
      mode: "balanced_v6",
      permission: "approved_for_me",
    });
    await state.emit({
      type: "company_goal_started",
      sessionId: "parent-session",
      at: "2026-08-07T00:00:00.000Z",
      parentAgentId: "parent-agent",
      goalRunId: "goal-final",
      objective: "Settle final metrics",
      blueprintId: "company-1",
      blueprintRevision: 1,
      operatingModeId: "balanced_v6",
      assignmentCount: 2,
      topology: "recommended",
      maxActiveAgents: 2,
      maxConcurrentAgents: 1,
      maxDelegationDepth: 1,
      maxRepairRounds: 0,
      maxRequests: 10,
      maxReportedCostUsd: 1,
    });
    for (const assignmentId of ["implement-1", "review-1"]) {
      await state.emit({
        type: "company_handoff_completed",
        sessionId: "parent-session",
        at: "2026-08-07T00:00:01.000Z",
        parentAgentId: "parent-agent",
        goalRunId: "goal-final",
        assignmentId,
        parentAssignmentId: null,
        departmentId: "engineering",
        roleId: assignmentId,
        childAgentId: `${assignmentId}-child`,
        childSessionId: `${assignmentId}-session`,
        usage: null,
        evidence: ["same verification"],
        workflow: { modelRequests: 1, toolCalls: 0 },
      });
    }
    expect(state.snapshot().goal?.evidenceCount).toBe(1);

    await state.emit({
      type: "company_goal_completed",
      sessionId: "parent-session",
      at: "2026-08-07T00:00:02.000Z",
      parentAgentId: "parent-agent",
      goalRunId: "goal-final",
      status: "completed",
      evidence: ["same verification"],
      workflow: {
        childrenStarted: 2,
        maxChildren: 2,
        requestsReserved: 4,
        requestsUsed: 3,
        maxRequests: 10,
        reportedCostUsd: 0,
        maxReportedCostUsd: 1,
      },
    });

    expect(state.snapshot().goal).toMatchObject({
      status: "completed",
      requestsUsed: 3,
      evidenceCount: 1,
    });
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
