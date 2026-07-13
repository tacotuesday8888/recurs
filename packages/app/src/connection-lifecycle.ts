import type { BillingSource } from "@recurs/contracts";

import {
  ConnectionRegistryError,
  type FileConnectionRegistry,
} from "./connection-registry.js";
import type {
  ConnectionRecord,
  ConnectionRegistryDocument,
  ConnectionRegistryMutation,
  DelegatedConnectionRecord,
  LocalConnectionRecord,
} from "./connection-registry-model.js";

const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_MUTATION_ATTEMPTS = 3;

export type ConnectionLifecycleErrorCode =
  | "connection_not_found"
  | "registry_changed"
  | "verification_failed"
  | "operation_unavailable"
  | "cancelled";

export type ConnectionVerificationFailureReason =
  | "connection_unavailable"
  | "authentication_required"
  | "account_mismatch"
  | "model_unavailable"
  | "policy_stale"
  | "adapter_unavailable";

const VERIFICATION_MESSAGES: Readonly<
  Record<ConnectionVerificationFailureReason, string>
> = Object.freeze({
  connection_unavailable: "Connection is unavailable",
  authentication_required: "Connection requires authentication",
  account_mismatch: "The active account does not match this connection",
  model_unavailable: "The configured model is unavailable",
  policy_stale: "Connection policy requires setup again",
  adapter_unavailable: "Connection adapter is unavailable",
});

export class ConnectionLifecycleError extends Error {
  readonly reason: ConnectionVerificationFailureReason | undefined;

  constructor(
    public readonly code: ConnectionLifecycleErrorCode,
    message: string,
    options: ErrorOptions & {
      readonly reason?: ConnectionVerificationFailureReason;
    } = {},
  ) {
    super(message, options);
    this.name = "ConnectionLifecycleError";
    this.reason = options.reason;
  }
}

export interface ConnectionRegistryPort {
  read(): Promise<ConnectionRegistryDocument>;
  migrateLegacyLocal(options?: {
    signal?: AbortSignal;
  }): Promise<ConnectionRegistryDocument>;
  commit(
    expectedRevision: number,
    mutation: ConnectionRegistryMutation,
    options?: { signal?: AbortSignal },
  ): Promise<ConnectionRegistryDocument>;
}

export interface ConnectionSummary {
  readonly id: string;
  readonly label: string;
  readonly providerId: string;
  readonly adapterId: string;
  readonly kind:
    | "local_openai_compatible"
    | "delegated_agent"
    | "brokered_model_provider";
  readonly modelId: string;
  readonly primary: boolean;
  readonly account:
    | "verified (identifier redacted)"
    | "local endpoint (no credential)";
  readonly execution: "Plan-only" | "Act + Plan";
  readonly billingSources: readonly BillingSource[];
}

export type ConnectionVerificationDecision =
  | { readonly status: "verified" }
  | {
      readonly status: "failed";
      readonly reason: ConnectionVerificationFailureReason;
    };

export interface ConnectionVerifier {
  verifyLocal(
    record: Readonly<LocalConnectionRecord>,
    signal: AbortSignal,
  ): Promise<ConnectionVerificationDecision>;
  verifyDelegated(
    record: Readonly<DelegatedConnectionRecord>,
    signal: AbortSignal,
  ): Promise<ConnectionVerificationDecision>;
}

export interface ConnectionVerification {
  readonly verified: true;
  readonly connection: ConnectionSummary;
}

