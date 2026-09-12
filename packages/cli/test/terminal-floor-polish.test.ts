import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { TerminalUiState, renderCompanyHome } from "../src/terminal-ui-state.js";

describe("agent floor status", () => {
  it("shows actual child models and active guidance, then history after completion", async () => {
    const state = new TerminalUiState({ model: "parent-model", mode: "balanced", permission: "ask_always" });
    const base = { sessionId: "root", at: "2026-09-12T00:00:00Z" };
    expect(renderCompanyHome(state.snapshot(), 100, 0).join("\n")).toContain("Your team appears here");
    await state.emit({ ...base, type: "agent_started", parentAgentId: "parent", childAgentId: "builder", childSessionId: "child", taskId: "task", description: "Build parser", operatingModeId: "balanced_v6", profileId: "implement_v1", modelId: "child-model", reasoningEffort: null });
    const snapshot = state.snapshot();
    const floor = renderCompanyHome(snapshot, 100, 0, undefined, 30, true).join("\n");
    expect(floor).toContain("Work in progress");
    expect(floor).toContain("child-model");
    expect(floor).not.toContain("Start a coding task");
    for (const width of [1, 20, 40, 80, 160]) for (const height of [1, 4, 8, 12, 24, 40]) {
      const rows = renderCompanyHome(snapshot, width, 0, undefined, height, true);
      expect(rows.length).toBeLessThanOrEqual(height);
      expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
    }
    const complete = { ...snapshot, agents: snapshot.agents.map((agent) => ({ ...agent, status: "completed" as const })), company: snapshot.company.map((node) => ({ ...node, status: "completed" as const })) };
    expect(renderCompanyHome(complete, 100, 0).join("\n")).toContain("Work history");
  });
});
