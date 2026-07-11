import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  CODEX_ONBOARDING_ADAPTER_ID,
  CODEX_ONBOARDING_ADAPTER_VERSION,
  CODEX_ONBOARDING_CAPABILITY_PROFILE_REVISION,
  CodexOnboardingError,
  setupCodexConnection,
  type CodexConnectionConfiguration,
  type CodexOnboardingRuntime,
  type DelegatedConnectionRecord,
  type SetupCodexConnectionInput,
} from "@recurs/app";
import type {
  AgentRuntime,
  RuntimeContinuationStore,
} from "@recurs/contracts";
import {
  CODEX_ACP_ADAPTER_ID,
  CODEX_ACP_ADAPTER_VERSION,
  CODEX_ACP_PROFILE_REVISION,
  authenticateCodexAcpChatGpt,
  createAccountBoundCodexAcpRuntime,
  createCodexAcpProfile,
  inspectCodexAcp,
  probeCodexAcp,
} from "@recurs/runtimes";

const PROVIDER_ID = "openai-codex-chatgpt";
const DISCOVERY_MODEL_ID = "codex-discovery";

function assertSharedConstants(): void {
  if (
    CODEX_ONBOARDING_ADAPTER_ID !== CODEX_ACP_ADAPTER_ID ||
    CODEX_ONBOARDING_ADAPTER_VERSION !== CODEX_ACP_ADAPTER_VERSION ||
    CODEX_ONBOARDING_CAPABILITY_PROFILE_REVISION !==
      CODEX_ACP_PROFILE_REVISION
  ) {
    throw new TypeError("Codex onboarding/runtime revisions disagree");
  }
}

export function createCodexOnboardingRuntime(
  connectionId: string,
): CodexOnboardingRuntime {
  assertSharedConstants();
  const profile = createCodexAcpProfile({
    connectionId,
    modelId: DISCOVERY_MODEL_ID,
  });
  return Object.freeze({
    adapterId: CODEX_ONBOARDING_ADAPTER_ID,
    adapterVersion: CODEX_ONBOARDING_ADAPTER_VERSION,
    capabilityProfileRevision:
      CODEX_ONBOARDING_CAPABILITY_PROFILE_REVISION,
    inspect: (signal: AbortSignal) => inspectCodexAcp(profile, signal),
    async authenticateChatGpt(signal: AbortSignal) {
      await authenticateCodexAcpChatGpt(profile, signal);
    },
    probe: (
      input: { readonly cwd: string; readonly modelId?: string },
      signal: AbortSignal,
    ) => probeCodexAcp({
      profile,
      cwd: input.cwd,
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
    }, signal),
  });
}

export async function setupCodexSubscription(
  dataDirectory: string,
  input: SetupCodexConnectionInput,
): Promise<CodexConnectionConfiguration> {
  const configuredHome = process.env.CODEX_HOME;
  const codexHome = configuredHome === undefined
    ? path.join(homedir(), ".codex")
    : configuredHome;
  if (
    input.signal?.aborted === true ||
    codexHome.trim() !== codexHome ||
    !path.isAbsolute(codexHome) ||
    codexHome.includes("\0")
  ) {
    throw new CodexOnboardingError(
      input.signal?.aborted === true ? "cancelled" : "adapter_unavailable",
      input.signal?.aborted === true
        ? "Codex setup was cancelled"
        : "Codex requires a valid local home directory",
    );
  }
  try {
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    if (!(await stat(codexHome)).isDirectory()) {
      throw new TypeError("not a directory");
    }
  } catch {
    throw new CodexOnboardingError(
      "adapter_unavailable",
      "Codex could not prepare its vendor-owned home directory",
    );
  }
  return await setupCodexConnection(dataDirectory, input, {
    createRuntime: createCodexOnboardingRuntime,
  });
}

export function createCodexAgentRuntime(
  connection: DelegatedConnectionRecord,
  store: RuntimeContinuationStore,
): AgentRuntime {
  assertSharedConstants();
  if (
    connection.providerId !== PROVIDER_ID ||
    connection.adapterId !== CODEX_ACP_ADAPTER_ID
  ) {
    throw new TypeError("Connection is not an official Codex runtime record");
  }
  const profile = createCodexAcpProfile({
    connectionId: connection.id,
    modelId: connection.modelId,
  });
  return createAccountBoundCodexAcpRuntime(
    profile,
    connection.accountSubjectFingerprint,
    store,
  );
}
