import type { ProviderManifest } from "@recurs/contracts";

import { BUNDLED_PROVIDER_MANIFESTS } from "./bundled-manifests.js";

export type EnvironmentByokAdapterId =
  | "anthropic-messages"
  | "openai-chat-completions";

export function environmentByokAdapterId(
  manifest: ProviderManifest,
): EnvironmentByokAdapterId | null {
  if (manifest.protocol === "openai_chat") return "openai-chat-completions";
  if (manifest.protocol === "anthropic_messages") return "anthropic-messages";
  return null;
}

export function isEnvironmentByokManifest(
  manifest: ProviderManifest,
): boolean {
  const adapterId = environmentByokAdapterId(manifest);
  const hasReviewedEndpoint = manifest.endpoints.some(
    (endpoint) => endpoint.kind === "origin" &&
      (adapterId === "openai-chat-completions"
        ? endpoint.value.startsWith("https://")
        : manifest.id === "anthropic-api" &&
          endpoint.value === "https://api.anthropic.com/v1"),
  );
  return manifest.adapterKind === "model_provider" &&
    adapterId !== null &&
    manifest.credentialOwner === "recurs_broker" &&
    manifest.supportStatus === "supported" &&
    manifest.usagePolicy.defaultDecision === "allowed" &&
    manifest.usagePolicy.rules.length === 0 &&
    manifest.billingPolicy.providerFallback !== "unknown" &&
    manifest.authKinds.some(
      (kind) => kind === "api_key" || kind === "coding_plan_key",
    ) &&
    hasReviewedEndpoint;
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
