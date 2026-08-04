import type { ProviderManifest } from "@recurs/contracts";

import { BUNDLED_PROVIDER_MANIFESTS } from "./bundled-manifests.js";

export type EnvironmentByokAdapterId =
  | "anthropic-messages"
  | "gemini-generate-content"
  | "openai-chat-completions"
  | "openai-responses";

export function environmentByokAdapterId(
  manifest: ProviderManifest,
): EnvironmentByokAdapterId | null {
  if (manifest.protocol === "openai_chat") return "openai-chat-completions";
  if (manifest.protocol === "openai_responses") return "openai-responses";
  if (manifest.protocol === "anthropic_messages") return "anthropic-messages";
  if (manifest.protocol === "gemini_generate_content") {
    return "gemini-generate-content";
  }
  return null;
}

export function isEnvironmentByokManifest(
  manifest: ProviderManifest,
): boolean {
  return isEnvironmentCredentialManifest(manifest) &&
    manifest.supportStatus === "supported" &&
    manifest.usagePolicy.defaultDecision === "allowed" &&
    manifest.usagePolicy.rules.length === 0;
}

/**
 * Returns whether Recurs has a fixed, reviewed transport for a credential
 * supplied through the process environment. Conditional manifests still need
 * application-layer policy evaluation before setup and every run.
 */
export function isEnvironmentCredentialManifest(
  manifest: ProviderManifest,
): boolean {
  const adapterId = environmentByokAdapterId(manifest);
  const hasReviewedEndpoint = manifest.endpoints.some(
    (endpoint) => endpoint.kind === "origin" &&
      (adapterId === "openai-chat-completions"
        ? manifest.id === "alibaba-coding-plan"
          ? endpoint.value ===
            "https://coding-intl.dashscope.aliyuncs.com/v1"
          : endpoint.value.startsWith("https://")
        : adapterId === "openai-responses"
        ? manifest.id === "openai-api" &&
          endpoint.value === "https://api.openai.com/v1"
        : adapterId === "gemini-generate-content"
        ? manifest.id === "google-gemini-api" &&
          endpoint.value === "https://generativelanguage.googleapis.com/v1beta"
        : (manifest.id === "anthropic-api" &&
            endpoint.value === "https://api.anthropic.com/v1") ||
          (manifest.id === "minimax-token-plan" &&
            endpoint.value === "https://api.minimax.io/anthropic")),
  );
  return manifest.adapterKind === "model_provider" &&
    adapterId !== null &&
    manifest.credentialOwner === "recurs_broker" &&
    (manifest.supportStatus === "supported" ||
      manifest.supportStatus === "conditional") &&
    manifest.usagePolicy.defaultDecision !== "unknown" &&
    manifest.billingPolicy.providerFallback !== "unknown" &&
    manifest.authKinds.some(
      (kind) => kind === "api_key" || kind === "coding_plan_key",
    ) &&
    hasReviewedEndpoint;
}

export function environmentCredentialManifest(
  providerId: string,
): ProviderManifest | null {
  const manifest = BUNDLED_PROVIDER_MANIFESTS.find(
    (candidate) => candidate.id === providerId,
  );
  return manifest !== undefined && isEnvironmentCredentialManifest(manifest)
    ? manifest
    : null;
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
