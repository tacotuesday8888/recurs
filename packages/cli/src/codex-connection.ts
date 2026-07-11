import { createHash, randomUUID } from "node:crypto";
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
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
  AgentRuntimeHost,
  ContinuationReadCapability,
  RunAuthorization,
  RuntimeCapabilities,
  RuntimeContinuationHandle,
  RuntimeContinuationStore,
} from "@recurs/contracts";
import {
  CODEX_ACP_ADAPTER_ID,
  CODEX_ACP_ADAPTER_VERSION,
  CODEX_ACP_PROFILE_REVISION,
  authenticateCodexAcpChatGpt,
  createCodexAcpProfile,
  inspectCodexAcp,
  ManagedAcpRuntime,
  probeCodexAcp,
  type AcpRuntimeProfile,
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

function accountFingerprint(accountLabel: string): string {
  const digest = createHash("sha256")
    .update(`${PROVIDER_ID}\0${accountLabel.toLocaleLowerCase("en-US")}`)
    .digest("hex");
  return `sha256:${digest}`;
}

function failure(
  domain: "auth" | "connection" | "runtime",
  code:
    | "account_mismatch"
    | "authentication_required"
    | "adapter_unavailable"
    | "cancelled",
  safeMessage: string,
): AgentRuntimeEvent {
  return {
    type: "failed",
    failure: {
      domain,
      phase: "started",
      code,
      safeMessage,
      diagnosticId: `codex-${randomUUID()}`,
      retryable: false,
      ...(code === "authentication_required"
        ? { action: "reauthenticate" as const }
        : code === "account_mismatch"
          ? { action: "select_connection" as const }
          : {}),
    },
  };
}

class AccountBoundCodexRuntime implements AgentRuntime {
  readonly adapterId: string;
  readonly connectionId: string;
  readonly capabilities: RuntimeCapabilities;
  readonly capabilityProfileRevision: string;
  readonly #inner: ManagedAcpRuntime;
  readonly #profile: AcpRuntimeProfile;
  readonly #connection: DelegatedConnectionRecord;

  constructor(
    profile: AcpRuntimeProfile,
    connection: DelegatedConnectionRecord,
    store: RuntimeContinuationStore,
  ) {
    this.#profile = profile;
    this.#connection = structuredClone(connection);
    this.#inner = new ManagedAcpRuntime(profile, store);
    this.adapterId = this.#inner.adapterId;
    this.connectionId = this.#inner.connectionId;
    this.capabilities = this.#inner.capabilities;
    this.capabilityProfileRevision = this.#inner.capabilityProfileRevision;
  }

  run(
    request: AgentRunRequest,
    host: AgentRuntimeHost,
  ): AsyncIterable<AgentRuntimeEvent> {
    return this.runVerified(request, host);
  }

  async reconcile(input: {
    readonly continuation: RuntimeContinuationHandle;
    readonly reader: ContinuationReadCapability;
    readonly authorization: RunAuthorization & {
      readonly operation: "runtime_reconcile";
      readonly turnId: null;
    };
    readonly expectedSessionRecordSequence: number;
    readonly signal: AbortSignal;
  }): Promise<"committed" | "uncertain" | "gone"> {
    if (!(await this.accountMatches(input.signal))) return "uncertain";
    return await this.#inner.reconcile(input);
  }

  private async *runVerified(
    request: AgentRunRequest,
    host: AgentRuntimeHost,
  ): AsyncGenerator<AgentRuntimeEvent> {
    if (request.signal.aborted) {
      yield failure(
        "runtime",
        "cancelled",
        "The delegated Codex turn was cancelled",
      );
      return;
    }
    let inspected;
    try {
      inspected = await inspectCodexAcp(this.#profile, request.signal);
    } catch {
      if (request.signal.aborted) {
        yield failure(
          "runtime",
          "cancelled",
          "The delegated Codex turn was cancelled",
        );
      } else {
        yield failure(
          "connection",
          "adapter_unavailable",
          "The official Codex runtime could not be verified",
        );
      }
      return;
    }
    if (inspected.status.type === "unauthenticated") {
      yield failure(
        "auth",
        "authentication_required",
        "The Codex connection requires ChatGPT sign-in",
      );
      return;
    }
    if (
      inspected.inspection.agentInfo?.name !==
        "@agentclientprotocol/codex-acp" ||
      inspected.inspection.agentInfo.version !== CODEX_ACP_ADAPTER_VERSION ||
      inspected.status.type !== "chat-gpt" ||
      inspected.status.email.trim() !== inspected.status.email ||
      inspected.status.email.length === 0 ||
      accountFingerprint(inspected.status.email) !==
        this.#connection.accountSubjectFingerprint
    ) {
      yield failure(
        "auth",
        "account_mismatch",
        "The active ChatGPT account does not match this Codex connection",
      );
      return;
    }
    yield* this.#inner.run(request, host);
  }

  private async accountMatches(signal: AbortSignal): Promise<boolean> {
    try {
      const inspected = await inspectCodexAcp(this.#profile, signal);
      return !signal.aborted &&
        inspected.inspection.agentInfo?.name ===
          "@agentclientprotocol/codex-acp" &&
        inspected.inspection.agentInfo.version === CODEX_ACP_ADAPTER_VERSION &&
        inspected.status.type === "chat-gpt" &&
        inspected.status.email.trim() === inspected.status.email &&
        inspected.status.email.length > 0 &&
        accountFingerprint(inspected.status.email) ===
          this.#connection.accountSubjectFingerprint;
    } catch {
      return false;
    }
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
  return new AccountBoundCodexRuntime(profile, connection, store);
}
