import { describe, expect, it } from "vitest";

import * as contracts from "../src/index.js";

const expectedMessages = Object.freeze({
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

interface ExpectedRuntimeContracts {
  readonly NATIVE_OPENAI_ONBOARDING_FAILURE_MESSAGES: typeof expectedMessages;
  nativeOpenAIOnboardingFailure(
    code: keyof typeof expectedMessages,
  ): Readonly<{
    state: "failed";
    code: keyof typeof expectedMessages;
    safeMessage: (typeof expectedMessages)[keyof typeof expectedMessages];
  }>;
  nativeOpenAIOnboardingSucceeded<Value>(
    value: Value,
  ): Readonly<{ state: "succeeded"; value: Value }>;
}

function runtimeContracts(): ExpectedRuntimeContracts {
  expect(contracts).toHaveProperty(
    "NATIVE_OPENAI_ONBOARDING_FAILURE_MESSAGES",
  );
  expect(contracts).toHaveProperty(
    "nativeOpenAIOnboardingFailure",
    expect.any(Function),
  );
  expect(contracts).toHaveProperty(
    "nativeOpenAIOnboardingSucceeded",
    expect.any(Function),
  );
  return contracts as unknown as ExpectedRuntimeContracts;
}

describe("native OpenAI onboarding contracts", () => {
  it("owns the exact fixed failure vocabulary and safe messages", () => {
    const runtime = runtimeContracts();

    expect(runtime.NATIVE_OPENAI_ONBOARDING_FAILURE_MESSAGES).toEqual(
      expectedMessages,
    );
    expect(Object.isFrozen(runtime.NATIVE_OPENAI_ONBOARDING_FAILURE_MESSAGES))
      .toBe(true);

    for (const [code, safeMessage] of Object.entries(expectedMessages)) {
      const failure = runtime.nativeOpenAIOnboardingFailure(
        code as keyof typeof expectedMessages,
      );
      expect(failure).toStrictEqual({ state: "failed", code, safeMessage });
      expect(Object.keys(failure)).toStrictEqual([
        "state",
        "code",
        "safeMessage",
      ]);
      expect(Object.isFrozen(failure)).toBe(true);
    }
  });

  it("rejects unknown runtime failure codes without reflecting them", () => {
    const runtime = runtimeContracts();
    const canary = "SECRET_NATIVE_FAILURE_CODE_CANARY";

    let error: unknown;
    try {
      runtime.nativeOpenAIOnboardingFailure(canary as never);
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      name: "TypeError",
      message: "Native OpenAI onboarding failure code is invalid.",
    });
    expect(JSON.stringify(error)).not.toContain(canary);
  });

  it("creates a frozen generic success outcome without adding fields", () => {
    const runtime = runtimeContracts();
    const value = Object.freeze({ connectionId: "connection-1" });

    const outcome = runtime.nativeOpenAIOnboardingSucceeded(value);

    expect(outcome).toStrictEqual({ state: "succeeded", value });
    expect(Object.keys(outcome)).toStrictEqual(["state", "value"]);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(outcome.value).toBe(value);
  });
});
