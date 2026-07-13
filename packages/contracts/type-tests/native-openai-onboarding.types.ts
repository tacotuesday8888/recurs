import type {
  NATIVE_OPENAI_ONBOARDING_FAILURE_MESSAGES,
  NativeAuthorityPort,
  NativeAuthorityStatusPort,
  NativeOpenAIActivationReconciliation,
  NativeOpenAIOnboardingAborted,
  NativeOpenAIOnboardingBegun,
  NativeOpenAIOnboardingCatalogPage,
  NativeOpenAIOnboardingCommitted,
  NativeOpenAIOnboardingFailure,
  NativeOpenAIOnboardingFailureCode,
  NativeOpenAIOnboardingOutcome,
  NativeOpenAIOnboardingPort,
} from "../src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
        (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;

type Expect<Value extends true> = Value;

type ExpectedFailureCode =
  | "invalid_request"
  | "session_not_ready"
  | "busy"
  | "cancelled"
  | "expired"
  | "verification_failed"
  | "invalid_model"
  | "no_compatible_models"
  | "commit_failed"
  | "credential_store_unavailable"
  | "cleanup_failed"
  | "reconciliation_required"
  | "authority_unavailable"
  | "operation_unavailable";

type ExpectedFailure = {
  [Code in ExpectedFailureCode]: Readonly<{
    state: "failed";
    code: Code;
    safeMessage: (typeof NATIVE_OPENAI_ONBOARDING_FAILURE_MESSAGES)[Code];
  }>;
}[ExpectedFailureCode];

export type FailureCodesAreExact = Expect<
  Equal<NativeOpenAIOnboardingFailureCode, ExpectedFailureCode>
>;

export type FailureShapeIsExact = Expect<
  Equal<NativeOpenAIOnboardingFailure, ExpectedFailure>
>;

export type OutcomeShapeIsExact = Expect<
  Equal<
    NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingBegun>,
    | Readonly<{
        state: "succeeded";
        value: NativeOpenAIOnboardingBegun;
      }>
    | NativeOpenAIOnboardingFailure
  >
>;

export type CombinedAuthorityIncludesStatus = Expect<
  NativeAuthorityPort extends NativeAuthorityStatusPort ? true : false
>;

export type CombinedAuthorityIncludesOnboarding = Expect<
  NativeAuthorityPort extends NativeOpenAIOnboardingPort ? true : false
>;

declare const port: NativeOpenAIOnboardingPort;
declare const signal: AbortSignal;

export const begun = port.beginOpenAIOnboarding(signal);
export const verified = port.verifyOpenAIOnboarding(signal);
export const page = port.openAIOnboardingCatalogPage(12, signal);
export const committed = port.finalizeOpenAIOnboarding("gpt-5", signal);
export const aborted = port.abortOpenAIOnboarding(signal);
export const reconciled = port.reconcileOpenAIActivation(
  "00000000-0000-4000-8000-000000000000",
  `sha256:${"a".repeat(64)}`,
  signal,
);

export type BeginReturnIsExact = Expect<
  Equal<
    typeof begun,
    Promise<NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingBegun>>
  >
>;
export type VerifyReturnIsExact = Expect<
  Equal<
    typeof verified,
    Promise<NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingCatalogPage>>
  >
>;
export type PageReturnIsExact = Expect<
  Equal<
    typeof page,
    Promise<NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingCatalogPage>>
  >
>;
export type FinalizeReturnIsExact = Expect<
  Equal<
    typeof committed,
    Promise<NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingCommitted>>
  >
>;
export type AbortReturnIsExact = Expect<
  Equal<
    typeof aborted,
    Promise<NativeOpenAIOnboardingOutcome<NativeOpenAIOnboardingAborted>>
  >
>;
export type ReconcileReturnIsExact = Expect<
  Equal<
    typeof reconciled,
    Promise<
      NativeOpenAIOnboardingOutcome<NativeOpenAIActivationReconciliation>
    >
  >
>;

export const secretBegunMustFail: NativeOpenAIOnboardingBegun = {
  connectionId: "00000000-0000-4000-8000-000000000000",
  credentialIdentityFingerprint: `sha256:${"a".repeat(64)}`,
  // @ts-expect-error Secret material is not part of the public begun result.
  credential: "sk-secret",
};

export const endpointPageMustFail: NativeOpenAIOnboardingCatalogPage = {
  cursor: 0,
  totalModelCount: 1,
  nextCursor: null,
  modelIds: ["gpt-5"],
  // @ts-expect-error Endpoint authority is not part of the public model page.
  endpoint: "https://api.openai.com/v1",
};

export const nativeTokenCommittedMustFail: NativeOpenAIOnboardingCommitted = {
  connectionId: "00000000-0000-4000-8000-000000000000",
  selectedModelId: "gpt-5",
  verifiedModelCount: 1,
  // @ts-expect-error Native authority tokens are not public commit metadata.
  nativeCapability: "secret-capability",
};

export const providerRequestIdPageMustFail: NativeOpenAIOnboardingCatalogPage = {
  cursor: 0,
  totalModelCount: 1,
  nextCursor: null,
  modelIds: ["gpt-5"],
  // @ts-expect-error Provider response-header identifiers stay private.
  catalogRequestId: "provider-request-id",
};

export const providerRequestIdCommitMustFail: NativeOpenAIOnboardingCommitted = {
  connectionId: "00000000-0000-4000-8000-000000000000",
  selectedModelId: "gpt-5",
  verifiedModelCount: 1,
  // @ts-expect-error Provider response-header identifiers stay private.
  catalogRequestId: "provider-request-id",
};

export const abortedMarker: NativeOpenAIOnboardingAborted = { aborted: true };
export const reconciliation: NativeOpenAIActivationReconciliation = {
  status: "ready_openai",
};

// @ts-expect-error Reconciliation uses scalar redacted inputs, not an object.
void port.reconcileOpenAIActivation({
  connectionId: "00000000-0000-4000-8000-000000000000",
  credentialIdentityFingerprint: `sha256:${"a".repeat(64)}`,
  credential: "sk-secret",
});

// @ts-expect-error Begin accepts only an optional AbortSignal.
void port.beginOpenAIOnboarding({ credential: "sk-secret" });
