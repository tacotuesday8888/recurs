import {
  getAgentProfilePolicy,
  type AgentSessionDescriptor,
} from "@recurs/contracts";
import type { ToolContext, ToolPolicy } from "@recurs/tools";

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
  if (agent.profile?.id !== "explore_v1") {
    return prompt;
  }
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
}
