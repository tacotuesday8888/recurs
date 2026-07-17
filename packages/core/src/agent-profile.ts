import {
  getAgentProfilePolicy,
  getOperatingModePolicy,
  type AgentSessionDescriptor,
} from "@recurs/contracts";
import type {
  DelegationBudget,
  ToolContext,
  ToolPolicy,
} from "@recurs/tools";

export function createDelegationBudget(
  agent: AgentSessionDescriptor,
): DelegationBudget {
  const mode = getOperatingModePolicy(agent.operatingMode.id);
  return {
    maxChildren: mode.workflow.maxChildrenPerRun,
    childrenStarted: 0,
    maxReportedCostUsd: mode.orchestration.maxReportedCostUsd,
    reportedCostUsd: 0,
  };
}

export function applyAgentToolPolicy(
  context: ToolContext,
  agent: AgentSessionDescriptor,
): ToolContext {
  if (agent.profile === null) {
    return context;
  }
  const profile = getAgentProfilePolicy(agent.profile.id);
  const toolPolicy: ToolPolicy = profile.tools;
  return { ...context, toolPolicy };
}

export function scopeAgentPrompt(
  agent: AgentSessionDescriptor,
  prompt: string,
): string {
  switch (agent.profile?.id) {
    case "explore_v1":
      return [
        "You are a Recurs Explore agent assigned to one bounded investigation.",
        "Work read-only. Inspect the workspace with only the tools supplied by the host.",
        "Do not claim that files were changed and do not treat unverified guesses as facts.",
        "Return a concise handoff with these headings: Findings, Evidence, Uncertainty, Recommended next step.",
        "Evidence should cite concrete workspace paths and line numbers whenever available.",
        "",
        "Task:",
        prompt,
      ].join("\n");
    case "implement_v1":
      return [
        "You are a Recurs Implement agent assigned to one bounded code change.",
        "Make only the changes needed for the task using the host tools supplied to you.",
        "Do not delegate, access credentials, deploy, or use network resources.",
        "Run the narrowest relevant verification and distinguish observed evidence from assumptions.",
        "Return a concise handoff with these headings: Changes, Verification, Evidence, Remaining risk.",
        "",
        "Task:",
        prompt,
      ].join("\n");
    case "review_v1":
      return [
        "You are a Recurs Review agent assigned to one bounded independent review.",
        "Do not edit source files. Inspect the workspace and use only fixed verification supplied by the host.",
        "Prioritize concrete correctness, safety, regression, and missing-test findings over style commentary.",
        "Return a concise handoff with these headings: Findings, Verification, Evidence, Verdict.",
        "",
        "Task:",
        prompt,
      ].join("\n");
    default:
      return prompt;
  }
}
