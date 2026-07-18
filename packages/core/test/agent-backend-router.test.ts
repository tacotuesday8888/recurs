import type {
  AgentExecutionMode,
  AgentPermissionMode,
  SessionBackendPin,
  TeamRunRole,
} from "@recurs/contracts";
import { describe, expect, it } from "vitest";

import {
  AgentBackendRouter,
  type AgentBackendCandidate,
} from "../src/index.js";
import { testBackendPin } from "../../../tests/support/backend.js";

function pin(id: string, overrides: Partial<SessionBackendPin> = {}): SessionBackendPin {
  const base = testBackendPin();
  return {
    ...base,
    connectionId: `connection-${id}`,
    modelId: `model-${id}`,
    billingSelectionAtCreation: {
      ...base.billingSelectionAtCreation,
      allowedSources: [...base.billingSelectionAtCreation.allowedSources],
    },
    ...overrides,
  };
}

function candidate(
  id: string,
  options: Partial<AgentBackendCandidate> = {},
): AgentBackendCandidate {
  return {
    id,
    pin: pin(id),
    parent: false,
    roles: ["implement", "review", "repair"],
    executionModes: ["act"],
    permissionModes: ["approved_for_me", "full_access"],
    hostTools: true,
    background: true,
    ready: true,
    ...options,
  };
}

function input(
  candidates: readonly AgentBackendCandidate[],
  overrides: Partial<{
    role: TeamRunRole;
    executionMode: AgentExecutionMode;
    permissionMode: AgentPermissionMode;
    background: boolean;
  }> = {},
) {
  return {
    role: "implement" as const,
    executionMode: "act" as const,
    permissionMode: "approved_for_me" as const,
    background: false,
    candidates,
    ...overrides,
  };
}

describe("AgentBackendRouter", () => {
  it("selects the first eligible role candidate and otherwise falls back to parent", () => {
    const router = new AgentBackendRouter();
    const unavailable = candidate("unavailable", { ready: false });
    const first = candidate("first", { roles: ["review"] });
    const second = candidate("second", { roles: ["review"] });
    const parent = candidate("parent", { parent: true });

    expect(router.select(input(
      [unavailable, first, second, parent],
      { role: "review" },
    ))).toMatchObject({
      strategy: "role_candidate",
      candidateId: "first",
      reason: "eligible_role_candidate",
      role: "review",
    });
    expect(router.select(input([parent], { background: true }))).toMatchObject({
      strategy: "inherit_parent",
      candidateId: "parent",
      reason: "parent_fallback",
    });
  });

  it("fails background eligibility closed for runtime and unreviewed billing", () => {
    const router = new AgentBackendRouter();
    const foregroundOnly = candidate("foreground", { background: false });
    const runtimePin = pin("runtime", {
      kind: "agent_runtime",
      runtimeCapabilityProfileRevisionAtCreation: "runtime-v1",
    });
    const runtime = candidate("runtime", { pin: runtimePin });
    const subscription = candidate("subscription", {
      pin: pin("subscription", {
        primaryBillingSourceAtCreation: "included_subscription",
      }),
    });

    for (const item of [foregroundOnly, runtime, subscription]) {
      expect(() => router.select(input(
        [item],
        { role: "repair", background: true },
      ))).toThrow(/eligible agent backend/u);
    }
  });

  it("authenticates a defensive deep-frozen snapshot to one router and exact route", () => {
    const router = new AgentBackendRouter();
    const other = new AgentBackendRouter();
    const mutablePin = pin("mutable");
    const decision = router.select(input([
      candidate("mutable", { pin: mutablePin }),
    ]));

    mutablePin.billingSelectionAtCreation.allowedSources[0] =
      "included_subscription";
    expect(decision.pin.billingSelectionAtCreation.allowedSources).toEqual([
      "local_compute",
    ]);
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.pin)).toBe(true);
    expect(Object.isFrozen(decision.pin.billingSelectionAtCreation)).toBe(true);
    expect(Object.isFrozen(decision.pin.billingSelectionAtCreation.allowedSources))
      .toBe(true);
    expect(router.validate(decision, {
      role: "implement",
      executionMode: "act",
      permissionMode: "approved_for_me",
      background: false,
    })).toBe(decision);
    expect(() => other.validate(decision, {
      role: "implement",
      executionMode: "act",
      permissionMode: "approved_for_me",
      background: false,
    })).toThrow(/trusted backend route/u);
    expect(() => router.validate(decision, {
      role: "repair",
      executionMode: "act",
      permissionMode: "approved_for_me",
      background: false,
    })).toThrow(/does not match/u);
  });
});
