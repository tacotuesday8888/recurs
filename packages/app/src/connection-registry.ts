import path from "node:path";

import { RegistryFileStore } from "./connection-registry-io.js";
import {
  ConnectionRegistryError,
  MIGRATION_CONFLICT,
  MAX_REVISION,
  REVISION_CONFLICT,
  immutableRegistryDocument,
  mutableRegistryDocument,
  nextRegistryDocument,
  type ConnectionRegistryDocument,
  type ConnectionRegistryMutation,
  type FileConnectionRegistryOptions,
} from "./connection-registry-model.js";

export {
  ConnectionRegistryError,
  type BrokeredModelProviderConnectionRecord,
  type ConnectionRecord,
  type ConnectionRegistryDocument,
  type ConnectionRegistryErrorCode,
  type ConnectionRegistryMutation,
  type ConnectionRegistryMutationResult,
  type DelegatedConnectionRecord,
  type FileConnectionRegistryOptions,
  type LocalConnectionRecord,
  type RegistryFaultPoint,
} from "./connection-registry-model.js";

export function connectionRegistryPath(dataDirectory: string): string {
  return path.join(dataDirectory, "config", "connections.json");
}

export function legacyLocalConnectionPath(dataDirectory: string): string {
  return path.join(dataDirectory, "config", "local-connection.json");
}

export class FileConnectionRegistry {
  readonly #store: RegistryFileStore;

  constructor(
    dataDirectory: string,
    options: FileConnectionRegistryOptions = {},
  ) {
    this.#store = new RegistryFileStore(dataDirectory, options);
  }

  async read(): Promise<ConnectionRegistryDocument> {
    return immutableRegistryDocument(await this.#store.read());
  }

  async commit(
    expectedRevision: number,
    mutation: ConnectionRegistryMutation,
    options: { signal?: AbortSignal } = {},
  ): Promise<ConnectionRegistryDocument> {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision > MAX_REVISION
    ) {
      throw new ConnectionRegistryError(
        "revision_conflict",
        REVISION_CONFLICT,
      );
    }
    return this.#store.transaction(options.signal, async (access) => {
      const current = await access.readRegistry();
      if (current.document.revision !== expectedRevision) {
        throw new ConnectionRegistryError(
          "revision_conflict",
          REVISION_CONFLICT,
        );
      }
      const draft = mutableRegistryDocument(current.document);
      const proposed = (await mutation(draft)) ?? draft;
      const next = nextRegistryDocument(current.document, proposed);
      await access.writeRegistry(next, current.identity);
      return immutableRegistryDocument(next);
    });
  }

  async migrateLegacyLocal(
    options: { signal?: AbortSignal } = {},
  ): Promise<ConnectionRegistryDocument> {
    return this.#store.transaction(options.signal, async (access) => {
      const current = await access.readRegistry();
      const legacy = await access.readLegacy();
      if (legacy === null) {
        return immutableRegistryDocument(current.document);
      }
      const existing = current.document.connections.find(
        (connection) => connection.id === legacy.record.id,
      );
      let result = current.document;
      if (existing === undefined) {
        result = nextRegistryDocument(current.document, {
          primaryConnectionId:
            current.document.primaryConnectionId ?? legacy.record.id,
          connections: [...current.document.connections, legacy.record],
        });
        await access.writeRegistry(result, current.identity);
      } else if (JSON.stringify(existing) !== JSON.stringify(legacy.record)) {
        throw new ConnectionRegistryError(
          "migration_conflict",
          MIGRATION_CONFLICT,
        );
      } else if (current.document.primaryConnectionId === null) {
        result = nextRegistryDocument(current.document, {
          primaryConnectionId: legacy.record.id,
          connections: current.document.connections,
        });
        await access.writeRegistry(result, current.identity);
      }
      await access.removeLegacy(legacy.identity);
      return immutableRegistryDocument(result);
    });
  }
}
