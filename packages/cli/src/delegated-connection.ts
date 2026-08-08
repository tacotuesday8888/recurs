import type {
  AgentRuntime,
  RuntimeContinuationStore,
} from "@recurs/contracts";
import type {
  ConnectionVerificationDecision,
  DelegatedConnectionRecord,
} from "@recurs/app";
import { GITHUB_COPILOT_ONBOARDING_ADAPTER_ID } from "@recurs/app";

import {
  createCodexAgentRuntime,
  verifyCodexSubscriptionConnection,
} from "./codex-connection.js";
import {
  createGitHubCopilotAgentRuntime,
  verifyGitHubCopilotSubscriptionConnection,
} from "./github-copilot-connection.js";

export function createReviewedDelegatedRuntime(
  connection: DelegatedConnectionRecord,
  store: RuntimeContinuationStore,
  input: {
    readonly dataDirectory: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
): AgentRuntime {
  if (
    connection.providerId === "github-copilot-subscription" &&
    connection.adapterId === GITHUB_COPILOT_ONBOARDING_ADAPTER_ID
  ) {
    return createGitHubCopilotAgentRuntime(connection, store, input);
  }
  if (
    connection.providerId === "openai-codex-chatgpt" &&
    (connection.adapterId === "codex-app-server" ||
      connection.adapterId === "codex-acp")
  ) {
    return createCodexAgentRuntime(connection, store);
  }
  throw new TypeError("Connection is not a reviewed delegated runtime record");
}

export async function verifyReviewedDelegatedConnection(
  connection: DelegatedConnectionRecord,
  input: {
    readonly cwd: string;
    readonly dataDirectory: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly signal: AbortSignal;
  },
): Promise<ConnectionVerificationDecision> {
  if (
    connection.providerId === "github-copilot-subscription" &&
    connection.adapterId === GITHUB_COPILOT_ONBOARDING_ADAPTER_ID
  ) {
    return await verifyGitHubCopilotSubscriptionConnection(
      connection,
      input.signal,
      {
        dataDirectory: input.dataDirectory,
        ...(input.environment === undefined ? {} : {
          environment: input.environment,
        }),
      },
    );
  }
  if (
    connection.providerId === "openai-codex-chatgpt" &&
    (connection.adapterId === "codex-app-server" ||
      connection.adapterId === "codex-acp")
  ) {
    return await verifyCodexSubscriptionConnection(
      connection,
      input.cwd,
      input.signal,
    );
  }
  return { status: "failed", reason: "adapter_unavailable" };
}
