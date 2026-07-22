import { createHash } from "node:crypto";

import {
  parseCompanyCapabilityBindingSet,
  parseCompanyBlueprintV2,
  validateCompanyCapabilityBindingsAgainstBlueprint,
  type AgentSessionDescriptor,
  type CompanyCapabilityBindingSetV1,
  type CompanyCapabilitySourceType,
  type CompanyBlueprintV2,
  type CompanyToolBundleId,
} from "@recurs/contracts";
import type { FileCompanyCapabilityStore } from "@recurs/core";

import type { AgentSkillCatalog } from "./agent-skills.js";
import type { McpServerCatalog } from "./mcp-client.js";

export class CompanyCapabilityAuthorityError extends Error {
  constructor(
    readonly code: "invalid_input" | "not_found" | "stale" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "CompanyCapabilityAuthorityError";
  }
}

export interface CompanyRoleCapabilityPolicy {
  readonly agentSkillNames: readonly string[];
  readonly mcpServerIds: readonly string[];
}

interface CapabilityStore {
  latest(
    companyId: string,
    signal?: AbortSignal,
  ): Promise<CompanyCapabilityBindingSetV1 | null>;
  create(
    set: CompanyCapabilityBindingSetV1,
    signal?: AbortSignal,
  ): Promise<void>;
}

function bindingId(
  bundleId: CompanyToolBundleId,
  type: CompanyCapabilitySourceType,
  scope: "user" | "project",
  sourceId: string,
): string {
  const digest = createHash("sha256").update(
    [bundleId, type, scope, sourceId].join("\0"),
  ).digest("hex").slice(0, 32);
  return `capability_${digest}`;
}

function exactBlueprint(
  set: CompanyCapabilityBindingSetV1,
  blueprint: CompanyBlueprintV2,
): boolean {
  return set.companyId === blueprint.companyId &&
    set.blueprintId === blueprint.id &&
    set.blueprintRevision === blueprint.revision;
}

export class CompanyCapabilityAuthority {
  readonly #store: CapabilityStore;
  readonly #skills: Pick<AgentSkillCatalog, "snapshot">;
  readonly #mcp: Pick<McpServerCatalog, "snapshot">;
  #blueprint: CompanyBlueprintV2 | null = null;
  #set: CompanyCapabilityBindingSetV1 | null = null;

  constructor(input: {
    readonly store: Pick<
      FileCompanyCapabilityStore,
      "latest" | "create"
    >;
    readonly skills: Pick<AgentSkillCatalog, "snapshot">;
    readonly mcp: Pick<McpServerCatalog, "snapshot">;
  }) {
    this.#store = input.store;
    this.#skills = input.skills;
    this.#mcp = input.mcp;
  }

  async activate(
    blueprintInput: CompanyBlueprintV2 | null,
    signal?: AbortSignal,
  ): Promise<void> {
    if (blueprintInput === null) {
      this.#blueprint = null;
      this.#set = null;
      return;
    }
    const blueprint = parseCompanyBlueprintV2(blueprintInput);
    if (blueprint.state !== "approved") {
      throw new CompanyCapabilityAuthorityError(
        "invalid_input",
        "Company capabilities require an approved blueprint",
      );
    }
    const latest = await this.#store.latest(blueprint.companyId, signal);
    const set = latest !== null && exactBlueprint(latest, blueprint)
      ? latest
      : null;
    if (set !== null) {
      validateCompanyCapabilityBindingsAgainstBlueprint(set, blueprint);
    }
    this.#blueprint = blueprint;
    this.#set = set;
  }

  bindings(blueprint: CompanyBlueprintV2): CompanyCapabilityBindingSetV1 | null {
    return this.#blueprint?.id === blueprint.id &&
        this.#blueprint.revision === blueprint.revision
      ? this.#set
      : null;
  }

