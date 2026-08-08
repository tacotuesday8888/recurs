import type {
  AgentRuntime,
  ModelReasoningEffort,
  RuntimeContinuationStore,
} from "@recurs/contracts";
import {
  matchesCurrentGitHubCopilotPolicy,
  setupGitHubCopilotConnection,
  GITHUB_COPILOT_ONBOARDING_ADAPTER_ID,
  GITHUB_COPILOT_ONBOARDING_PROFILE_REVISION,
  type ConnectionVerificationDecision,
  type DelegatedConnectionRecord,
} from "@recurs/app";
import {
  GITHUB_COPILOT_ADAPTER_ID,
  GITHUB_COPILOT_PROFILE_REVISION,
  GitHubCopilotRuntimeError,
  createGitHubCopilotRuntime,
  inspectGitHubCopilotSubscription,
  prepareGitHubCopilotRuntimeHome,
  resolveGitHubCopilotSdk,
  type GitHubCopilotSubscriptionInspection,
} from "@recurs/runtimes";

const PROVIDER_ID = "github-copilot-subscription";
const SDK_EFFORTS = new Set<ModelReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
]);

function assertSharedGitHubCopilotConstants(): void {
  if (
    GITHUB_COPILOT_ONBOARDING_ADAPTER_ID !== GITHUB_COPILOT_ADAPTER_ID ||
    GITHUB_COPILOT_ONBOARDING_PROFILE_REVISION !==
      GITHUB_COPILOT_PROFILE_REVISION
  ) {
    throw new TypeError("GitHub Copilot adapter constants are inconsistent");
  }
}

export class GitHubCopilotConnectionError extends Error {
  constructor(
    readonly code:
      | "adapter_unavailable"
      | "authentication_required"
      | "model_unavailable"
      | "cancelled",
    message: string,
    readonly action?: {
      readonly command: string;
      readonly arguments: readonly string[];
      readonly environment?: {
        readonly COPILOT_DISABLE_KEYTAR: "1";
        readonly COPILOT_HOME: string;
      };
      readonly thenEnter?: "/login";
    },
  ) {
    super(message);
    this.name = "GitHubCopilotConnectionError";
  }
}

export interface SetupGitHubCopilotSubscriptionInput {
  readonly modelId: string;
  readonly reasoningEffort?: ModelReasoningEffort;
  readonly billingSelection: "allow_declared_additional";
  readonly signal?: AbortSignal;
  readonly now?: string;
}

async function inspectAvailableGitHubCopilot(
  dataDirectory: string,
  signal: AbortSignal,
  dependencies: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly inspect?: (signal: AbortSignal) => Promise<GitHubCopilotSubscriptionInspection>;
  },
): Promise<GitHubCopilotSubscriptionInspection> {
  if (signal.aborted) {
    throw new GitHubCopilotConnectionError(
      "cancelled",
      "GitHub Copilot inspection was cancelled",
    );
  }
  const baseDirectory = await prepareGitHubCopilotRuntimeHome(dataDirectory);
  const resolution = await resolveGitHubCopilotSdk({ dataDirectory });
  if (resolution.status === "unavailable") {
    throw new GitHubCopilotConnectionError(
      "adapter_unavailable",
      "GitHub Copilot support is not installed",
      { command: "npm", arguments: resolution.installArguments },
    );
  }
  try {
    return await (dependencies.inspect ?? ((currentSignal) =>
      inspectGitHubCopilotSubscription({
        dataDirectory,
        environment: dependencies.environment ?? process.env,
        signal: currentSignal,
      })))(signal);
  } catch (error) {
    if (
      error instanceof GitHubCopilotRuntimeError &&
      error.code === "authentication_required"
    ) {
      throw new GitHubCopilotConnectionError(
        "authentication_required",
        "GitHub Copilot is signed out; launch the official Copilot CLI and enter /login",
        {
          ...resolution.loginCommand,
          environment: {
            COPILOT_DISABLE_KEYTAR: "1",
            COPILOT_HOME: baseDirectory,
          },
        },
      );
    }
    throw error;
  }
}

export async function discoverGitHubCopilotSubscriptionModels(
  dataDirectory: string,
  signal: AbortSignal,
  dependencies: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly inspect?: (signal: AbortSignal) => Promise<GitHubCopilotSubscriptionInspection>;
  } = {},
): Promise<GitHubCopilotSubscriptionInspection["models"]> {
  assertSharedGitHubCopilotConstants();
  return (await inspectAvailableGitHubCopilot(
    dataDirectory,
    signal,
    dependencies,
  )).models;
}

