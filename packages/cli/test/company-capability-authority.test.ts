import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getAgentProfilePolicy,
  getOperatingModePolicy,
  createHostInvocation,
  type AgentSessionDescriptor,
} from "@recurs/contracts";
import { FileCompanyCapabilityStore } from "@recurs/core";
import { ScriptedProvider } from "@recurs/providers";
import { afterEach, describe, expect, it } from "vitest";

import { companyBlueprintV2Fixture } from "../../contracts/test/company-v2-fixture.js";
import { CompanyCapabilityAuthority } from "../src/company-capability-authority.js";
import { createStandaloneRuntime } from "../src/assembly.js";

const roots: string[] = [];
const at = "2026-07-22T10:00:00.000Z";

async function authority(input: {
  readonly skillEnabled?: boolean;
  readonly mcpEnabled?: boolean;
} = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "recurs-capability-authority-")));
  roots.push(root);
  const store = new FileCompanyCapabilityStore(path.join(root, "bindings"));
  const value = new CompanyCapabilityAuthority({
    store,
    skills: {
      snapshot: () => ({
        projectSkillsEnabled: false,
        warnings: [],
        skills: [{
          name: "release-check",
          description: "Check a release",
          source: "user" as const,
          location: "~/.agents/skills/release-check",
          enabled: input.skillEnabled ?? true,
        }],
      }),
    },
    mcp: {
      snapshot: () => ({
        configPath: "/private/mcp.json",
        projectTrust: input.mcpEnabled === false ? "untrusted" as const : "trusted" as const,
        warnings: [],
        servers: [{
          id: "issue-tracker",
          description: "Track issues",
          command: "/private/bin/issues",
          args: [],
          network: "deny" as const,
          source: "project" as const,
          enabled: input.mcpEnabled ?? true,
          state: "idle" as const,
        }],
      }),
    },
  });
  return { value, store };
}

function child(roleId: string): AgentSessionDescriptor {
  const profile = getAgentProfilePolicy("review_v2");
  const mode = getOperatingModePolicy("balanced_v6");
  return {
    id: "company-capability-child",
    role: "child",
    profile: { id: profile.id, version: profile.version },
    parentAgentId: "parent",
    parentSessionId: "parent-session",
    depth: 1,
    task: { id: "task", description: "Review", prompt: "Review it" },
    operatingMode: { id: mode.id, version: mode.version },
    backend: {
      strategy: "inherit_parent",
      adapterId: "adapter",
      connectionId: "connection",
      modelId: "model",
    },
    permissions: {
      parentExecutionMode: "act",
      executionMode: "act",
      parentPermissionMode: "approved_for_me",
      permissionMode: "ask_always",
    },
    limits: mode.orchestration,
    company: {
      blueprintId: "company-v2-fixture",
      blueprintVersion: 2,
      blueprintRevision: 1,
      roleId,
      roleVersion: 1,
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("CompanyCapabilityAuthority", () => {
  it("publishes explicit bindings and intersects them with the exact role bundle", async () => {
    const { value, store } = await authority();
    const blueprint = companyBlueprintV2Fixture();
    await value.activate(blueprint);
    expect(value.policyForAgent(child("quality_reviewer"))).toEqual({
      agentSkillNames: [],
      mcpServerIds: [],
    });
    const skill = await value.bind({
      blueprint,
      bundleId: "quality_v1",
      type: "agent_skill",
      sourceId: "release-check",
      at,
    });
    await value.bind({
      blueprint,
      bundleId: "quality_v1",
      type: "mcp_server",
      sourceId: "issue-tracker",
      at: "2026-07-22T10:01:00.000Z",
    });

    expect(value.policyForAgent(child("quality_reviewer"))).toEqual({
      agentSkillNames: ["release-check"],
      mcpServerIds: ["issue-tracker"],
    });
    expect(value.policyForAgent(child("root_orchestrator"))).toEqual({
      agentSkillNames: [],
      mcpServerIds: [],
    });
    expect((await store.latest(blueprint.companyId))?.revision).toBe(2);

    await value.unbind({
      blueprint,
      bindingId: skill.bindings[0]!.id,
      at: "2026-07-22T10:02:00.000Z",
    });
    expect(value.policyForAgent(child("quality_reviewer"))?.agentSkillNames)
      .toEqual([]);
  });

  it("does not infer unavailable catalogs or unapproved bundles", async () => {
    const { value } = await authority({ skillEnabled: false, mcpEnabled: false });
    const blueprint = companyBlueprintV2Fixture();
    await value.activate(blueprint);

    await expect(value.bind({
      blueprint,
      bundleId: "quality_v1",
      type: "agent_skill",
      sourceId: "release-check",
      at,
    })).rejects.toMatchObject({ code: "unavailable" });
    await expect(value.bind({
      blueprint,
      bundleId: "release_v1",
      type: "mcp_server",
      sourceId: "issue-tracker",
      at,
    })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("reloads exact persisted authority and ignores it for another revision", async () => {
    const { value } = await authority();
    const first = companyBlueprintV2Fixture();
    await value.activate(first);
    await value.bind({
      blueprint: first,
      bundleId: "quality_v1",
      type: "agent_skill",
      sourceId: "release-check",
      at,
    });
    const next = companyBlueprintV2Fixture({
      id: "company-v2-revision-2",
      revision: 2,
      previousBlueprintId: first.id,
    });
    await value.activate(next);

    expect(value.bindings(next)).toBeNull();
    expect(value.policyForAgent(child("quality_reviewer"))).toBeUndefined();
  });

  it("exposes an approved root capability to the real agent loop and no others", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "recurs-capability-runtime-")));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const data = path.join(root, "data");
    const home = path.join(root, "home");
    const skill = path.join(home, ".agents", "skills", "release-check");
    await mkdir(workspace, { recursive: true });
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), [
      "---",
      "name: release-check",
      "description: Check the release candidate",
      "---",
      "Return exact release evidence.",
      "",
    ].join("\n"));
    const provider = new ScriptedProvider([
      [{
        type: "tool_call",
        call: {
          id: "approved-skill",
          name: "activate_skill",
          arguments: { name: "release-check" },
        },
      }, { type: "done", stopReason: "tool_calls" }],
      [{ type: "text_delta", text: "Approved capability used." },
        { type: "done", stopReason: "complete" }],
    ]);
    const blueprint = companyBlueprintV2Fixture();
    const runtime = await createStandaloneRuntime(
      { async emit() {} },
      {
        cwd: workspace,
        dataDirectory: data,
        skillHomeDirectory: home,
        provider,
        companyBlueprint: blueprint,
        permissionMode: "approved_for_me",
        operatingModeId: "balanced_v6",
      },
    );
    runtime.setConfirmHandler(async () => true);
    const local = createHostInvocation({
      invocation: "repl",
      userPresent: true,
      remote: false,
      scripted: false,
      embedding: "cli",
    });

    await expect(runtime.submit(
      "/company bind project_context_v1 skill release-check",
      local,
    )).resolves.toMatchObject({
      text: expect.stringContaining("revision 1"),
    });
    await expect(runtime.submit("Use the approved release capability", local))
      .resolves.toMatchObject({ finalText: "Approved capability used." });
    expect(provider.requests[0]?.tools.map((tool) => tool.name))
      .toContain("activate_skill");
    expect(provider.requests[0]?.messages[0]?.content)
      .toContain("release-check");
    expect(JSON.stringify(provider.requests[1]?.messages))
      .toContain("Return exact release evidence.");
    await runtime.close();
  });
});
