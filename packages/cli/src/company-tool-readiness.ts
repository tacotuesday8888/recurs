import {
  validateCompanyCapabilityBindingsAgainstBlueprint,
  type CompanyBlueprintV2,
  type CompanyCapabilityBindingSetV1,
  type CompanyToolBundleId,
} from "@recurs/contracts";

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

export interface CompanyCapabilityResolution {
  readonly bundleId: CompanyToolBundleId;
  readonly ready: boolean;
  readonly bindings: readonly {
    readonly id: string;
    readonly source: "agent_skill" | "mcp_server";
    readonly sourceId: string;
    readonly available: boolean;
  }[];
}

function bindingAvailable(
  binding: CompanyCapabilityBindingSetV1["bindings"][number],
  catalogs: CompanyCapabilityCatalogs,
): boolean {
  return binding.source.type === "agent_skill"
    ? (catalogs.skills?.skills.some((skill) =>
        skill.name === binding.source.id &&
        skill.source === binding.source.scope && skill.enabled
      ) ?? false)
    : (catalogs.mcp?.servers.some((server) =>
        server.id === binding.source.id &&
        server.source === binding.source.scope && server.enabled
      ) ?? false);
}

export function resolveCompanyCapabilities(
  blueprint: CompanyBlueprintV2,
  catalogs: CompanyCapabilityCatalogs = {},
  set: CompanyCapabilityBindingSetV1 | null = null,
): readonly CompanyCapabilityResolution[] {
  if (set !== null) {
    validateCompanyCapabilityBindingsAgainstBlueprint(set, blueprint);
  }
  return Object.freeze(blueprint.toolPlan.map((tool) => {
    const bindings = (set?.bindings ?? []).filter((binding) =>
      binding.bundleId === tool.id
    ).map((binding) => Object.freeze({
      id: binding.id,
      source: binding.source.type,
      sourceId: binding.source.id,
      available: bindingAvailable(binding, catalogs),
    }));
    return Object.freeze({
      bundleId: tool.id,
      ready: tool.status === "available" || bindings.some((binding) =>
        binding.available
      ),
      bindings: Object.freeze(bindings),
    });
  }));
}

export function companyToolReadinessCounts(
  blueprint: CompanyBlueprintV2,
  catalogs: CompanyCapabilityCatalogs = {},
  set: CompanyCapabilityBindingSetV1 | null = null,
): CompanyToolReadinessCounts {
  const resolved = resolveCompanyCapabilities(blueprint, catalogs, set);
  const ready = resolved.filter((tool) => tool.ready).length;
  return Object.freeze({ ready, missing: resolved.length - ready });
}

export function renderCompanyToolReadiness(
  blueprint: CompanyBlueprintV2,
  catalogs: CompanyCapabilityCatalogs = {},
  set: CompanyCapabilityBindingSetV1 | null = null,
): string {
  const resolved = resolveCompanyCapabilities(blueprint, catalogs, set);
  const counts = companyToolReadinessCounts(blueprint, catalogs, set);
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
    ...resolved.flatMap((tool) => [
      `  ${tool.ready ? "ready" : "missing"} | ${tool.bundleId}`,
      ...tool.bindings.map((binding) =>
        `    ${binding.available ? "ready" : "unavailable"} | ${binding.id} | ${binding.source}:${binding.sourceId}`
      ),
    ]),
    set === null
      ? "Approved capability bindings: none"
      : `Approved capability bindings: ${set.bindings.length} (revision ${set.revision})`,
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
    "Catalog binding: exact approved bindings only. Discovery never infers a mapping, installs or trusts a capability, or widens role authority.",
  ].join("\n");
}
