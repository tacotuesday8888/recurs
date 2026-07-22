import { isDeepStrictEqual } from "node:util";

import type {
  AgentExecutionMode,
  AgentPermissionMode,
  SessionBackendPin,
  TeamRunRole,
} from "@recurs/contracts";
import { ToolError } from "@recurs/tools";

export interface AgentBackendCandidate {
  readonly id: string;
  readonly pin: SessionBackendPin;
  readonly parent: boolean;
  readonly roles: readonly TeamRunRole[];
  readonly executionModes: readonly AgentExecutionMode[];
  readonly permissionModes: readonly AgentPermissionMode[];
  readonly hostTools: boolean;
  readonly background: boolean;
  readonly ready: boolean;
}

export interface AgentBackendRouteInput {
  readonly role: TeamRunRole;
  /** Select an explicitly assigned candidate for this route while preserving the child's actual role. */
  readonly candidateRole?: TeamRunRole;
  readonly executionMode: AgentExecutionMode;
  readonly permissionMode: AgentPermissionMode;
  readonly background: boolean;
  readonly candidates: readonly AgentBackendCandidate[];
}

export interface AgentBackendRouteBinding {
  readonly role: TeamRunRole;
  readonly executionMode: AgentExecutionMode;
  readonly permissionMode: AgentPermissionMode;
  readonly background: boolean;
}

export interface AgentBackendRouteDecision extends AgentBackendRouteBinding {
  readonly strategy: "inherit_parent" | "role_candidate";
  readonly candidateId: string;
  readonly reason: "parent_fallback" | "eligible_role_candidate";
  readonly pin: SessionBackendPin;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function trustedPin(pin: SessionBackendPin): SessionBackendPin {
  return deepFreeze(structuredClone(pin)) as SessionBackendPin;
}

function backgroundEligible(pin: SessionBackendPin): boolean {
  const safeSources = new Set(["local_compute", "metered_api"]);
  const allowedSources = pin.billingSelectionAtCreation.allowedSources;
  return pin.kind === "model_provider" && (
    pin.primaryBillingSourceAtCreation === "local_compute" ||
    pin.primaryBillingSourceAtCreation === "metered_api"
  ) && allowedSources.length > 0 &&
    allowedSources.includes(pin.primaryBillingSourceAtCreation) &&
    allowedSources.every((source) => safeSources.has(source));
}

export class AgentBackendRouter {
  readonly #decisions = new WeakMap<object, AgentBackendRouteDecision>();

  select(input: AgentBackendRouteInput): AgentBackendRouteDecision {
    const candidateRole = input.candidateRole ?? input.role;
    const eligible = input.candidates.filter((candidate) =>
      candidate.ready &&
      candidate.hostTools &&
      candidate.roles.includes(candidateRole) &&
      candidate.executionModes.includes(input.executionMode) &&
      candidate.permissionModes.includes(input.permissionMode) &&
      (!input.background || (
        candidate.background && backgroundEligible(candidate.pin)
      ))
    );
    const selected = eligible.find((candidate) => !candidate.parent) ??
      eligible.find((candidate) => candidate.parent);
    if (selected === undefined) {
      throw new ToolError("tool_unavailable", "No eligible agent backend");
    }
    const decision = deepFreeze({
      role: input.role,
      executionMode: input.executionMode,
      permissionMode: input.permissionMode,
      background: input.background,
      strategy: selected.parent ? "inherit_parent" as const : "role_candidate" as const,
      candidateId: selected.id,
      reason: selected.parent ? "parent_fallback" as const : "eligible_role_candidate" as const,
      pin: trustedPin(selected.pin),
    }) as AgentBackendRouteDecision;
    this.#decisions.set(decision, structuredClone(decision));
    return decision;
  }

  validate(
    decision: AgentBackendRouteDecision,
    binding: AgentBackendRouteBinding,
  ): AgentBackendRouteDecision {
    const trusted = this.#decisions.get(decision);
    if (trusted === undefined || !isDeepStrictEqual(decision, trusted)) {
      throw new ToolError("permission_denied", "A trusted backend route is required");
    }
    if (
      decision.role !== binding.role ||
      decision.executionMode !== binding.executionMode ||
      decision.permissionMode !== binding.permissionMode ||
      decision.background !== binding.background
    ) {
      throw new ToolError(
        "permission_denied",
        "The trusted backend route does not match this child",
      );
    }
    return decision;
  }
}
