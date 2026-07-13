export const NATIVE_OPENAI_ONBOARDING_FAILURE_MESSAGES = Object.freeze({
  invalid_request: "The native OpenAI onboarding request is invalid.",
  session_not_ready:
    "Native OpenAI onboarding is not ready for that operation.",
  busy: "Native OpenAI onboarding is busy.",
  cancelled: "Native OpenAI onboarding was cancelled.",
  expired: "Native OpenAI onboarding expired.",
  verification_failed: "OpenAI credential verification failed.",
  invalid_model: "The selected OpenAI model is invalid.",
  no_compatible_models: "No compatible OpenAI models are available.",
  commit_failed: "The OpenAI connection could not be committed.",
  credential_store_unavailable: "Secure credential storage is unavailable.",
  cleanup_failed: "Native OpenAI onboarding cleanup failed.",
  reconciliation_required: "The OpenAI connection requires reconciliation.",
  authority_unavailable:
    "Native OpenAI onboarding authority is unavailable.",
  operation_unavailable:
    "Native OpenAI onboarding is unavailable for this invocation.",
} as const);

export type NativeOpenAIOnboardingFailureCode =
  keyof typeof NATIVE_OPENAI_ONBOARDING_FAILURE_MESSAGES;

type NativeOpenAIOnboardingFailureFor<
  Code extends NativeOpenAIOnboardingFailureCode,
> = Code extends NativeOpenAIOnboardingFailureCode
  ? Readonly<{
      state: "failed";
      code: Code;
      safeMessage: (typeof NATIVE_OPENAI_ONBOARDING_FAILURE_MESSAGES)[Code];
    }>
  : never;

export type NativeOpenAIOnboardingFailure = {
  [Code in NativeOpenAIOnboardingFailureCode]:
    NativeOpenAIOnboardingFailureFor<Code>;
}[NativeOpenAIOnboardingFailureCode];

export type NativeOpenAIOnboardingOutcome<Value> =
  | Readonly<{ state: "succeeded"; value: Value }>
  | NativeOpenAIOnboardingFailure;

export interface NativeOpenAIOnboardingBegun {
  readonly connectionId: string;
  readonly credentialIdentityFingerprint: string;
}

export interface NativeOpenAIOnboardingCatalogPage {
  readonly cursor: number;
  readonly totalModelCount: number;
  readonly nextCursor: number | null;
  readonly modelIds: readonly string[];
}

export interface NativeOpenAIOnboardingCommitted {
  readonly connectionId: string;
  readonly selectedModelId: string;
  readonly verifiedModelCount: number;
}

export interface NativeOpenAIOnboardingAborted {
  readonly aborted: true;
}

export interface NativeOpenAIActivationReconciliation {
  readonly status: "ready_openai" | "absent" | "unresolved";
}

export interface NativeOpenAIOnboardingPort {
  beginOpenAIOnboarding(
    signal?: AbortSignal,
  ): Promise<NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingBegun>>;
  verifyOpenAIOnboarding(
    signal?: AbortSignal,
  ): Promise<NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingCatalogPage>>;
  openAIOnboardingCatalogPage(
    cursor: number,
    signal?: AbortSignal,
  ): Promise<NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingCatalogPage>>;
  finalizeOpenAIOnboarding(
    exactModelId: string,
    signal?: AbortSignal,
  ): Promise<NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingCommitted>>;
  abortOpenAIOnboarding(
    signal?: AbortSignal,
  ): Promise<NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingAborted>>;
  reconcileOpenAIActivation(
    connectionId: string,
    credentialIdentityFingerprint: string,
    signal?: AbortSignal,
  ): Promise<
    NativeOpenAIOnboardingOutcome<NativeOpenAIActivationReconciliation>
  >;
}

export function nativeOpenAIOnboardingFailure<
  Code extends NativeOpenAIOnboardingFailureCode,
>(code: Code): NativeOpenAIOnboardingFailureFor<Code>;
export function nativeOpenAIOnboardingFailure(
  code: NativeOpenAIOnboardingFailureCode,
): NativeOpenAIOnboardingFailure {
  if (
    typeof code !== "string" ||
    !Object.prototype.hasOwnProperty.call(
      NATIVE_OPENAI_ONBOARDING_FAILURE_MESSAGES,
      code,
    )
  ) {
    throw new TypeError(
      "Native OpenAI onboarding failure code is invalid.",
    );
  }
  const failure = {
    state: "failed",
    code,
    safeMessage: NATIVE_OPENAI_ONBOARDING_FAILURE_MESSAGES[code],
  } as NativeOpenAIOnboardingFailure;
  return Object.freeze(failure);
}

export function nativeOpenAIOnboardingSucceeded<Value>(
  value: Value,
): Readonly<{ state: "succeeded"; value: Value }> {
  return Object.freeze({ state: "succeeded", value });
}
