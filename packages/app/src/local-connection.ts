import { randomUUID } from "node:crypto";

import {
  listLocalOpenAIModels,
  normalizeLoopbackOpenAIBaseUrl,
} from "@recurs/providers";

import {
  ConnectionRegistryError,
  FileConnectionRegistry,
  connectionRegistryPath,
} from "./connection-registry.js";
import type {
  ConnectionRegistryDocument,
  LocalConnectionRecord,
} from "./connection-registry-model.js";

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
  primary: boolean;
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

export type LocalConnectionVerification =
  | { readonly status: "verified" }
  | {
      readonly status: "failed";
      readonly reason: "connection_unavailable" | "model_unavailable";
    };

export interface VerifyLocalConnectionOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export function localConnectionPath(dataDirectory: string): string {
  return connectionRegistryPath(dataDirectory);
}

function localRecords(
  document: ConnectionRegistryDocument,
): readonly LocalConnectionRecord[] {
  return document.connections.filter(
    (connection): connection is LocalConnectionRecord =>
      connection.kind === "local_openai_compatible",
  );
}

function recordForRead(
  document: ConnectionRegistryDocument,
): LocalConnectionRecord | null {
  const primary = document.primaryConnectionId === null
    ? undefined
    : document.connections.find(
        (connection) => connection.id === document.primaryConnectionId,
      );
  if (primary?.kind === "local_openai_compatible") return primary;
  return localRecords(document)[0] ?? null;
}

function recordsForOrigin(
  document: ConnectionRegistryDocument,
  baseUrl: string,
): readonly LocalConnectionRecord[] {
  return localRecords(document).filter((record) => record.baseUrl === baseUrl);
}

function configuration(
  record: LocalConnectionRecord,
  primaryConnectionId: string | null,
): LocalConnectionConfiguration {
  return {
    schemaVersion: 1,
    kind: "local_openai_compatible",
    id: record.id,
    label: record.label,
    baseUrl: record.baseUrl,
    modelId: record.modelId,
    primary: primaryConnectionId === record.id,
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
    const record = recordForRead(document);
    return record === null
      ? null
      : configuration(record, document.primaryConnectionId);
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
  const proposedId = `local-${randomUUID()}`;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await registry.migrateLegacyLocal();
      const matches = recordsForOrigin(current, baseUrl);
      if (matches.length > 1) {
        throw new LocalConnectionError(
          "configuration_invalid",
          "Connection registry contains duplicate local connection records",
        );
      }
      const previous = matches[0];
      const record: LocalConnectionRecord = {
        kind: "local_openai_compatible",
        id: previous?.id ?? proposedId,
        providerId: "local-openai-compatible",
        adapterId: "openai-chat-completions",
        label: input.label?.trim() || "Local model",
        baseUrl,
        modelId,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      const makePrimary = previous === undefined &&
        current.connections.length === 0 &&
        current.primaryConnectionId === null;
      try {
        const committed = await registry.commit(current.revision, (draft) => {
          const index = draft.connections.findIndex(
            (connection) => connection.id === record.id,
          );
          if (index === -1) draft.connections.push(record);
          else draft.connections[index] = record;
          if (makePrimary) draft.primaryConnectionId = record.id;
        });
        return configuration(record, committed.primaryConnectionId);
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
  return await writeLocalConnection(dataDirectory, {
    baseUrl,
    modelId: input.modelId,
    label: "Local model",
  });
}

export async function verifyLocalConnection(
  record: Readonly<LocalConnectionRecord>,
  options: VerifyLocalConnectionOptions = {},
): Promise<LocalConnectionVerification> {
  try {
    const models = await listLocalOpenAIModels({
      baseUrl: record.baseUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return models.some((model) => model.id === record.modelId)
      ? { status: "verified" }
      : { status: "failed", reason: "model_unavailable" };
  } catch (error) {
    if (options.signal?.aborted === true) throw error;
    return { status: "failed", reason: "connection_unavailable" };
  }
}
