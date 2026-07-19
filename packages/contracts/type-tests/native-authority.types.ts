import type {
  NativeAuthorityStatus,
  NativeAuthorityUnavailableReason,
} from "../src/index.js";
import type { nativeAuthorityUnavailableReasons } from "../test/native-authority-fixtures.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
        (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;

type Expect<Value extends true> = Value;

type ExpectedNativeAuthorityUnavailableReason =
  (typeof nativeAuthorityUnavailableReasons)[number];

type ExpectedNativeAuthorityStatus =
  | {
      readonly state: "ready";
      readonly attestation: {
        readonly protocolVersion: 1;
        readonly launcherVersion: string;
        readonly brokerVersion: string;
        readonly platform: "darwin";
        readonly minimumMacosVersion: "14.4";
        readonly productionSigned: boolean;
        readonly persistentCredentials: boolean;
      };
      readonly health: {
        readonly keychain: "available" | "locked" | "unavailable";
        readonly broker: "available";
        readonly peerIdentity: "verified";
      };
    }
  | {
      readonly state: "unavailable";
      readonly reason: ExpectedNativeAuthorityUnavailableReason;
    };

export type NativeAuthorityUnavailableReasonsAreExact = Expect<
  Equal<
    NativeAuthorityUnavailableReason,
    ExpectedNativeAuthorityUnavailableReason
  >
>;

export type NativeAuthorityStatusIsExact = Expect<
  Equal<NativeAuthorityStatus, ExpectedNativeAuthorityStatus>
>;

export const arbitraryNativeReasonMustFail: NativeAuthorityStatus = {
  state: "unavailable",
  // @ts-expect-error Arbitrary native text is not an enum-owned reason.
  reason: "the native broker returned arbitrary diagnostic text",
};

export const nativeMessageMustFail: NativeAuthorityStatus = {
  state: "unavailable",
  reason: "broker_unavailable",
  // @ts-expect-error Native diagnostic text is not part of the safe status.
  message: "the native broker returned arbitrary diagnostic text",
};
