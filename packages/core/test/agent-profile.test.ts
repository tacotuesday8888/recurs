import {
  getAgentProfilePolicy,
  getOperatingModePolicy,
  type AgentProfileId,
  type AgentSessionDescriptor,
} from "@recurs/contracts";
import { describe, expect, it } from "vitest";

import { scopeAgentPrompt } from "../src/index.js";

function child(profileId: AgentProfileId): AgentSessionDescriptor {
  const profile = getAgentProfilePolicy(profileId);
  const mode = getOperatingModePolicy("balanced_v4");
  return {
    id: `${profileId}-agent`,
    role: "child",
    profile: { id: profile.id, version: profile.version },
    parentAgentId: "parent-agent",
    parentSessionId: "parent-session",
    depth: 1,
    task: { id: "task", description: "Task", prompt: "Do it" },
    operatingMode: { id: mode.id, version: mode.version },
    backend: {
      strategy: "inherit_parent",
      adapterId: "adapter",
      connectionId: "connection",
      modelId: "model",
    },
    permissions: {
      parentExecutionMode: "act",
      executionMode: profile.executionMode,
      parentPermissionMode: "full_access",
      permissionMode: "full_access",
    },
    limits: mode.orchestration,
  };
}

describe("v4 team profile prompts", () => {
  it.each([
    ["implement_v2", "Implement", "Changes"],
    ["review_v2", "Review", "Findings"],
    ["repair_v1", "Repair", "Repairs"],
  ] as const)("scopes %s to host tools with no process or network execution", (
    profileId,
    role,
    heading,
  ) => {
    const prompt = scopeAgentPrompt(child(profileId), "Perform the bounded task");

    expect(prompt).toContain(`Recurs ${role} agent`);
    expect(prompt).toContain("Do not execute repository code or arbitrary commands.");
    expect(prompt).toContain("Do not use network tools, credentials, deployments, external paths, or sensitive paths.");
    expect(prompt).toContain(heading);
    expect(prompt).toContain("Perform the bounded task");
  });
});
