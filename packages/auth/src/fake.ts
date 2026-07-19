import type {
  NativeAuthorityStatus,
  NativeAuthorityStatusPort,
} from "@recurs/contracts";

export class FakeNativeAuthorityStatusPort
  implements NativeAuthorityStatusPort
{
  readonly #status: NativeAuthorityStatus;

  constructor(status: NativeAuthorityStatus) {
    this.#status = cloneStatus(status);
  }

  async status(signal?: AbortSignal): Promise<NativeAuthorityStatus> {
    if (signal?.aborted === true) {
      throw abortError();
    }
    return cloneStatus(this.#status);
  }
}

function cloneStatus(status: NativeAuthorityStatus): NativeAuthorityStatus {
  if (status.state === "unavailable") {
    return Object.freeze({
      state: "unavailable",
      reason: status.reason,
    });
  }
  return Object.freeze({
    state: "ready",
    attestation: Object.freeze({
      protocolVersion: status.attestation.protocolVersion,
      launcherVersion: status.attestation.launcherVersion,
      brokerVersion: status.attestation.brokerVersion,
      platform: status.attestation.platform,
      minimumMacosVersion: status.attestation.minimumMacosVersion,
      productionSigned: status.attestation.productionSigned,
      persistentCredentials: status.attestation.persistentCredentials,
    }),
    health: Object.freeze({
      keychain: status.health.keychain,
      broker: status.health.broker,
      peerIdentity: status.health.peerIdentity,
    }),
  });
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}
