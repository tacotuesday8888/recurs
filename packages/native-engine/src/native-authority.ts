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
  type NativeAuthorityStatus,
  type NativeAuthorityStatusPort,
  type NativeAuthorityUnavailableReason,
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
}

export interface PrivateNativeAuthorityStatusPort
  extends NativeAuthorityStatusPort {
  close(): void;
}

export function createPrivateNativeAuthorityStatusPort(
  duplex: Duplex,
  options: PrivateNativeAuthorityConnectOptions = {},
): PrivateNativeAuthorityStatusPort {
  let client: NativeAuthorityClient | undefined;
  let claimed = false;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    try {
      client?.close();
    } catch {
      // Closing never exposes private transport details.
    }
    destroyWithoutDetails(duplex);
  };

  return Object.freeze({
    async status(signal?: AbortSignal): Promise<NativeAuthorityStatus> {
      if (isCancelled(signal)) throw cancellation();
      if (claimed || closed) return BROKER_UNAVAILABLE;
      claimed = true;
      try {
        client = await connectNativeAuthorityClient(duplex, {
          engineVersion: NATIVE_COMPONENT_VERSION,
          ...(options.handshakeTimeoutMilliseconds === undefined
            ? {}
            : {
                handshakeTimeoutMilliseconds:
                  options.handshakeTimeoutMilliseconds,
              }),
          ...(options.requestTimeoutMilliseconds === undefined
            ? {}
            : {
                requestTimeoutMilliseconds:
                  options.requestTimeoutMilliseconds,
              }),
          ...(signal === undefined ? {} : { signal }),
        });
        const service = new NativeAuthorityService(
          client,
          () => client?.close(),
        );
        try {
          const status = await service.status(signal);
          return status.state === "ready"
            ? PEER_IDENTITY_UNVERIFIED
            : status;
        } finally {
          service.close();
        }
      } catch (error) {
        if (isAbortError(error) || isCancelled(signal)) {
          throw cancellation();
        }
        return unavailable(safeClientFailureReason(error));
      } finally {
        close();
      }
    },
    close,
  });
}

export type PrivateEngineProcessInput =
  | { readonly duplex: Duplex }
  | { readonly unavailableReason: "launcher_unavailable" | "unsupported_platform" };

export async function runPrivateEngineProcess(
  input: PrivateEngineProcessInput,
): Promise<void> {
  const ownedNativeAuthority = "duplex" in input
    ? createPrivateNativeAuthorityStatusPort(input.duplex)
    : undefined;
  const nativeAuthority = "duplex" in input
    ? ownedNativeAuthority as PrivateNativeAuthorityStatusPort
    : fixedUnavailablePort(input.unavailableReason);
  try {
    await runCliProcess(nativeAuthority);
  } finally {
    ownedNativeAuthority?.close();
  }
}

function fixedUnavailablePort(
  reason: "launcher_unavailable" | "unsupported_platform",
): NativeAuthorityStatusPort {
  const status = unavailable(reason);
  return Object.freeze({
    async status() {
      return status;
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
  return error instanceof NativeAuthorityClientUnavailableError
    ? error.reason
    : "broker_unavailable";
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
  return signal?.aborted === true;
}

function destroyWithoutDetails(duplex: Duplex): void {
  try {
    duplex.destroy();
  } catch {
    // Resource closure is terminal and detail-free.
  }
}
