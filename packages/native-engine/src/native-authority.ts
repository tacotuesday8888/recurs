import type { Duplex } from "node:stream";

import { NativeAuthorityService } from "@recurs/app";
import {
  NativeAuthorityClientUnavailableError,
  connectNativeAuthorityClient,
  type NativeAuthorityClient,
} from "@recurs/auth";
import { runCliProcess } from "@recurs/cli";
import {
  NATIVE_COMPONENT_VERSION,
  nativeOpenAIOnboardingFailure,
  type NativeAuthorityPort,
  type NativeAuthorityStatus,
  type NativeAuthorityUnavailableReason,
  type NativeOpenAIActivationReconciliation,
  type NativeOpenAIOnboardingAborted,
  type NativeOpenAIOnboardingBegun,
  type NativeOpenAIOnboardingCatalogPage,
  type NativeOpenAIOnboardingCommitted,
  type NativeOpenAIOnboardingOutcome,
  type NativeOpenAIResponsesPort,
  type ProviderEvent,
  type ProviderRequest,
} from "@recurs/contracts";

const PEER_IDENTITY_UNVERIFIED = Object.freeze({
  state: "unavailable",
  reason: "peer_identity_unverified",
} satisfies NativeAuthorityStatus);
const BROKER_UNAVAILABLE = Object.freeze({
  state: "unavailable",
  reason: "broker_unavailable",
} satisfies NativeAuthorityStatus);

export interface PrivateNativeAuthorityConnectOptions {
  readonly handshakeTimeoutMilliseconds?: number;
  readonly requestTimeoutMilliseconds?: number;
  readonly onboardingBeginTimeoutMilliseconds?: number;
  readonly onboardingControlTimeoutMilliseconds?: number;
}

export interface PrivateNativeAuthorityPort extends NativeAuthorityPort, NativeOpenAIResponsesPort {
  close(): void;
}

