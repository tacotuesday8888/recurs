import { describe, expect, it } from "vitest";

import { companyBlueprintV2Fixture } from "../../contracts/test/company-v2-fixture.js";

import { renderCompanyToolReadiness } from "../src/company-tool-readiness.js";

describe("company tool readiness", () => {
  it("reports approved bundles and installed catalogs without inferring authority", () => {
    const blueprint = companyBlueprintV2Fixture();
    const output = renderCompanyToolReadiness({
      ...blueprint,
      toolPlan: [blueprint.toolPlan[0]!, {
        ...blueprint.toolPlan[1]!,
        status: "required",
      }],
    }, {
      skills: {
        projectSkillsEnabled: false,
        warnings: ["private skill warning"],
        skills: [{
          name: "release-check",
          description: "private skill description",
          source: "user",
          location: "/private/skills/release-check",
          enabled: true,
        }, {
          name: "project-helper",
          description: "private project description",
          source: "project",
          location: "/workspace/.agents/skills/project-helper",
          enabled: false,
        }],
      },
      mcp: {
        configPath: "/private/mcp.json",
        projectConfigPath: "/workspace/.recurs/mcp-servers.json",
        projectTrust: "untrusted",
        warnings: ["private MCP warning"],
        servers: [{
          id: "issue-tracker",
          description: "private MCP description",
          command: "/private/bin/server",
          args: ["--secret-path"],
          network: "deny",
          source: "user",
          enabled: true,
          state: "idle",
        }, {
          id: "project-server",
          description: "private project server",
          command: "/workspace/bin/server",
          args: [],
          network: "deny",
          source: "project",
          enabled: false,
          state: "idle",
        }],
      },
    });

    expect(output).toMatch(/Tool bundles: 1 ready, 1 missing/u);
    expect(output).toContain("ready | project_context_v1");
    expect(output).toContain("missing | quality_v1");
    expect(output).toContain("Enabled Agent Skills: release-check");
    expect(output).toContain("Agent Skills found but disabled: 1");
    expect(output).toContain("Enabled MCP servers: issue-tracker");
    expect(output).toContain("MCP servers configured but disabled: 1");
    expect(output).toContain("Project MCP trust: untrusted");
    expect(output).toContain("Catalog binding: exact approved bindings only");
    expect(output).not.toMatch(/private|workspace|secret-path/iu);
  });

  it("states when host catalogs were not inspected", () => {
    const output = renderCompanyToolReadiness(companyBlueprintV2Fixture());

    expect(output).toContain("Agent Skills: not inspected");
    expect(output).toContain("MCP servers: not inspected");
  });

  it("satisfies a required bundle only through an exact available binding", () => {
    const blueprint = companyBlueprintV2Fixture();
    const required = {
      ...blueprint,
      toolPlan: blueprint.toolPlan.map((tool) =>
        tool.id === "quality_v1" ? { ...tool, status: "required" as const } : tool
      ),
    };
    const bindings = {
      companyId: blueprint.companyId,
      version: 1 as const,
      revision: 1,
      blueprintId: blueprint.id,
      blueprintRevision: blueprint.revision,
      updatedAt: "2026-07-22T10:00:00.000Z",
      bindings: [{
        id: "capability-release-check",
        bundleId: "quality_v1" as const,
        source: {
          type: "agent_skill" as const,
          id: "release-check",
          scope: "user" as const,
        },
        approvedAt: "2026-07-22T10:00:00.000Z",
      }],
    };
    const unavailable = renderCompanyToolReadiness(required, {
      skills: { projectSkillsEnabled: false, warnings: [], skills: [] },
    }, bindings);
    const ready = renderCompanyToolReadiness(required, {
      skills: {
        projectSkillsEnabled: false,
        warnings: [],
        skills: [{
          name: "release-check",
          description: "Private description",
          source: "user",
          location: "/private/release-check",
          enabled: true,
        }],
      },
    }, bindings);

    expect(unavailable).toContain("unavailable | capability-release-check");
    expect(unavailable).toContain("Tool bundles: 1 ready, 1 missing");
    expect(ready).toContain("ready | capability-release-check");
    expect(ready).toContain("Tool bundles: 2 ready, 0 missing");
    expect(ready).not.toContain("Private description");
    expect(ready).not.toContain("/private/");
  });
});
