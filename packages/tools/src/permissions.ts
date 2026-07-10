import type {
  PermissionDecision,
  PermissionIntent,
  PermissionMode,
} from "./types.js";

function grantKey(intent: PermissionIntent): string {
  return `${intent.category}\0${intent.resource}`;
}

function isNormalWorkspaceAction(intent: PermissionIntent): boolean {
  return (
    intent.risk === "normal" &&
    (intent.category === "read" ||
      intent.category === "write" ||
      intent.category === "shell")
  );
}

export class PermissionEngine {
  readonly integrityGuardsEnabled = true;
  readonly #sessionGrants = new Set<string>();

  constructor(public mode: PermissionMode) {}

  evaluate(intent: PermissionIntent): PermissionDecision {
    if (this.#sessionGrants.has(grantKey(intent))) {
      return "allow";
    }

    if (this.mode === "full_access") {
      return "allow";
    }

    if (this.mode === "approved_for_me") {
      return isNormalWorkspaceAction(intent) ? "allow" : "ask";
    }

    return intent.category === "read" && intent.risk === "normal"
      ? "allow"
      : "ask";
  }

  grantForSession(intent: PermissionIntent): void {
    this.#sessionGrants.add(grantKey(intent));
  }

  clearSessionGrants(): void {
    this.#sessionGrants.clear();
  }
}
