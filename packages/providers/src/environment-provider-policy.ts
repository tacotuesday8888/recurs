import type { ProviderManifest } from "@recurs/contracts";

import { BUNDLED_PROVIDER_MANIFESTS } from "./bundled-manifests.js";

export function isEnvironmentByokManifest(
  manifest: ProviderManifest,
): boolean {
  return manifest.adapterKind === "model_provider" &&
    manifest.protocol === "openai_chat" &&
    manifest.credentialOwner === "recurs_broker" &&
    manifest.supportStatus === "supported" &&
    manifest.usagePolicy.defaultDecision === "allowed" &&
    manifest.usagePolicy.rules.length === 0 &&
    manifest.billingPolicy.providerFallback !== "unknown" &&
    manifest.authKinds.some(
      (kind) => kind === "api_key" || kind === "coding_plan_key",
    ) &&
    manifest.endpoints.some(
      (endpoint) => endpoint.kind === "origin" &&
        endpoint.value.startsWith("https://"),
    );
}

export function environmentByokManifest(
  providerId: string,
): ProviderManifest | null {
  const manifest = BUNDLED_PROVIDER_MANIFESTS.find(
    (candidate) => candidate.id === providerId,
  );
  return manifest !== undefined && isEnvironmentByokManifest(manifest)
    ? manifest
    : null;
}

export function environmentByokProviderIds(): readonly string[] {
  return Object.freeze(
    BUNDLED_PROVIDER_MANIFESTS
      .filter(isEnvironmentByokManifest)
      .map((manifest) => manifest.id),
  );
}
