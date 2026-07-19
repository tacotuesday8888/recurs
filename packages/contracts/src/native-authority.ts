import type { NativeOpenAIOnboardingPort } from "./native-openai-onboarding.js";

export const NATIVE_AUTHORITY_PROTOCOL_VERSION = 1 as const;

export type NativeAuthorityUnavailableReason =
  | "unsupported_platform"
  | "unsupported_os_version"
  | "launcher_unavailable"
  | "broker_unavailable"
  | "protocol_mismatch"
  | "peer_identity_unverified"
  | "production_signing_required"
  | "keychain_unavailable"
  | "unsupported_operation";

export interface NativeAuthorityAttestation {
  readonly protocolVersion: typeof NATIVE_AUTHORITY_PROTOCOL_VERSION;
  readonly launcherVersion: string;
  readonly brokerVersion: string;
  readonly platform: "darwin";
  readonly minimumMacosVersion: "14.4";
  readonly productionSigned: boolean;
  readonly persistentCredentials: boolean;
}

export interface NativeAuthorityHealth {
  readonly keychain: "available" | "locked" | "unavailable";
  readonly broker: "available";
  readonly peerIdentity: "verified";
}

export type NativeAuthorityStatus =
  | {
      readonly state: "ready";
      readonly attestation: NativeAuthorityAttestation;
      readonly health: NativeAuthorityHealth;
    }
  | {
      readonly state: "unavailable";
      readonly reason: NativeAuthorityUnavailableReason;
    };

export interface NativeAuthorityStatusPort {
  status(signal?: AbortSignal): Promise<NativeAuthorityStatus>;
}

export interface NativeAuthorityPort
  extends NativeAuthorityStatusPort, NativeOpenAIOnboardingPort {}
