import type { ConnectionBoundModelProvider } from "@recurs/contracts";

import { RemoteOpenAICompatibleProvider } from "./local-openai-compatible.js";

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,127}$/u;

export class EnvironmentProviderError extends Error {
  constructor(
    public readonly code: "incomplete" | "invalid" | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "EnvironmentProviderError";
  }
}

export interface EnvironmentProviderConfiguration {
  readonly providerId: string;
  readonly modelId: string;
  readonly connectionId: string;
  readonly credentialFingerprint: `sha256:${string}`;
  readonly provider: ConnectionBoundModelProvider;
}

export interface CreateEnvironmentProviderConfigurationInput {
  readonly providerId: string;
  readonly modelId: string;
  readonly apiKey: string;
  readonly connectionId?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export async function environmentCredentialFingerprint(
  providerId: string,
  apiKey: string,
): Promise<`sha256:${string}`> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `recurs:environment-provider:v1\0${providerId}\0${apiKey}`,
    ),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`;
}

export async function createEnvironmentProviderConfiguration(
  input: CreateEnvironmentProviderConfigurationInput,
): Promise<EnvironmentProviderConfiguration> {
  if (!PROVIDER_ID.test(input.providerId) || !MODEL_ID.test(input.modelId)) {
    throw new EnvironmentProviderError(
      "invalid",
      "Environment provider selection is invalid",
    );
  }
  let provider: ConnectionBoundModelProvider;
  try {
    provider = new RemoteOpenAICompatibleProvider({
      providerId: input.providerId,
      connectionId: input.connectionId ?? `environment:${input.providerId}`,
      apiKey: input.apiKey,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    });
  } catch {
    throw new EnvironmentProviderError(
      "unsupported",
      "Environment provider is not a supported reviewed Chat Completions path",
    );
  }
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    connectionId: provider.connectionId,
    credentialFingerprint: await environmentCredentialFingerprint(
      input.providerId,
      input.apiKey,
    ),
    provider,
  };
}

export function resolveEnvironmentProvider(
  environment: Readonly<Record<string, string | undefined>>,
  fetch?: typeof globalThis.fetch,
): Promise<EnvironmentProviderConfiguration | null> {
  return resolve(environment, fetch);
}

async function resolve(
  environment: Readonly<Record<string, string | undefined>>,
  fetch?: typeof globalThis.fetch,
): Promise<EnvironmentProviderConfiguration | null> {
  const providerId = environment.RECURS_PROVIDER?.trim();
  const modelId = environment.RECURS_MODEL?.trim();
  const apiKey = environment.RECURS_API_KEY;
  const present = [providerId, modelId, apiKey].filter(
    (value) => value !== undefined && value.length > 0,
  ).length;
  if (present === 0) return null;
  if (present !== 3) {
    throw new EnvironmentProviderError(
      "incomplete",
      "RECURS_PROVIDER, RECURS_MODEL, and RECURS_API_KEY must be set together",
    );
  }
  if (providerId === undefined || modelId === undefined || apiKey === undefined) {
    throw new EnvironmentProviderError(
      "invalid",
      "Environment provider selection is invalid",
    );
  }
  return await createEnvironmentProviderConfiguration({
    providerId,
    modelId,
    apiKey,
    ...(fetch === undefined ? {} : { fetch }),
  });
}
