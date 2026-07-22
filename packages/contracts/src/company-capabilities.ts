import {
  contractDeepFreeze,
  contractEnum,
  contractExact,
  contractId,
  contractInteger,
  contractRecord,
  contractTimestamp,
} from "./company-contract-utils.js";
import type { CompanyToolBundleId } from "./company.js";
import {
  parseCompanyBlueprintV2,
  type CompanyBlueprintV2,
} from "./company-v2.js";

export type CompanyCapabilitySourceType = "agent_skill" | "mcp_server";
export type CompanyCapabilitySourceScope = "user" | "project";

export interface CompanyCapabilitySourceV1 {
  readonly type: CompanyCapabilitySourceType;
  readonly id: string;
  readonly scope: CompanyCapabilitySourceScope;
}

export interface CompanyCapabilityBindingV1 {
  readonly id: string;
  readonly bundleId: CompanyToolBundleId;
  readonly source: CompanyCapabilitySourceV1;
  readonly approvedAt: string;
}

export interface CompanyCapabilityBindingSetV1 {
  readonly companyId: string;
  readonly version: 1;
  readonly revision: number;
  readonly blueprintId: string;
  readonly blueprintRevision: number;
  readonly updatedAt: string;
  readonly bindings: readonly CompanyCapabilityBindingV1[];
}

const sourceTypes = new Set<string>(["agent_skill", "mcp_server"]);
const sourceScopes = new Set<string>(["user", "project"]);
const toolBundles = new Set<string>([
  "project_context_v1",
  "source_control_v1",
  "architecture_v1",
  "implementation_v1",
  "quality_v1",
  "security_v1",
  "release_v1",
]);

function parseSource(value: unknown): CompanyCapabilitySourceV1 {
  const source = contractRecord(value, "Company capability source");
  contractExact(
    source,
    ["type", "id", "scope"],
    "Company capability source",
  );
  return {
    type: contractEnum<CompanyCapabilitySourceType>(
      source.type,
      sourceTypes,
      "Company capability source type",
    ),
    id: contractId(source.id, "Company capability source id"),
    scope: contractEnum<CompanyCapabilitySourceScope>(
      source.scope,
      sourceScopes,
      "Company capability source scope",
    ),
  };
}

function parseBinding(value: unknown): CompanyCapabilityBindingV1 {
  const binding = contractRecord(value, "Company capability binding");
  contractExact(
    binding,
    ["id", "bundleId", "source", "approvedAt"],
    "Company capability binding",
  );
  return {
    id: contractId(binding.id, "Company capability binding id"),
    bundleId: contractEnum<CompanyToolBundleId>(
      binding.bundleId,
      toolBundles,
      "Company capability bundle",
    ),
    source: parseSource(binding.source),
    approvedAt: contractTimestamp(
      binding.approvedAt,
      "Company capability approval timestamp",
    ),
  };
}

function semanticKey(binding: CompanyCapabilityBindingV1): string {
  return [
    binding.bundleId,
    binding.source.type,
    binding.source.scope,
    binding.source.id,
  ].join("\0");
}

export function parseCompanyCapabilityBindingSet(
  value: unknown,
): CompanyCapabilityBindingSetV1 {
  const set = contractRecord(value, "Company capability binding set");
  contractExact(set, [
    "companyId",
    "version",
    "revision",
    "blueprintId",
    "blueprintRevision",
    "updatedAt",
    "bindings",
  ], "Company capability binding set");
  if (set.version !== 1 || !Array.isArray(set.bindings) ||
    set.bindings.length > 128) {
    throw new TypeError("Company capability binding set version or bindings are invalid");
  }
  const bindings = set.bindings.map(parseBinding);
  if (new Set(bindings.map((binding) => binding.id)).size !== bindings.length) {
    throw new TypeError("Company capability binding ids must be unique");
  }
  if (new Set(bindings.map(semanticKey)).size !== bindings.length) {
    throw new TypeError("Company capability binding set contains a duplicate grant");
  }
  const updatedAt = contractTimestamp(
    set.updatedAt,
    "Company capability binding set timestamp",
  );
  if (bindings.some((binding) => binding.approvedAt > updatedAt)) {
    throw new TypeError("Company capability approval cannot be newer than its binding set");
  }
  const parsed: CompanyCapabilityBindingSetV1 = {
    companyId: contractId(set.companyId, "Company capability company id"),
    version: 1,
    revision: contractInteger(
      set.revision,
      "Company capability binding set revision",
      1,
    ),
    blueprintId: contractId(
      set.blueprintId,
      "Company capability blueprint id",
    ),
    blueprintRevision: contractInteger(
      set.blueprintRevision,
      "Company capability blueprint revision",
      1,
    ),
    updatedAt,
    bindings,
  };
  return contractDeepFreeze(
    structuredClone(parsed),
  ) as CompanyCapabilityBindingSetV1;
}

export function validateCompanyCapabilityBindingsAgainstBlueprint(
  input: CompanyCapabilityBindingSetV1,
  blueprintInput: CompanyBlueprintV2,
): void {
  const set = parseCompanyCapabilityBindingSet(input);
  const blueprint = parseCompanyBlueprintV2(blueprintInput);
  if (blueprint.state !== "approved" || blueprint.approvedAt === null) {
    throw new TypeError("Company capability bindings require an approved blueprint");
  }
  if (set.companyId !== blueprint.companyId ||
    set.blueprintId !== blueprint.id ||
    set.blueprintRevision !== blueprint.revision) {
    throw new TypeError("Company capability binding blueprint revision is stale");
  }
  const approvedBundles = new Set(blueprint.toolPlan.map((item) => item.id));
  if (set.bindings.some((binding) => !approvedBundles.has(binding.bundleId))) {
    throw new TypeError("Company capability binding references an unapproved bundle");
  }
  if (set.bindings.some((binding) => binding.approvedAt < blueprint.approvedAt!)) {
    throw new TypeError("Company capability binding predates blueprint approval");
  }
}
