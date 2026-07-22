import {
  activeGoal,
  completeGoal,
  isPinnedSessionState,
  pauseGoal,
  resumeGoal,
  type Goal,
  type SessionRecord,
} from "@recurs/core";

import { message, type Command, type CommandContext } from "./types.js";

function goalRecord(
  context: CommandContext,
  goal: Goal | null,
): SessionRecord {
  return {
    version: 1,
    type: "goal_updated",
    sessionId: context.session.id,
    at: context.now(),
    goal,
  };
}

function isUnfinished(goal: Goal | null): boolean {
  return goal?.status === "active" || goal?.status === "paused";
}

function latestAssistantSummary(context: CommandContext): string {
  return (
    [...context.session.messages]
      .reverse()
      .find((item) => item.role === "assistant" && item.content.trim().length > 0)
      ?.content.trim() ?? ""
  );
}

function formatGoal(goal: Goal | null): string {
  if (goal === null) {
    return "No active goal. Use /goal <objective> to create one.";
  }
  const details = [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Progress: ${goal.progress || "No progress summary yet"}`,
  ];
  if (goal.blockers.length > 0) {
    details.push(`Blockers: ${goal.blockers.join("; ")}`);
  }
  if (goal.evidence.length > 0) {
    details.push(`Evidence: ${goal.evidence.join("; ")}`);
  }
  return details.join("\n");
}

function companyLaunchPrompt(objective: string): string {
  return [
    "Launch the approved Recurs company for the exact durable goal below.",
    `Goal: ${JSON.stringify(objective)}`,
    "Use delegate_company_goal once with a bounded assignment DAG that uses only approved role IDs and includes every independent-review authority.",
    "Do not widen the objective, permissions, tools, model routes, hierarchy, concurrency, requests, retries, or reported-cost limits.",
    "Synthesize the durable company result for the user when the tool completes.",
  ].join("\n");
}

export function createGoalCommand(): Command {
  return {
    name: "goal",
    description: "Create, inspect, pause, resume, complete, or clear the durable goal",
    usage: "/goal [objective|pause|resume|complete|clear]",
    async execute(args, context) {
      const action = args.trim();
      if (action.length === 0) {
        return message(formatGoal(context.session.goal));
      }
      if (action === "pause") {
        const goal = context.session.goal;
        if (goal === null) {
          return message("There is no goal to pause", "error");
        }
        const progress = latestAssistantSummary(context) || goal.progress;
        await context.applyRecord(
          goalRecord(context, pauseGoal(goal, progress, context.now())),
        );
        return message("Goal paused");
      }
      if (action === "resume") {
        const goal = context.session.goal;
        if (goal === null) {
          return message("There is no goal to resume", "error");
        }
        await context.applyRecord(
          goalRecord(context, resumeGoal(goal, context.now())),
        );
        return message("Goal resumed");
      }
      if (action === "complete") {
        const goal = context.session.goal;
        if (goal === null) {
          return message("There is no goal to complete", "error");
        }
        const summary = goal.progress.trim();
        if (summary.length === 0 || goal.evidence.length === 0) {
          return message(
            "Goal completion requires an assistant summary and verification evidence",
            "error",
          );
        }
        const completed = completeGoal(
          goal,
          { summary, evidence: goal.evidence },
          context.now(),
        );
        await context.applyRecord(goalRecord(context, completed));
        return message("Goal completed with verification evidence");
      }
      if (action === "clear") {
        if (context.session.goal === null) {
          return message("There is no goal to clear", "warning");
        }
        if (
          isUnfinished(context.session.goal) &&
          !(await context.confirm("Clear the unfinished goal?"))
        ) {
          return message("Goal was not cleared", "warning");
        }
        await context.applyRecord(goalRecord(context, null));
        return message("Goal cleared");
      }

      if (
        isUnfinished(context.session.goal) &&
        !(await context.confirm("Replace the unfinished goal?"))
      ) {
        return message("Existing goal was kept", "warning");
      }
      const goal = activeGoal(action, context.now());
      await context.applyRecord(goalRecord(context, goal));
      if (isPinnedSessionState(context.session) &&
        context.session.agent.role === "parent" &&
        context.session.agent.company?.blueprintVersion === 2) {
        return {
          type: "submit_prompt",
          prompt: companyLaunchPrompt(goal.objective),
        };
      }
      return message(`Goal set: ${goal.objective}`);
    },
  };
}
