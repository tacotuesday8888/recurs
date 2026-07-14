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

  async read(
    options: { signal?: AbortSignal } = {},
  ): Promise<ConnectionActivationDocument> {
    return this.#store.transaction(options.signal, async (access) =>
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
    expectedActivation: PendingConnectionActivation,
    options: { signal?: AbortSignal } = {},
  ): Promise<ConnectionRegistryDocument> {
    const expected = canonicalActivation(expectedActivation);
    return this.#store.transaction(options.signal, async (access) => {
      const pending = await access.readActivation();
      const activation = pending.document.activation;
      const current = await access.readRegistry();
      if (activation === null) {
        const completed = current.document.connections.find(
          (candidate) => candidate.id === expected.connection.id,
        );
        if (completed === undefined) throw notFound();
        if (!isDeepStrictEqual(completed, expected.connection)) {
          throw conflict();
        }
        return immutableRegistryDocument(current.document);
      }
      if (!isDeepStrictEqual(activation, expected)) throw conflict();

      const existing = current.document.connections.find(
        (candidate) => candidate.id === expected.connection.id,
      );
      if (existing !== undefined) {
        if (!isDeepStrictEqual(existing, expected.connection)) {
          throw conflict();
        }
        return immutableRegistryDocument(current.document);
      }

      const next = nextRegistryDocument(current.document, {
        primaryConnectionId:
          current.document.connections.length === 0 &&
              current.document.primaryConnectionId === null
            ? expected.connection.id
            : current.document.primaryConnectionId,
        connections: [
          ...current.document.connections,
          expected.connection,
        ],
      });
      await access.writeRegistry(next, current.identity);
      return immutableRegistryDocument(next);
    });
  }

  async discard(
    expectedActivation: PendingConnectionActivation,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const expected = canonicalActivation(expectedActivation);
    await this.#store.transaction(options.signal, async (access) => {
      const current = await access.readActivation();
      const activation = current.document.activation;
      if (activation === null) return;
      if (!isDeepStrictEqual(activation, expected)) throw conflict();
      if (current.identity === null) throw conflict();
      await access.removeActivation(current.identity);
    });
  }

  async discardIfRegistryMissing(
    expectedActivation: PendingConnectionActivation,
    options: { signal?: AbortSignal } = {},
  ): Promise<"discarded" | "registry_present"> {
    const expected = canonicalActivation(expectedActivation);
    return this.#store.transaction(options.signal, async (access) => {
      const current = await access.readActivation();
      const activation = current.document.activation;
      if (activation !== null && !isDeepStrictEqual(activation, expected)) {
        throw conflict();
      }
      const registry = await access.readRegistry();
      if (
        registry.document.connections.some(
          (connection) => connection.id === expected.connection.id,
        )
      ) {
        return "registry_present";
      }
      if (activation === null) return "discarded";
      if (current.identity === null) throw conflict();
      await access.removeActivation(current.identity);
      return "discarded";
    });
  }
}

function canonicalActivation(
  activation: PendingConnectionActivation,
): PendingConnectionActivation {
  const document = parseConnectionActivationDocument({
    schemaVersion: 1,
    activation,
  });
  if (document.activation === null) throw conflict();
  return document.activation;
}

function conflict(): ConnectionActivationError {
  return new ConnectionActivationError(
    "activation_conflict",
    "Pending connection activation conflicts with this operation",
  );
}

function notFound(): ConnectionActivationError {
  return new ConnectionActivationError(
    "activation_not_found",
    "Pending connection activation was not found",
  );
}

export type {
  ConnectionActivationDocument,
  PendingConnectionActivation,
} from "./connection-activation-model.js";
