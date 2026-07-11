import { randomUUID } from "node:crypto";

import {
  ConnectionRegistryError,
  FileConnectionRegistry,
  connectionRegistryPath,
  type ConnectionRegistryDocument,
  type LocalConnectionRecord,
} from "@recurs/app";
import {
  listLocalOpenAIModels,
  normalizeLoopbackOpenAIBaseUrl,
} from "@recurs/providers";

const INVALID = "Local connection configuration is invalid";

export class LocalConnectionError extends Error {
  constructor(
    public readonly code: "configuration_invalid" | "model_unavailable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalConnectionError";
  }
}

export interface LocalConnectionConfiguration {
  schemaVersion: 1;
  kind: "local_openai_compatible";
  id: string;
  label: string;
  baseUrl: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
}

export interface WriteLocalConnectionInput {
  baseUrl: string;
  modelId: string;
  label?: string;
  now?: string;
}

export interface SetupLocalConnectionInput {
  baseUrl: string;
  modelId: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export function localConnectionPath(dataDirectory: string): string {
  return connectionRegistryPath(dataDirectory);
}

function localRecord(
  document: ConnectionRegistryDocument,
): LocalConnectionRecord | null {
  const primary = document.primaryConnectionId === null
    ? undefined
    : document.connections.find(
        (connection) => connection.id === document.primaryConnectionId,
      );
  if (primary?.kind === "local_openai_compatible") return primary;
  return (
    document.connections.find(
      (connection) => connection.kind === "local_openai_compatible",
    ) ?? null
  );
}

function configuration(
  record: LocalConnectionRecord,
): LocalConnectionConfiguration {
  return {
    schemaVersion: 1,
    kind: "local_openai_compatible",
    id: record.id,
    label: record.label,
    baseUrl: record.baseUrl,
    modelId: record.modelId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function localError(error: unknown): LocalConnectionError {
  if (error instanceof LocalConnectionError) return error;
  return new LocalConnectionError("configuration_invalid", INVALID, {
    cause: error,
  });
}

export async function readLocalConnection(
  dataDirectory: string,
): Promise<LocalConnectionConfiguration | null> {
  try {
    const document = await new FileConnectionRegistry(
      dataDirectory,
    ).migrateLegacyLocal();
    const record = localRecord(document);
    return record === null ? null : configuration(record);
  } catch (error) {
    throw localError(error);
  }
}

export async function writeLocalConnection(
  dataDirectory: string,
  input: WriteLocalConnectionInput,
): Promise<LocalConnectionConfiguration> {
  const baseUrl = normalizeLoopbackOpenAIBaseUrl(input.baseUrl);
  const modelId = input.modelId.trim();
  if (modelId.length === 0 || modelId.length > 512) {
    throw new LocalConnectionError(
      "configuration_invalid",
      "Local model id must not be empty",
    );
  }
  const now = input.now ?? new Date().toISOString();
  const registry = new FileConnectionRegistry(dataDirectory);
  const newId = `local-${randomUUID()}`;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await registry.migrateLegacyLocal();
      const previous = localRecord(current);
      const record: LocalConnectionRecord = {
        kind: "local_openai_compatible",
        id: previous?.id ?? newId,
        providerId: "local-openai-compatible",
        adapterId: "openai-chat-completions",
        label: input.label?.trim() || "Local model",
        baseUrl,
        modelId,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      try {
        await registry.commit(current.revision, (draft) => {
          const index = draft.connections.findIndex(
            (connection) => connection.id === record.id,
          );
          if (index === -1) draft.connections.push(record);
          else draft.connections[index] = record;
          draft.primaryConnectionId = record.id;
        });
        return configuration(record);
      } catch (error) {
        if (
          error instanceof ConnectionRegistryError &&
          error.code === "revision_conflict" &&
          attempt < 2
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new ConnectionRegistryError(
      "revision_conflict",
      "Connection registry revision changed",
    );
  } catch (error) {
    throw localError(error);
  }
}

export async function setupLocalConnection(
  dataDirectory: string,
  input: SetupLocalConnectionInput,
): Promise<LocalConnectionConfiguration> {
  let baseUrl: string;
  try {
    baseUrl = normalizeLoopbackOpenAIBaseUrl(input.baseUrl);
  } catch (error) {
    throw new LocalConnectionError(
      "configuration_invalid",
      "Local model URL must be plain HTTP on literal 127.0.0.1 or [::1]",
      { cause: error },
    );
  }
  const models = await listLocalOpenAIModels({
    baseUrl,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!models.some((model) => model.id === input.modelId)) {
    throw new LocalConnectionError(
      "model_unavailable",
      "Selected local model was not reported by the server",
    );
  }
  return writeLocalConnection(dataDirectory, {
    baseUrl,
    modelId: input.modelId,
    label: "Local model",
  });
}
