import type {
  RuntimeApprovalDecision,
  RuntimeApprovalRequest,
} from "@recurs/contracts";
import type { PermissionIntent } from "@recurs/tools";

export type RuntimeApprovalHandlerResult =
  | {
      readonly decision: { readonly outcome: "selected"; readonly optionId: string };
      readonly scope: "allow_once" | "allow_session" | "deny";
    }
  | {
      readonly decision: { readonly outcome: "cancelled" };
      readonly scope: "cancel";
    };

export interface RuntimeApprovalResolution {
  readonly decision: RuntimeApprovalDecision;
  readonly scope: "allow_once" | "allow_session" | "deny" | "cancel";
  readonly provenance: "user" | "policy" | "signal";
}

export function runtimePermissionIntent(
  request: RuntimeApprovalRequest,
): PermissionIntent {
  if (request.action === "unknown") {
    return {
      category: "sensitive",
      resource: request.resource,
      risk: "elevated",
    };
  }
  return {
    category: request.action,
    resource: request.resource,
    risk: request.risk,
  };
}

export function cancelledResolution(
  provenance: "user" | "signal",
): RuntimeApprovalResolution {
  return {
    decision: { outcome: "cancelled" },
    scope: "cancel",
    provenance,
  };
}

export function exactPolicyResolution(
  request: RuntimeApprovalRequest,
  kind: "allow_once" | "reject_once",
  scope: "allow_once" | "allow_session" | "deny",
): RuntimeApprovalResolution | null {
  const options = request.options.filter((option) => option.kind === kind);
  return options.length === 1
    ? {
        decision: { outcome: "selected", optionId: options[0]!.optionId },
        scope,
        provenance: "policy",
      }
    : null;
}

export function validHandlerResolution(
  value: unknown,
): RuntimeApprovalHandlerResult | null {
  if (!(isObject(value) && exactKeys(value, ["decision", "scope"]) &&
    isObject(value.decision))) {
    return null;
  }
  if (value.decision.outcome === "cancelled") {
    return exactKeys(value.decision, ["outcome"]) && value.scope === "cancel"
      ? value as unknown as RuntimeApprovalHandlerResult
      : null;
  }
  return value.decision.outcome === "selected" &&
    exactKeys(value.decision, ["outcome", "optionId"]) &&
    typeof value.decision.optionId === "string" &&
    (value.scope === "allow_once" || value.scope === "allow_session" ||
      value.scope === "deny")
    ? value as unknown as RuntimeApprovalHandlerResult
    : null;
}

export function runtimeGrantKey(
  request: RuntimeApprovalRequest,
  optionId: string,
): string {
  return JSON.stringify([
    request.action,
    request.resource,
    request.risk,
    request.summary,
    request.options.map((option) => [
      option.optionId,
      option.name,
      option.kind,
    ]),
    request.details ?? null,
    optionId,
  ]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const allowed = new Set(required);
  return required.every((key) => key in value) &&
    Object.keys(value).every((key) => allowed.has(key));
}
