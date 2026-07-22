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

import type { AgentWorkflowUsage } from "./events.js";

function delegationLimits(agent: AgentSessionDescriptor): {
  readonly maxChildren: number;
  readonly maxRequests: number;
  readonly maxReportedCostUsd: number;
} {
  const mode = getOperatingModePolicy(agent.operatingMode.id);
  if (agent.company?.blueprintVersion !== 2) {
    return {
      maxChildren: mode.workflow.maxChildrenPerRun,
      maxRequests: mode.workflow.maxRequestsPerRun,
      maxReportedCostUsd: mode.orchestration.maxReportedCostUsd,
    };
  }
  if (mode.company === undefined) {
    throw new TypeError("Company V2 agents require a company operating mode");
  }
  return {
    maxChildren: mode.company.maxActiveRoles,
    maxRequests: mode.company.maxGoalRequests,
    maxReportedCostUsd: mode.company.maxReportedCostUsd,
  };
}

export function createDelegationBudget(
  agent: AgentSessionDescriptor,
): DelegationBudget {
  const limits = delegationLimits(agent);
  return {
    maxChildren: limits.maxChildren,
    childrenStarted: 0,
    maxRequests: limits.maxRequests,
    requestsReserved: 0,
    requestsUsed: 0,
    maxReportedCostUsd: limits.maxReportedCostUsd,
    reportedCostUsd: 0,
  };
}

export function childRequestAllowance(agent: AgentSessionDescriptor): number {
  const limits = delegationLimits(agent);
  return Math.max(1, Math.floor(limits.maxRequests / limits.maxChildren));
}

export function isDelegationBudgetForAgent(
  budget: DelegationBudget,
  agent: AgentSessionDescriptor,
): boolean {
  const limits = delegationLimits(agent);
  return budget.maxChildren === limits.maxChildren &&
    budget.maxRequests === limits.maxRequests &&
    budget.maxReportedCostUsd === limits.maxReportedCostUsd &&
    Number.isSafeInteger(budget.childrenStarted) &&
    budget.childrenStarted >= 0 &&
    Number.isSafeInteger(budget.requestsReserved) &&
    budget.requestsReserved >= 0 &&
    budget.requestsReserved <= budget.maxRequests &&
    Number.isSafeInteger(budget.requestsUsed) &&
    budget.requestsUsed >= 0 &&
    budget.requestsUsed <= budget.requestsReserved &&
    Number.isFinite(budget.reportedCostUsd) &&
    budget.reportedCostUsd >= 0;
}

export function delegationWorkflowUsage(
  budget: DelegationBudget,
): AgentWorkflowUsage {
  return {
    childrenStarted: budget.childrenStarted,
    maxChildren: budget.maxChildren,
    requestsReserved: budget.requestsReserved,
    requestsUsed: budget.requestsUsed,
    maxRequests: budget.maxRequests,
    reportedCostUsd: budget.reportedCostUsd,
    maxReportedCostUsd: budget.maxReportedCostUsd,
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
        "Work read-only: inspect diffs, relevant files, and existing Implement evidence with only the tools supplied by the host.",
        "Do not execute repository code or create verification artifacts.",
        "Prioritize concrete correctness, safety, regression, and missing-test findings over style commentary.",
        "Return a concise handoff with these headings: Findings, Evidence, Verdict, unless the task supplies a stricter machine-readable output contract.",
        "",
        "Task:",
        prompt,
      ].join("\n");
    case "implement_v2":
      return [
        "You are a Recurs Implement agent assigned to one bounded staged code change.",
        "Use only the host tools supplied to read files, apply a bounded patch, and inspect Git state.",
        "Do not execute repository code or arbitrary commands.",
        "Do not use network tools, credentials, deployments, external paths, or sensitive paths.",
        "Return a concise handoff with these headings: Changes, Evidence, Remaining risk.",
        "",
        "Task:",
        prompt,
      ].join("\n");
    case "review_v2":
      return [
        "You are a Recurs Review agent assigned to one bounded staged-change review.",
        "Work read-only with only the host tools supplied to inspect files, diffs, and Git state.",
        "Do not execute repository code or arbitrary commands.",
        "Do not use network tools, credentials, deployments, external paths, or sensitive paths.",
        "Return bounded structured Findings with path (or *), problem, acceptance, and evidence; approval must contain no findings.",
        "",
        "Task:",
        prompt,
      ].join("\n");
    case "repair_v1":
      return [
        "You are a Recurs Repair agent assigned to one bounded staged repair.",
        "Address only the supplied structured findings with the host file and Git tools.",
        "Do not execute repository code or arbitrary commands.",
        "Do not use network tools, credentials, deployments, external paths, or sensitive paths.",
        "Return a concise handoff with these headings: Repairs, Evidence, Remaining findings.",
        "",
        "Task:",
        prompt,
      ].join("\n");
    default:
      return prompt;
  }
}
