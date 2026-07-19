import {
  CODEX_ONBOARDING_ADAPTER_ID,
  CODEX_ONBOARDING_ADAPTER_VERSION,
  CODEX_ONBOARDING_CAPABILITY_PROFILE_REVISION,
  CodexOnboardingError,
} from "@recurs/app";

export const CODEX_ACP_ADAPTER_ID = CODEX_ONBOARDING_ADAPTER_ID;
export const CODEX_ACP_ADAPTER_VERSION = CODEX_ONBOARDING_ADAPTER_VERSION;
export const CODEX_ACP_PROFILE_REVISION =
  CODEX_ONBOARDING_CAPABILITY_PROFILE_REVISION;

const UNAVAILABLE_MESSAGE =
  "Delegated Codex runtime is unavailable in the sealed native engine";

function delegatedRuntimeUnavailable(): never {
  throw new CodexOnboardingError("adapter_unavailable", UNAVAILABLE_MESSAGE);
}

export function createCodexAcpProfile(_input: {
  readonly connectionId: string;
  readonly modelId: string;
}): never {
  void _input;
  return delegatedRuntimeUnavailable();
}

export async function authenticateCodexAcpChatGpt(
  _profile: unknown,
  _signal: AbortSignal,
): Promise<never> {
  void _profile;
  void _signal;
  return delegatedRuntimeUnavailable();
}

export async function inspectCodexAcp(
  _profile: unknown,
  _signal: AbortSignal,
): Promise<never> {
  void _profile;
  void _signal;
  return delegatedRuntimeUnavailable();
}

export async function probeCodexAcp(
  _input: unknown,
  _signal: AbortSignal,
): Promise<never> {
  void _input;
  void _signal;
  return delegatedRuntimeUnavailable();
}

export function createAccountBoundCodexAcpRuntime(
  _profile: unknown,
  _accountSubjectFingerprint: string,
  _continuationStore: unknown,
): never {
  void _profile;
  void _accountSubjectFingerprint;
  void _continuationStore;
  return delegatedRuntimeUnavailable();
}