export interface ConnectionDisconnection {
  readonly connectionId: string;
  readonly primaryCleared: boolean;
  readonly remainingConnections: number;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function summary(
  connection: ConnectionRecord,
  primaryConnectionId: string | null,
): ConnectionSummary {
  if (connection.kind === "local_openai_compatible") {
    return deepFreeze({
      id: connection.id,
      label: connection.label,
      providerId: connection.providerId,
      adapterId: connection.adapterId,
      kind: connection.kind,
      modelId: connection.modelId,
      primary: primaryConnectionId === connection.id,
      account: "local endpoint (no credential)" as const,
      execution: "Act + Plan" as const,
      billingSources: ["local_compute" as const],
    });
  }
  return deepFreeze({
    id: connection.id,
    label: connection.label,
    providerId: connection.providerId,
    adapterId: connection.adapterId,
    kind: connection.kind,
    modelId: connection.modelId,
    primary: primaryConnectionId === connection.id,
    account: "verified (identifier redacted)" as const,
    execution: connection.adapterId === "codex-acp"
      ? "Plan-only" as const
      : "Act + Plan" as const,
    billingSources: [...connection.billingSelection.allowedSources],
  });
}

function exactRecord(
  document: ConnectionRegistryDocument,
  id: string,
): ConnectionRecord {
  const record = CONNECTION_ID.test(id)
    ? document.connections.find((candidate) => candidate.id === id)
    : undefined;
  if (record === undefined) {
    throw new ConnectionLifecycleError(
      "connection_not_found",
      "Connection not found",
    );
  }
  return record;
}

function cancelled(): ConnectionLifecycleError {
  return new ConnectionLifecycleError(
    "cancelled",
    "Connection operation was cancelled",
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}

function registryFailure(
  error: unknown,
  signal: AbortSignal,
): ConnectionLifecycleError {
  if (error instanceof ConnectionLifecycleError) return error;
  if (signal.aborted) return cancelled();
  return new ConnectionLifecycleError(
    "registry_changed",
    "Connection registry changed; try again",
  );
}

function revisionConflict(error: unknown): boolean {
  return error instanceof ConnectionRegistryError &&
    error.code === "revision_conflict";
}

function signalOptions(signal: AbortSignal): { signal: AbortSignal } {
  return { signal };
}

export class ConnectionLifecycleService {
  readonly #registry: ConnectionRegistryPort;

  constructor(registry: FileConnectionRegistry | ConnectionRegistryPort) {
    this.#registry = registry;
  }

  async list(options: {
    signal?: AbortSignal;
  } = {}): Promise<readonly ConnectionSummary[]> {
    const signal = options.signal ?? new AbortController().signal;
    throwIfAborted(signal);
    try {
      const document = await this.#registry.migrateLegacyLocal(
        signalOptions(signal),
      );
      throwIfAborted(signal);
      const summaries = document.connections.map((connection) =>
        summary(connection, document.primaryConnectionId)
      );
      summaries.sort((left, right) =>
        Number(right.primary) - Number(left.primary) ||
        left.id.localeCompare(right.id)
      );
      return deepFreeze(summaries);
    } catch (error) {
      throw registryFailure(error, signal);
    }
  }

  async setPrimary(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ConnectionSummary> {
    const signal = options.signal ?? new AbortController().signal;
    for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      let current: ConnectionRegistryDocument;
      try {
        current = await this.#registry.migrateLegacyLocal(signalOptions(signal));
      } catch (error) {
        throw registryFailure(error, signal);
      }
      const record = exactRecord(current, id);
      if (current.primaryConnectionId === record.id) {
        return summary(record, current.primaryConnectionId);
      }
      try {
        const committed = await this.#registry.commit(
          current.revision,
          (draft) => {
            exactRecord(draft, record.id);
            draft.primaryConnectionId = record.id;
          },
          signalOptions(signal),
        );
        const saved = exactRecord(committed, record.id);
        return summary(saved, committed.primaryConnectionId);
      } catch (error) {
        if (revisionConflict(error) && attempt < MAX_MUTATION_ATTEMPTS - 1) {
          continue;
        }
        throw registryFailure(error, signal);
      }
    }
    throw new ConnectionLifecycleError(
      "registry_changed",
      "Connection registry changed; try again",
    );
  }

  async disconnect(
    id: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ConnectionDisconnection> {
    const signal = options.signal ?? new AbortController().signal;
    for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      let current: ConnectionRegistryDocument;
      try {
        current = await this.#registry.migrateLegacyLocal(signalOptions(signal));
      } catch (error) {
        throw registryFailure(error, signal);
      }
      const record = exactRecord(current, id);
      if (record.kind === "brokered_model_provider") {
        throw new ConnectionLifecycleError(
          "operation_unavailable",
          "Brokered connection disconnection is not activated yet",
        );
      }
      const primaryCleared = current.primaryConnectionId === record.id;
      try {
        const committed = await this.#registry.commit(
          current.revision,
          (draft) => {
            const index = draft.connections.findIndex(
              (candidate) => candidate.id === record.id,
            );
            if (index === -1) {
              throw new ConnectionLifecycleError(
                "connection_not_found",
                "Connection not found",
              );
            }
            draft.connections.splice(index, 1);
            if (draft.primaryConnectionId === record.id) {
              draft.primaryConnectionId = null;
            }
          },
          signalOptions(signal),
        );
        return deepFreeze({
          connectionId: record.id,
          primaryCleared,
          remainingConnections: committed.connections.length,
        });
      } catch (error) {
        if (revisionConflict(error) && attempt < MAX_MUTATION_ATTEMPTS - 1) {
          continue;
        }
        throw registryFailure(error, signal);
      }
    }
    throw new ConnectionLifecycleError(
      "registry_changed",
      "Connection registry changed; try again",
    );
  }

  async verify(
    id: string,
    verifier: ConnectionVerifier,
    options: { signal?: AbortSignal } = {},
  ): Promise<ConnectionVerification> {
    const signal = options.signal ?? new AbortController().signal;
    throwIfAborted(signal);
    let document: ConnectionRegistryDocument;
    try {
      document = await this.#registry.migrateLegacyLocal(signalOptions(signal));
    } catch (error) {
      throw registryFailure(error, signal);
    }
    const stored = exactRecord(document, id);
    const record = deepFreeze(structuredClone(stored));
    try {
      const decision = record.kind === "local_openai_compatible"
        ? await verifier.verifyLocal(record, signal)
        : record.kind === "delegated_agent"
          ? await verifier.verifyDelegated(record, signal)
          : { status: "failed", reason: "adapter_unavailable" } as const;
      throwIfAborted(signal);
      if (decision.status === "failed") {
        throw new ConnectionLifecycleError(
          "verification_failed",
          VERIFICATION_MESSAGES[decision.reason],
          { reason: decision.reason },
        );
      }
      return deepFreeze({
        verified: true,
        connection: summary(stored, document.primaryConnectionId),
      });
    } catch (error) {
      if (error instanceof ConnectionLifecycleError) throw error;
      if (signal.aborted) throw cancelled();
      throw new ConnectionLifecycleError(
        "verification_failed",
        "Connection verification failed",
      );
    }
  }
}
