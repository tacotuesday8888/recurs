import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  NATIVE_AUTHORITY_PROTOCOL_VERSION,
  createHostInvocation,
  deriveTrustedRunContext,
} from "../src/index.js";
import type {
  NativeAuthorityStatus,
  ProviderManifest,
  ProviderProtocol,
} from "../src/index.js";
import { nativeAuthorityUnavailableReasons } from "./native-authority-fixtures.js";

async function packageManifest(
  relativePath: string,
): Promise<{ dependencies?: Record<string, string> }> {
  return JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> };
}

describe("provider-neutral contracts", () => {
  it("describes native authority readiness without credential references", () => {
    expect(NATIVE_AUTHORITY_PROTOCOL_VERSION).toBe(1);

    const status: NativeAuthorityStatus = {
      state: "ready",
      attestation: {
        protocolVersion: NATIVE_AUTHORITY_PROTOCOL_VERSION,
        launcherVersion: "0.1.0",
        brokerVersion: "0.1.0",
        platform: "darwin",
        minimumMacosVersion: "14.4",
        productionSigned: true,
        persistentCredentials: true,
      },
      health: {
        keychain: "available",
        broker: "available",
        peerIdentity: "verified",
      },
    };

    expect(JSON.stringify(status)).not.toMatch(
      /credentialRef|authorization|token|secret|keychainItem/iu,
    );
  });

  it.each(nativeAuthorityUnavailableReasons)(
    "describes the %s native authority failure with an enum-owned reason",
    (reason) => {
      const status: NativeAuthorityStatus = {
        state: "unavailable",
        reason,
      };

      expect(status).toStrictEqual({ state: "unavailable", reason });
      expect(Object.keys(status)).toStrictEqual(["state", "reason"]);
      expect(nativeAuthorityUnavailableReasons).toContain(status.reason);
    },
  );

  it("describes a dependency-free provider manifest contract", () => {
    const protocol: ProviderProtocol = "local_openai";
    const manifest: ProviderManifest = {
      schemaVersion: 2,
      id: "fixture-local",
      activationProfileId: null,
      displayName: "Fixture Local",
      adapterKind: "model_provider",
      accessKind: "local",
      authKinds: ["local_endpoint"],
      credentialOwner: "none",
      protocol,
      endpoints: [
        { kind: "origin", value: "http://127.0.0.1:1234/v1" },
      ],
      regionAvailability: { kind: "local" },
      billingPolicy: {
        revision: "billing:fixture-local:2026-07-11",
        disclosureRevision: "billing-disclosure:fixture-local:2026-07-11",
        primarySource: "local_compute",
        possibleAdditionalSources: [],
        providerFallback: "none",
        availableSelections: ["strict_primary_only"],
      },
      supportStatus: "supported",
      runnable: true,
      usagePolicy: {
        revision: "fixture-local-2026-07-11",
        reviewedAt: "2026-07-11",
        expiresAt: "2026-10-11T00:00:00.000Z",
        defaultDecision: "allowed",
        rules: [],
        officialRuntimeRequired: false,
        accountSharingForbidden: true,
        sourceUrls: ["https://example.com/official-docs"],
        evidenceSummary: "The documented loopback endpoint needs no credential.",
      },
    };

    expect(manifest.protocol).toBe("local_openai");
    expect(manifest.endpoints).toEqual([
      { kind: "origin", value: "http://127.0.0.1:1234/v1" },
    ]);
    expect(manifest.regionAvailability).toEqual({ kind: "local" });
    expect(manifest.billingPolicy.primarySource).toBe("local_compute");
  });

  it("derives every trusted context dimension from a host-only invocation", () => {
    const invocation = createHostInvocation({
      invocation: "one_shot",
      userPresent: false,
      remote: true,
      scripted: true,
      embedding: "ci",
    });

    expect(deriveTrustedRunContext(invocation)).toEqual({
      invocation: "one_shot",
      presence: "unattended",
      location: "remote",
      automation: "scripted",
      embedding: "ci",
    });
  });

  it("rejects a structurally forged host invocation at runtime", () => {
    expect(() => deriveTrustedRunContext({
      invocation: "one_shot",
      userPresent: true,
      remote: false,
      scripted: false,
      embedding: "cli",
    } as never)).toThrow("trusted host");
  });

  it("keeps contracts as a dependency leaf", async () => {
    const contracts = await packageManifest("../package.json");
    const providers = await packageManifest("../../providers/package.json");
    const tools = await packageManifest("../../tools/package.json");

    expect(contracts.dependencies).toBeUndefined();
    expect(providers.dependencies).toEqual({ "@recurs/contracts": "0.0.0" });
    expect(tools.dependencies).toEqual({ "@recurs/contracts": "0.0.0" });
  });
});
