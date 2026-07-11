import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

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
  return path.join(dataDirectory, "config", "local-connection.json");
}

function parse(value: unknown): LocalConnectionConfiguration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LocalConnectionError("configuration_invalid", INVALID);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["baseUrl", "createdAt", "id", "kind", "label", "modelId", "schemaVersion", "updatedAt"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new LocalConnectionError("configuration_invalid", INVALID);
  }
  if (
    record.schemaVersion !== 1 || record.kind !== "local_openai_compatible" ||
    typeof record.id !== "string" || record.id.length === 0 ||
    typeof record.label !== "string" || record.label.trim().length === 0 ||
    typeof record.baseUrl !== "string" ||
    typeof record.modelId !== "string" || record.modelId.trim().length === 0 ||
    typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))
  ) throw new LocalConnectionError("configuration_invalid", INVALID);
  let baseUrl: string;
  try {
    baseUrl = normalizeLoopbackOpenAIBaseUrl(record.baseUrl);
  } catch (error) {
    throw new LocalConnectionError("configuration_invalid", INVALID, { cause: error });
  }
  return {
    schemaVersion: 1, kind: "local_openai_compatible", id: record.id,
    label: record.label, baseUrl, modelId: record.modelId,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
  };
}

export async function readLocalConnection(dataDirectory: string): Promise<LocalConnectionConfiguration | null> {
  const filename = localConnectionPath(dataDirectory);
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new LocalConnectionError("configuration_invalid", INVALID, { cause: error });
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) {
      throw new LocalConnectionError("configuration_invalid", INVALID);
    }
    return parse(JSON.parse(await handle.readFile("utf8")));
  } catch (error) {
    if (error instanceof LocalConnectionError) throw error;
    throw new LocalConnectionError("configuration_invalid", INVALID, { cause: error });
  } finally {
    await handle.close();
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
  const previous = await readLocalConnection(dataDirectory);
  const value: LocalConnectionConfiguration = {
    schemaVersion: 1, kind: "local_openai_compatible",
    id: previous?.id ?? `local-${randomUUID()}`,
    label: input.label?.trim() || "Local model", baseUrl, modelId,
    createdAt: previous?.createdAt ?? now, updatedAt: now,
  };
  const filename = localConnectionPath(dataDirectory);
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
    const parent = await open(directory, constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return value;
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