export async function setupGitHubCopilotSubscription(
  dataDirectory: string,
  input: SetupGitHubCopilotSubscriptionInput,
  dependencies: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly inspect?: (signal: AbortSignal) => Promise<GitHubCopilotSubscriptionInspection>;
  } = {},
): Promise<DelegatedConnectionRecord> {
  assertSharedGitHubCopilotConstants();
  const signal = input.signal ?? new AbortController().signal;
  if (signal.aborted) {
    throw new GitHubCopilotConnectionError("cancelled", "GitHub Copilot setup was cancelled");
  }
  const inspection = await inspectAvailableGitHubCopilot(
    dataDirectory,
    signal,
    dependencies,
  );
  const model = inspection.models.find((candidate) => candidate.id === input.modelId);
  const selectedEffort = input.reasoningEffort ??
    (model?.defaultReasoningEffort !== undefined &&
        SDK_EFFORTS.has(model.defaultReasoningEffort as ModelReasoningEffort)
      ? model.defaultReasoningEffort as ModelReasoningEffort
      : undefined);
  if (
    model === undefined ||
    (model.supportsReasoningEffort
      ? selectedEffort === undefined ||
        !SDK_EFFORTS.has(selectedEffort) ||
        !model.reasoningEfforts.includes(selectedEffort)
      : selectedEffort !== undefined)
  ) {
    throw new GitHubCopilotConnectionError(
      "model_unavailable",
      "The selected GitHub Copilot model or reasoning effort is unavailable",
    );
  }
  return await setupGitHubCopilotConnection(dataDirectory, {
    accountSubjectFingerprint: inspection.accountSubjectFingerprint,
    accountDisplayLabel: "GitHub Copilot account",
    model: {
      id: model.id,
      displayName: model.displayName,
      supportsReasoningEffort: model.supportsReasoningEffort,
      supportedReasoningEfforts: model.reasoningEfforts.filter(
        (effort): effort is ModelReasoningEffort => SDK_EFFORTS.has(effort as ModelReasoningEffort),
      ),
      ...(model.defaultReasoningEffort === undefined
        ? {}
        : { defaultReasoningEffort: model.defaultReasoningEffort as ModelReasoningEffort }),
    },
    ...(selectedEffort === undefined
      ? {}
      : { reasoningEffort: selectedEffort }),
    billingSelection: input.billingSelection,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

export async function verifyGitHubCopilotSubscriptionConnection(
  connection: DelegatedConnectionRecord,
  signal: AbortSignal,
  dependencies: {
    readonly dataDirectory: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly inspect?: (signal: AbortSignal) => Promise<GitHubCopilotSubscriptionInspection>;
  },
): Promise<ConnectionVerificationDecision> {
  assertSharedGitHubCopilotConstants();
  try {
    if (!matchesCurrentGitHubCopilotPolicy(connection)) {
      return { status: "failed", reason: "policy_stale" };
    }
    const inspected = await (dependencies.inspect ?? ((currentSignal) =>
      inspectGitHubCopilotSubscription({
        dataDirectory: dependencies.dataDirectory,
        environment: dependencies.environment ?? process.env,
        signal: currentSignal,
      })
    ))(signal);
    if (inspected.accountSubjectFingerprint !== connection.accountSubjectFingerprint) {
      return { status: "failed", reason: "account_mismatch" };
    }
    const model = inspected.models.find((candidate) => candidate.id === connection.modelId);
    if (
      model === undefined ||
      (model.supportsReasoningEffort
        ? connection.reasoningEffort === undefined ||
          !model.reasoningEfforts.includes(connection.reasoningEffort)
        : connection.reasoningEffort !== undefined)
    ) return { status: "failed", reason: "model_unavailable" };
    return { status: "verified" };
  } catch (error) {
    if (signal.aborted) throw new Error("cancelled", { cause: error });
    if (
      error instanceof GitHubCopilotRuntimeError &&
      error.code === "authentication_required"
    ) return { status: "failed", reason: "authentication_required" };
    return { status: "failed", reason: "adapter_unavailable" };
  }
}

export function createGitHubCopilotAgentRuntime(
  connection: DelegatedConnectionRecord,
  _store: RuntimeContinuationStore,
  input: {
    readonly dataDirectory: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
): AgentRuntime {
  assertSharedGitHubCopilotConstants();
  if (
    connection.providerId !== PROVIDER_ID ||
    connection.adapterId !== GITHUB_COPILOT_ADAPTER_ID ||
    connection.runtimeCapabilityProfileRevision !== GITHUB_COPILOT_PROFILE_REVISION
  ) {
    throw new TypeError("Connection is not a reviewed GitHub Copilot record");
  }
  const reasoningEffort = connection.reasoningEffort;
  if (reasoningEffort !== undefined && !SDK_EFFORTS.has(reasoningEffort)) {
    throw new TypeError("Connection has an unsupported GitHub Copilot reasoning effort");
  }
  return createGitHubCopilotRuntime({
    connectionId: connection.id,
    modelId: connection.modelId,
    ...(reasoningEffort === undefined ? {} : {
      reasoningEffort: reasoningEffort as "low" | "medium" | "high" | "xhigh",
    }),
    expectedAccountSubjectFingerprint: connection.accountSubjectFingerprint,
    dataDirectory: input.dataDirectory,
    environment: input.environment ?? process.env,
  });
}
