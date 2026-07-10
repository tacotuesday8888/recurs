export type GoalStatus =
  | "active"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface Goal {
  objective: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  stepBudget?: number;
  tokenBudget?: number;
  timeBudgetMs?: number;
  progress: string;
  blockers: string[];
  evidence: string[];
}

export interface GoalBudgets {
  stepBudget?: number;
  tokenBudget?: number;
  timeBudgetMs?: number;
}

export type GoalErrorCode =
  | "invalid_goal"
  | "invalid_transition"
  | "insufficient_evidence";

export class GoalError extends Error {
  constructor(
    public readonly code: GoalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GoalError";
  }
}

function requireStatus(goal: Goal, expected: GoalStatus): void {
  if (goal.status !== expected) {
    throw new GoalError(
      "invalid_transition",
      `Cannot transition a ${goal.status} goal; expected ${expected}`,
    );
  }
}

export function activeGoal(
  objective: string,
  at: string,
  budgets: GoalBudgets = {},
): Goal {
  const normalizedObjective = objective.trim();
  if (normalizedObjective.length === 0) {
    throw new GoalError("invalid_goal", "A goal objective is required");
  }

  return {
    objective: normalizedObjective,
    status: "active",
    createdAt: at,
    updatedAt: at,
    ...budgets,
    progress: "",
    blockers: [],
    evidence: [],
  };
}

export function pauseGoal(goal: Goal, progress: string, at: string): Goal {
  requireStatus(goal, "active");
  return {
    ...goal,
    status: "paused",
    updatedAt: at,
    progress: progress.trim(),
  };
}

export function resumeGoal(goal: Goal, at: string): Goal {
  requireStatus(goal, "paused");
  return { ...goal, status: "active", updatedAt: at };
}

export interface GoalCompletion {
  summary: string;
  evidence: string[];
}

export function completeGoal(
  goal: Goal,
  completion: GoalCompletion,
  at: string,
): Goal {
  requireStatus(goal, "active");
  const summary = completion.summary.trim();
  const evidence = completion.evidence
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (summary.length === 0 || evidence.length === 0) {
    throw new GoalError(
      "insufficient_evidence",
      "Completing a goal requires a summary and verification evidence",
    );
  }

  return {
    ...goal,
    status: "completed",
    updatedAt: at,
    progress: summary,
    evidence,
  };
}
