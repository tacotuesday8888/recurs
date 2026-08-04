import type {
  PermissionDecision,
  PermissionIntent,
  PermissionMode,
} from "./types.js";

export function permissionIntentKey(intent: PermissionIntent): string {
  return `${intent.category}\0${intent.resource}`;
}

export interface PermissionRule {
  readonly id: string;
  readonly decision: PermissionDecision;
  readonly intent: PermissionIntent;
}

function isNormalWorkspaceAction(intent: PermissionIntent): boolean {
  return (
    intent.risk === "normal" &&
    (intent.category === "read" ||
      intent.category === "write")
  );
}

export class PermissionEngine {
  readonly integrityGuardsEnabled = true;
  readonly #sessionGrants = new Set<string>();
  readonly #rules: readonly PermissionRule[];

  constructor(
    public mode: PermissionMode,
    rules: readonly PermissionRule[] = [],
  ) {
    this.#rules = Object.freeze(rules.map((rule) => Object.freeze({
      ...rule,
      intent: Object.freeze({ ...rule.intent }),
    })));
  }

  evaluate(intent: PermissionIntent): PermissionDecision {
    if (intent.category === "credential") {
      return "deny";
    }
    const configured = this.#rules.find((rule) =>
      permissionIntentKey(rule.intent) === permissionIntentKey(intent) &&
      rule.intent.risk === intent.risk
    );
    if (configured !== undefined) {
      return configured.decision;
    }
    if (this.#sessionGrants.has(permissionIntentKey(intent))) {
      return "allow";
    }

    if (this.mode === "full_access") {
      const needsExplicitPathApproval =
        intent.category === "external_path" || intent.category === "sensitive";
      return needsExplicitPathApproval ? "ask" : "allow";
    }

    if (this.mode === "approved_for_me") {
      return isNormalWorkspaceAction(intent) ? "allow" : "ask";
    }

    return intent.category === "read" && intent.risk === "normal"
      ? "allow"
      : "ask";
  }

  grantForSession(intent: PermissionIntent): void {
    if (intent.category === "credential") {
      return;
    }
    this.#sessionGrants.add(permissionIntentKey(intent));
  }

  clearSessionGrants(): void {
    this.#sessionGrants.clear();
  }
}