export function createPrivateNativeAuthorityPort(
  duplex: Duplex,
  options: PrivateNativeAuthorityConnectOptions = {},
): PrivateNativeAuthorityPort {
  let connection: Promise<NativeAuthorityClient> | undefined;
  let client: NativeAuthorityClient | undefined;
  let clientCloseIssued = false;
  let duplexDestroyIssued = false;
  let closed = false;

  const destroyDuplexOnce = (): void => {
    if (duplexDestroyIssued) return;
    duplexDestroyIssued = true;
    destroyWithoutDetails(duplex);
  };

  const closeClientOnce = (connected: NativeAuthorityClient): void => {
    if (clientCloseIssued) return;
    clientCloseIssued = true;
    try {
      connected.close();
    } catch {
      // Closing never exposes private transport details.
    }
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (client === undefined) {
      destroyDuplexOnce();
    } else {
      closeClientOnce(client);
    }
  };

  const connect = (signal?: AbortSignal): Promise<NativeAuthorityClient> => {
    if (closed) {
      return Promise.reject(
        new NativeAuthorityClientUnavailableError("broker_unavailable"),
      );
    }
    if (connection !== undefined) return connection;

    let started: Promise<NativeAuthorityClient>;
    try {
      const {
        handshakeTimeoutMilliseconds,
        requestTimeoutMilliseconds,
        onboardingBeginTimeoutMilliseconds,
        onboardingControlTimeoutMilliseconds,
      } = options;
      started = connectNativeAuthorityClient(duplex, {
        engineVersion: NATIVE_COMPONENT_VERSION,
        ...(handshakeTimeoutMilliseconds === undefined
          ? {}
          : { handshakeTimeoutMilliseconds }),
        ...(requestTimeoutMilliseconds === undefined
          ? {}
          : { requestTimeoutMilliseconds }),
        ...(onboardingBeginTimeoutMilliseconds === undefined
          ? {}
          : { onboardingBeginTimeoutMilliseconds }),
        ...(onboardingControlTimeoutMilliseconds === undefined
          ? {}
          : { onboardingControlTimeoutMilliseconds }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      destroyDuplexOnce();
      started = Promise.reject(
        new NativeAuthorityClientUnavailableError("broker_unavailable"),
      );
    }

    connection = started.then(
      (connected) => {
        client = connected;
        if (closed) {
          closeClientOnce(connected);
          throw new NativeAuthorityClientUnavailableError(
            "broker_unavailable",
          );
        }
        return connected;
      },
      (error: unknown) => {
        destroyDuplexOnce();
        throw error;
      },
    );
    return connection;
  };

  const onboarding = async <Value>(
    signal: AbortSignal | undefined,
    operation: (
      connected: NativeAuthorityClient,
      signal: AbortSignal | undefined,
    ) => Promise<NativeOpenAIOnboardingOutcome<Value>>,
  ): Promise<NativeOpenAIOnboardingOutcome<Value>> => {
    try {
      if (isCancelled(signal)) throw cancellation();
      const connected = await connect(signal);
      if (closed) {
        return nativeOpenAIOnboardingFailure("authority_unavailable");
      }
      const outcome = await operation(connected, signal);
      return closed
        ? nativeOpenAIOnboardingFailure("authority_unavailable")
        : outcome;
    } catch (error) {
      if (isAbortError(error) || isCancelled(signal)) {
        close();
        throw cancellation();
      }
      return nativeOpenAIOnboardingFailure("authority_unavailable");
    }
  };

  return Object.freeze({
    async status(signal?: AbortSignal): Promise<NativeAuthorityStatus> {
      if (closed) return BROKER_UNAVAILABLE;
      try {
        if (isCancelled(signal)) throw cancellation();
        const connected = await connect(signal);
        const status = await new NativeAuthorityService(connected).status(
          signal,
        );
        if (closed) return BROKER_UNAVAILABLE;
        return status.state === "ready" ? PEER_IDENTITY_UNVERIFIED : status;
      } catch (error) {
        if (isAbortError(error) || isCancelled(signal)) {
          close();
          throw cancellation();
        }
        return unavailable(safeClientFailureReason(error));
      }
    },
    beginOpenAIOnboarding(signal?: AbortSignal) {
      return onboarding<NativeOpenAIOnboardingBegun>(
        signal,
        (connected, operationSignal) =>
          connected.beginOpenAIOnboarding(operationSignal),
      );
    },
    verifyOpenAIOnboarding(signal?: AbortSignal) {
      return onboarding<NativeOpenAIOnboardingCatalogPage>(
        signal,
        (connected, operationSignal) =>
          connected.verifyOpenAIOnboarding(operationSignal),
      );
    },
    openAIOnboardingCatalogPage(cursor: number, signal?: AbortSignal) {
      return onboarding<NativeOpenAIOnboardingCatalogPage>(
        signal,
        (connected, operationSignal) =>
          connected.openAIOnboardingCatalogPage(cursor, operationSignal),
      );
    },
    finalizeOpenAIOnboarding(exactModelId: string, signal?: AbortSignal) {
      return onboarding<NativeOpenAIOnboardingCommitted>(
        signal,
        (connected, operationSignal) =>
          connected.finalizeOpenAIOnboarding(exactModelId, operationSignal),
      );
    },
    abortOpenAIOnboarding(signal?: AbortSignal) {
      return onboarding<NativeOpenAIOnboardingAborted>(
        signal,
        (connected, operationSignal) =>
          connected.abortOpenAIOnboarding(operationSignal),
      );
    },
    reconcileOpenAIActivation(
      connectionId: string,
      credentialIdentityFingerprint: string,
      signal?: AbortSignal,
    ) {
      return onboarding<NativeOpenAIActivationReconciliation>(
        signal,
        (connected, operationSignal) =>
          connected.reconcileOpenAIActivation(
            connectionId,
            credentialIdentityFingerprint,
            operationSignal,
          ),
      );
    },
    streamOpenAIResponses(request: ProviderRequest): AsyncIterable<ProviderEvent> {
      return {
        async *[Symbol.asyncIterator]() {
          if (closed) throw new NativeAuthorityClientUnavailableError("broker_unavailable");
          const connected = await connect(request.signal);
          yield* connected.streamOpenAIResponses(request);
        },
      };
    },
    close,
  });
}

export const createPrivateNativeAuthorityStatusPort =
  createPrivateNativeAuthorityPort;

export type PrivateEngineProcessInput =
  | { readonly duplex: Duplex }
  | { readonly unavailableReason: "launcher_unavailable" | "unsupported_platform" };

export async function runPrivateEngineProcess(
  input: PrivateEngineProcessInput,
): Promise<void> {
  const ownedNativeAuthority = "duplex" in input
    ? createPrivateNativeAuthorityPort(input.duplex)
    : undefined;
  const nativeAuthority = "duplex" in input
    ? ownedNativeAuthority as PrivateNativeAuthorityPort
    : fixedUnavailablePort(input.unavailableReason);
  try {
    await runCliProcess(nativeAuthority, ownedNativeAuthority);
  } finally {
    ownedNativeAuthority?.close();
  }
}

function fixedUnavailablePort(
  reason: "launcher_unavailable" | "unsupported_platform",
): NativeAuthorityPort {
  const status = unavailable(reason);
  const onboardingFailure = nativeOpenAIOnboardingFailure(
    "operation_unavailable",
  );
  return Object.freeze({
    async status() {
      return status;
    },
    async beginOpenAIOnboarding() {
      return onboardingFailure;
    },
    async verifyOpenAIOnboarding() {
      return onboardingFailure;
    },
    async openAIOnboardingCatalogPage() {
      return onboardingFailure;
    },
    async finalizeOpenAIOnboarding() {
      return onboardingFailure;
    },
    async abortOpenAIOnboarding() {
      return onboardingFailure;
    },
    async reconcileOpenAIActivation() {
      return onboardingFailure;
    },
  });
}

function unavailable(
  reason: NativeAuthorityUnavailableReason,
): NativeAuthorityStatus {
  return Object.freeze({ state: "unavailable", reason });
}

function safeClientFailureReason(
  error: unknown,
): NativeAuthorityUnavailableReason {
  try {
    if (!(error instanceof NativeAuthorityClientUnavailableError)) {
      return "broker_unavailable";
    }
    const reason: unknown = error.reason;
    switch (reason) {
      case "unsupported_platform":
      case "unsupported_os_version":
      case "launcher_unavailable":
      case "broker_unavailable":
      case "protocol_mismatch":
      case "peer_identity_unverified":
      case "production_signing_required":
      case "keychain_unavailable":
      case "unsupported_operation":
        return reason;
      default:
        return "broker_unavailable";
    }
  } catch {
    return "broker_unavailable";
  }
}

function cancellation(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function isAbortError(error: unknown): boolean {
  try {
    return error instanceof DOMException && error.name === "AbortError";
  } catch {
    return false;
  }
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  try {
    return signal?.aborted === true;
  } catch {
    return false;
  }
}

function destroyWithoutDetails(duplex: Duplex): void {
  try {
    duplex.destroy();
  } catch {
    // Resource closure is terminal and detail-free.
  }
}
