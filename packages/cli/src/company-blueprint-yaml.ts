import {
  parseCompanyBlueprintV2,
  type CompanyBlueprintV2,
} from "@recurs/contracts";
import { parseAllDocuments, stringify, visit } from "yaml";

const MAX_YAML_BYTES = 512 * 1024;
const encoder = new TextEncoder();

export class CompanyBlueprintYamlError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CompanyBlueprintYamlError";
  }
}

export function renderCompanyBlueprintYaml(
  blueprint: CompanyBlueprintV2,
): string {
  const parsed = parseCompanyBlueprintV2(blueprint);
  return stringify(parsed, {
    indent: 2,
    lineWidth: 0,
    sortMapEntries: false,
  });
}

export function parseCompanyBlueprintYaml(text: string): CompanyBlueprintV2 {
  if (text.length === 0 || encoder.encode(text).byteLength > MAX_YAML_BYTES ||
    text.includes("\0")) {
    throw new CompanyBlueprintYamlError(
      `Company YAML must be UTF-8 text no larger than ${MAX_YAML_BYTES} bytes`,
    );
  }
  const documents = parseAllDocuments(text, {
    schema: "core",
    uniqueKeys: true,
    prettyErrors: false,
  });
  if (documents.length !== 1 || documents[0] === undefined) {
    throw new CompanyBlueprintYamlError("Company YAML must contain one document");
  }
  const document = documents[0];
  if (document.errors.length > 0) {
    throw new CompanyBlueprintYamlError(
      `Company YAML is invalid: ${document.errors[0]!.message}`,
    );
  }
  let aliases = false;
  visit(document, { Alias() { aliases = true; } });
  if (aliases) {
    throw new CompanyBlueprintYamlError("Company YAML aliases are not allowed");
  }
  try {
    return parseCompanyBlueprintV2(document.toJS({ maxAliasCount: 0 }));
  } catch (error) {
    throw new CompanyBlueprintYamlError(
      `Company YAML does not describe a valid blueprint: ${
        error instanceof Error ? error.message : "invalid value"
      }`,
      { cause: error },
    );
  }
}

export function diffCompanyBlueprints(
  previous: CompanyBlueprintV2,
  next: CompanyBlueprintV2,
): readonly string[] {
  const left = parseCompanyBlueprintV2(previous);
  const right = parseCompanyBlueprintV2(next);
  const changes: string[] = [];
  if (left.designMode !== right.designMode) {
    changes.push(`Design: ${left.designMode} → ${right.designMode}`);
  }
  if (left.project.purpose !== right.project.purpose) {
    changes.push("Project purpose changed");
  }
  if (JSON.stringify(left.project) !== JSON.stringify(right.project)) {
    changes.push("Project brief changed");
  }
  const leftDepartments = new Map(left.departments.map((item) => [item.id, item]));
  const rightDepartments = new Map(right.departments.map((item) => [item.id, item]));
  for (const department of right.departments) {
    if (!leftDepartments.has(department.id)) {
      changes.push(`Department added: ${department.displayName}`);
    } else if (JSON.stringify(leftDepartments.get(department.id)) !==
      JSON.stringify(department)) {
      changes.push(`Department changed: ${department.displayName}`);
    }
  }
  for (const department of left.departments) {
    if (!rightDepartments.has(department.id)) {
      changes.push(`Department removed: ${department.displayName}`);
    }
  }
  const leftRoles = new Map(left.roles.map((item) => [item.id, item]));
  const rightRoles = new Map(right.roles.map((item) => [item.id, item]));
  for (const role of right.roles) {
    if (!leftRoles.has(role.id)) {
      changes.push(`Role added: ${role.displayName}`);
    } else if (JSON.stringify(leftRoles.get(role.id)) !== JSON.stringify(role)) {
      changes.push(`Role changed: ${role.displayName}`);
    }
  }
  for (const role of left.roles) {
    if (!rightRoles.has(role.id)) changes.push(`Role removed: ${role.displayName}`);
  }
  if (JSON.stringify(left.authority) !== JSON.stringify(right.authority)) {
    changes.push("Authority changed");
  }
  if (JSON.stringify(left.activation) !== JSON.stringify(right.activation)) {
    changes.push("Default role activation changed");
  }
  if (JSON.stringify(left.toolPlan) !== JSON.stringify(right.toolPlan)) {
    changes.push("Tool readiness plan changed");
  }
  if (JSON.stringify(left.quality) !== JSON.stringify(right.quality)) {
    changes.push("Quality policy changed");
  }
  if (left.initialGoal !== right.initialGoal) changes.push("Initial goal changed");
  if (JSON.stringify(left.roadmap) !== JSON.stringify(right.roadmap)) {
    changes.push("Roadmap changed");
  }
  return Object.freeze(changes.slice(0, 128));
}
