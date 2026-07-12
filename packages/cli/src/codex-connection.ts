import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  CODEX_ONBOARDING_ADAPTER_ID,
  CODEX_ONBOARDING_ADAPTER_VERSION,
  CODEX_ONBOARDING_CAPABILITY_PROFILE_REVISION,
  CodexOnboardingError,
  OnboardingCatalog,
  codexAccountSubjectFingerprint,
  setupCodexConnection,
  type CodexConnectionConfiguration,
  type CodexOnboardingRuntime,
  type DelegatedConnectionRecord,
  type SetupCodexConnectionInput,
  type ConnectionVerificationDecision,
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

function currentCodexPolicy(connection: DelegatedConnectionRecord): boolean {
  const entry = new OnboardingCatalog().list({ includeBlocked: true }).find(
    (candidate) => candidate.id === connection.providerId,
  );
  return entry !== undefined &&
    entry.status === "runnable" &&
    connection.providerId === PROVIDER_ID &&
    connection.adapterId === CODEX_ONBOARDING_ADAPTER_ID &&
    connection.policyRevision === entry.policy.revision &&
    isDeepStrictEqual(connection.billingPolicy, entry.billing) &&
    connection.billingSelection.mode === "allow_declared_additional" &&
    connection.billingSelection.policyRevision === entry.billing.revision &&
    connection.billingSelection.disclosureRevision ===
      entry.billing.disclosureRevision &&
    isDeepStrictEqual(connection.billingSelection.allowedSources, [
      entry.billing.primarySource,
      ...entry.billing.possibleAdditionalSources,
    ]);
}

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

export interface VerifyCodexSubscriptionDependencies {
  readonly runtime?: CodexOnboardingRuntime;
}

export async function verifyCodexSubscriptionConnection(
  connection: DelegatedConnectionRecord,
  cwd: string,
  signal: AbortSignal,
  dependencies: VerifyCodexSubscriptionDependencies = {},
): Promise<ConnectionVerificationDecision> {
  if (signal.aborted) throw new Error("cancelled");
  if (
    connection.providerId !== PROVIDER_ID ||
    connection.adapterId !== CODEX_ONBOARDING_ADAPTER_ID
  ) {
    return { status: "failed", reason: "adapter_unavailable" };
  }
  if (!currentCodexPolicy(connection)) {
    return { status: "failed", reason: "policy_stale" };
  }
  try {
    const runtime = dependencies.runtime ?? createCodexOnboardingRuntime(
      connection.id,
    );
    if (
      runtime.adapterId !== CODEX_ONBOARDING_ADAPTER_ID ||
      runtime.adapterVersion !== CODEX_ONBOARDING_ADAPTER_VERSION ||
      runtime.capabilityProfileRevision !==
        CODEX_ONBOARDING_CAPABILITY_PROFILE_REVISION
    ) {
      return { status: "failed", reason: "adapter_unavailable" };
    }
    const inspected = await runtime.inspect(signal);
    if (signal.aborted) throw new Error("cancelled");
    if (
      inspected.inspection.protocolVersion !== 1 ||
      inspected.inspection.agentInfo?.name !==
        "@agentclientprotocol/codex-acp" ||
      inspected.inspection.agentInfo.version !== CODEX_ONBOARDING_ADAPTER_VERSION
    ) {
      return { status: "failed", reason: "adapter_unavailable" };
    }
    if (inspected.status.type === "unauthenticated") {
      return { status: "failed", reason: "authentication_required" };
    }
    if (
      inspected.status.type !== "chat-gpt" ||
      inspected.status.email.length === 0 ||
      inspected.status.email.trim() !== inspected.status.email ||
      codexAccountSubjectFingerprint(inspected.status.email) !==
        connection.accountSubjectFingerprint
    ) {
      return { status: "failed", reason: "account_mismatch" };
    }
    const probe = await runtime.probe({
      cwd,
      modelId: connection.modelId,
    }, signal);
    if (signal.aborted) throw new Error("cancelled");
    if (probe.modelId !== connection.modelId) {
      return { status: "failed", reason: "model_unavailable" };
    }
    if (probe.executionMode !== "plan" || probe.modeId !== "read-only") {
      return { status: "failed", reason: "policy_stale" };
    }
    return { status: "verified" };
  } catch {
    if (signal.aborted) throw new Error("cancelled");
    return { status: "failed", reason: "adapter_unavailable" };
  }
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