  #source(
    type: CompanyCapabilitySourceType,
    sourceId: string,
  ): { readonly type: CompanyCapabilitySourceType; readonly id: string; readonly scope: "user" | "project" } {
    const matches = type === "agent_skill"
      ? this.#skills.snapshot().skills.filter((skill) =>
          skill.name === sourceId && skill.enabled
        ).map((skill) => ({ type, id: skill.name, scope: skill.source }))
      : this.#mcp.snapshot().servers.filter((server) =>
          server.id === sourceId && server.enabled
        ).map((server) => ({ type, id: server.id, scope: server.source }));
    if (matches.length !== 1) {
      throw new CompanyCapabilityAuthorityError(
        "unavailable",
        type === "agent_skill"
          ? "The Agent Skill is not uniquely enabled"
          : "The MCP server is not uniquely enabled and trusted",
      );
    }
    return matches[0]!;
  }

  #activeBlueprint(blueprint: CompanyBlueprintV2): CompanyBlueprintV2 {
    if (this.#blueprint === null || this.#blueprint.id !== blueprint.id ||
      this.#blueprint.revision !== blueprint.revision) {
      throw new CompanyCapabilityAuthorityError(
        "stale",
        "The active company capability authority targets another blueprint",
      );
    }
    return this.#blueprint;
  }

  async bind(input: {
    readonly blueprint: CompanyBlueprintV2;
    readonly bundleId: CompanyToolBundleId;
    readonly type: CompanyCapabilitySourceType;
    readonly sourceId: string;
    readonly at: string;
    readonly signal?: AbortSignal;
  }): Promise<CompanyCapabilityBindingSetV1> {
    const blueprint = this.#activeBlueprint(input.blueprint);
    if (!blueprint.toolPlan.some((tool) => tool.id === input.bundleId)) {
      throw new CompanyCapabilityAuthorityError(
        "invalid_input",
        "The company blueprint does not approve that tool bundle",
      );
    }
    const source = this.#source(input.type, input.sourceId);
    const latest = await this.#store.latest(blueprint.companyId, input.signal);
    if (latest !== null && latest.blueprintRevision > blueprint.revision) {
      throw new CompanyCapabilityAuthorityError(
        "stale",
        "A newer company blueprint already owns capability authority",
      );
    }
    const current = latest !== null && exactBlueprint(latest, blueprint)
      ? latest
      : null;
    const id = bindingId(input.bundleId, source.type, source.scope, source.id);
    const existing = current?.bindings.find((binding) => binding.id === id);
    if (existing !== undefined) return current!;
    const set = parseCompanyCapabilityBindingSet({
      companyId: blueprint.companyId,
      version: 1,
      revision: (latest?.revision ?? 0) + 1,
      blueprintId: blueprint.id,
      blueprintRevision: blueprint.revision,
      updatedAt: input.at,
      bindings: [...(current?.bindings ?? []), {
        id,
        bundleId: input.bundleId,
        source,
        approvedAt: input.at,
      }],
    });
    validateCompanyCapabilityBindingsAgainstBlueprint(set, blueprint);
    await this.#store.create(set, input.signal);
    this.#set = set;
    return set;
  }

  async unbind(input: {
    readonly blueprint: CompanyBlueprintV2;
    readonly bindingId: string;
    readonly at: string;
    readonly signal?: AbortSignal;
  }): Promise<CompanyCapabilityBindingSetV1> {
    const blueprint = this.#activeBlueprint(input.blueprint);
    const latest = await this.#store.latest(blueprint.companyId, input.signal);
    if (latest === null || !exactBlueprint(latest, blueprint)) {
      throw new CompanyCapabilityAuthorityError(
        "stale",
        "No mutable capability bindings exist for this blueprint revision",
      );
    }
    if (!latest.bindings.some((binding) => binding.id === input.bindingId)) {
      throw new CompanyCapabilityAuthorityError(
        "not_found",
        "Company capability binding was not found",
      );
    }
    const set = parseCompanyCapabilityBindingSet({
      ...latest,
      revision: latest.revision + 1,
      updatedAt: input.at,
      bindings: latest.bindings.filter((binding) =>
        binding.id !== input.bindingId
      ),
    });
    await this.#store.create(set, input.signal);
    this.#set = set;
    return set;
  }

  policyForAgent(
    agent: AgentSessionDescriptor,
  ): CompanyRoleCapabilityPolicy | undefined {
    const binding = agent.company;
    if (binding?.blueprintVersion !== 2 || this.#blueprint === null ||
      binding.blueprintId !== this.#blueprint.id ||
      binding.blueprintRevision !== this.#blueprint.revision) {
      return undefined;
    }
    const role = this.#blueprint.roles.find((candidate) =>
      candidate.id === binding.roleId
    );
    if (role === undefined) return undefined;
    const approved = (this.#set?.bindings ?? []).filter((capability) =>
      role.toolBundles.includes(capability.bundleId)
    );
    const skillSnapshot = this.#skills.snapshot();
    const mcpSnapshot = this.#mcp.snapshot();
    const agentSkillNames = approved.filter((capability) =>
      capability.source.type === "agent_skill" &&
      skillSnapshot.skills.some((skill) =>
        skill.name === capability.source.id &&
        skill.source === capability.source.scope && skill.enabled
      )
    ).map((capability) => capability.source.id);
    const mcpServerIds = approved.filter((capability) =>
      capability.source.type === "mcp_server" &&
      mcpSnapshot.servers.some((server) =>
        server.id === capability.source.id &&
        server.source === capability.source.scope && server.enabled
      )
    ).map((capability) => capability.source.id);
    return Object.freeze({
      agentSkillNames: Object.freeze([...new Set(agentSkillNames)].sort()),
      mcpServerIds: Object.freeze([...new Set(mcpServerIds)].sort()),
    });
  }
}
