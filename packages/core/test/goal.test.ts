import { describe, expect, it } from "vitest";

import {
  GoalError,
  activeGoal,
  completeGoal,
  createSessionState,
  enterPlanMode,
  exitPlanMode,
  pauseGoal,
  resumeGoal,
} from "../src/index.js";

const now = "2026-07-10T00:00:00.000Z";
const later = "2026-07-10T01:00:00.000Z";

describe("goals", () => {
  it("moves through active, paused, resumed, and completed states", () => {
    const active = activeGoal("Ship auth", now);
    const paused = pauseGoal(active, "Waiting on design", later);
    const resumed = resumeGoal(paused, later);
    const completed = completeGoal(
      resumed,
      { summary: "Auth shipped", evidence: ["npm test passed"] },
      later,
    );

    expect(active.status).toBe("active");
    expect(paused).toMatchObject({ status: "paused", progress: "Waiting on design" });
    expect(resumed.status).toBe("active");
    expect(completed).toMatchObject({
      status: "completed",
      progress: "Auth shipped",
      evidence: ["npm test passed"],
    });
  });

  it("does not complete a goal without a summary and evidence", () => {
    const goal = activeGoal("Ship auth", now);

    expect(() =>
      completeGoal(goal, { summary: "", evidence: [] }, later),
    ).toThrow(GoalError);
  });
});

describe("Plan mode", () => {
  it("exits to the permission mode active before planning", () => {
    const session = createSessionState({
      id: "s1",
      cwd: "/workspace",
      model: "scripted",
      permissionMode: "approved_for_me",
    });
    const planned = enterPlanMode(session);

    expect(planned).toMatchObject({
      executionMode: "plan",
      prePlanPermissionMode: "approved_for_me",
    });

    const changedWhilePlanning = { ...planned, permissionMode: "ask_always" as const };
    expect(exitPlanMode(changedWhilePlanning)).toMatchObject({
      executionMode: "act",
      permissionMode: "approved_for_me",
    });
  });
});
