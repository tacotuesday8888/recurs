import type {
  PermissionDecision,
  PermissionIntent,
  PermissionMode,
} from "./types.js";

export function permissionIntentKey(intent: PermissionIntent): string {
  return `${intent.category}\0${intent.resource}`;
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

  constructor(public mode: PermissionMode) {}

  evaluate(intent: PermissionIntent): PermissionDecision {
    if (intent.category === "credential") {
      return "deny";
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
