import type { CompanyBlueprintV2 } from "@recurs/contracts";

import type { AgentSkillSnapshot } from "./agent-skills.js";
import type { McpCatalogSnapshot } from "./mcp-client.js";

export interface CompanyCapabilityCatalogs {
  readonly skills?: AgentSkillSnapshot;
  readonly mcp?: McpCatalogSnapshot;
}

export interface CompanyToolReadinessCounts {
  readonly ready: number;
  readonly missing: number;
}

export function companyToolReadinessCounts(
  blueprint: CompanyBlueprintV2,
): CompanyToolReadinessCounts {
  const ready = blueprint.toolPlan.filter((tool) =>
    tool.status === "available"
  ).length;
  return Object.freeze({ ready, missing: blueprint.toolPlan.length - ready });
}

export function renderCompanyToolReadiness(
  blueprint: CompanyBlueprintV2,
  catalogs: CompanyCapabilityCatalogs = {},
): string {
  const counts = companyToolReadinessCounts(blueprint);
  const skills = catalogs.skills?.skills ?? [];
  const enabledSkills = skills.filter((skill) => skill.enabled)
    .map((skill) => skill.name);
  const disabledSkills = skills.length - enabledSkills.length;
  const servers = catalogs.mcp?.servers ?? [];
  const enabledServers = servers.filter((server) => server.enabled)
    .map((server) => server.id);
  const disabledServers = servers.length - enabledServers.length;

  return [
    "Company capability readiness",
    `Blueprint: ${blueprint.id} (revision ${blueprint.revision})`,
    `Tool bundles: ${counts.ready} ready, ${counts.missing} missing`,
    ...blueprint.toolPlan.map((tool) =>
      `  ${tool.status === "available" ? "ready" : "missing"} | ${tool.id}`
    ),
    catalogs.skills === undefined
      ? "Agent Skills: not inspected"
      : `Enabled Agent Skills: ${enabledSkills.join(", ") || "none"}`,
    ...(catalogs.skills === undefined
      ? []
      : [`Agent Skills found but disabled: ${disabledSkills}`]),
    catalogs.mcp === undefined
      ? "MCP servers: not inspected"
      : `Enabled MCP servers: ${enabledServers.join(", ") || "none"}`,
    ...(catalogs.mcp === undefined
      ? []
      : [
          `MCP servers configured but disabled: ${disabledServers}`,
          `Project MCP trust: ${catalogs.mcp.projectTrust}`,
        ]),
    "Catalog binding: none inferred. Installed Skills and MCP servers are reported separately as supplemental capabilities; discovery never installs, trusts, satisfies a tool bundle, or grants role authority automatically.",
  ].join("\n");
}
