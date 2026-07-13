import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import { RegistryFileStore } from "./connection-registry-io.js";
import {
  immutableConnectionActivationDocument,
  parseConnectionActivationDocument,
  type ConnectionActivationDocument,
  type PendingConnectionActivation,
} from "./connection-activation-model.js";
import {
  immutableRegistryDocument,
  nextRegistryDocument,
  type ConnectionRegistryDocument,
  type FileConnectionRegistryOptions,
} from "./connection-registry-model.js";

export type ConnectionActivationErrorCode =
  | "activation_conflict"
  | "activation_not_found";

export class ConnectionActivationError extends Error {
  constructor(
    public readonly code: ConnectionActivationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionActivationError";
  }
}

export function connectionActivationPath(dataDirectory: string): string {
  return path.join(dataDirectory, "config", "connection-activations.json");
}

export class FileConnectionActivationStore {
  readonly #store: RegistryFileStore;

  constructor(
    dataDirectory: string,
    options: FileConnectionRegistryOptions = {},
  ) {
    this.#store = new RegistryFileStore(dataDirectory, options);
  }

  async read(): Promise<ConnectionActivationDocument> {
    return this.#store.transaction(undefined, async (access) =>
      immutableConnectionActivationDocument(
        (await access.readActivation()).document,
      )
    );
  }

  async prepare(
    activation: PendingConnectionActivation,
    options: { signal?: AbortSignal } = {},
  ): Promise<ConnectionActivationDocument> {
    const proposed = parseConnectionActivationDocument({
      schemaVersion: 1,
      activation,
    });
    return this.#store.transaction(options.signal, async (access) => {
      const current = await access.readActivation();
      if (current.document.activation !== null) {
        if (isDeepStrictEqual(current.document, proposed)) {
          return immutableConnectionActivationDocument(current.document);
        }
        throw conflict();
      }
      await access.writeActivation(proposed, current.identity);
      return immutableConnectionActivationDocument(proposed);
    });
  }

  async commitToRegistry(
    connectionID: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ConnectionRegistryDocument> {
    return this.#store.transaction(options.signal, async (access) => {
      const pending = await access.readActivation();
      const activation = pending.document.activation;
      if (activation === null) {
        const current = await access.readRegistry();
        const completed = current.document.connections.find(
          (candidate) =>
            candidate.kind === "brokered_model_provider" &&
            candidate.id === connectionID,
        );
        if (completed !== undefined) {
          return immutableRegistryDocument(current.document);
        }
        throw new ConnectionActivationError(
          "activation_not_found",
          "Pending connection activation was not found",
        );
      }
      if (activation.connection.id !== connectionID) throw conflict();

      const current = await access.readRegistry();
      const existing = current.document.connections.find(
        (candidate) => candidate.id === connectionID,
      );
      if (existing !== undefined) {
        if (!isDeepStrictEqual(existing, activation.connection)) {
          throw conflict();
        }
        return immutableRegistryDocument(current.document);
      }

      const next = nextRegistryDocument(current.document, {
        primaryConnectionId:
          current.document.connections.length === 0 &&
              current.document.primaryConnectionId === null
            ? connectionID
            : current.document.primaryConnectionId,
        connections: [
          ...current.document.connections,
          activation.connection,
        ],
      });
      await access.writeRegistry(next, current.identity);
      return immutableRegistryDocument(next);
    });
  }

  async discard(
    connectionID: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.#store.transaction(options.signal, async (access) => {
      const current = await access.readActivation();
      const activation = current.document.activation;
      if (activation === null) return;
      if (activation.connection.id !== connectionID) throw conflict();
      if (current.identity === null) throw conflict();
      await access.removeActivation(current.identity);
    });
  }
}

function conflict(): ConnectionActivationError {
  return new ConnectionActivationError(
    "activation_conflict",
    "Pending connection activation conflicts with this operation",
  );
}

export type {
  ConnectionActivationDocument,
  PendingConnectionActivation,
} from "./connection-activation-model.js";
