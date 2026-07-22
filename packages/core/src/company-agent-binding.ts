import {
  parseCompanyBlueprintBinding,
  parseCompanyBlueprintBindingV2,
  getOperatingModePolicy,
  type AgentLimits,
  type CompanyAgentBinding,
  type OperatingModeId,
} from "@recurs/contracts";

export function parseCompanyAgentBinding(
  value: unknown,
): CompanyAgentBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Company agent binding must be an object");
  }
  return (value as { readonly blueprintVersion?: unknown }).blueprintVersion === 2
    ? parseCompanyBlueprintBindingV2(value)
    : parseCompanyBlueprintBinding(value);
}

export function companyAgentLimits(
  operatingModeId: OperatingModeId,
  binding?: CompanyAgentBinding,
): AgentLimits {
  const mode = getOperatingModePolicy(operatingModeId);
  if (binding?.blueprintVersion !== 2) return mode.orchestration;
  if (mode.company === undefined) {
    throw new TypeError("Company V2 agents require a company operating mode");
  }
  return Object.freeze({
    ...mode.orchestration,
    maxDepth: mode.company.maxDepth,
    maxConcurrentChildren: mode.company.maxConcurrentAssignments,
    maxRequests: mode.company.maxGoalRequests,
    maxReportedCostUsd: mode.company.maxReportedCostUsd,
  });
}
