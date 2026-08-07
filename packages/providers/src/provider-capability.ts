import { BUNDLED_PROVIDER_MANIFESTS } from "./bundled-manifests.js";
import {
  environmentByokAdapterId,
  environmentCredentialManifest,
  type EnvironmentByokAdapterId,
} from "./environment-provider-policy.js";
import { hasEnvironmentProviderModelDiscovery } from "./environment-models.js";

export interface ProviderTransportCapability {
  readonly providerId: string;
  readonly cataloged: boolean;
  readonly adapterId: EnvironmentByokAdapterId | null;
  readonly authentication: boolean;
  readonly modelDiscoveryReadinessProbe: boolean;
  readonly streaming: boolean;
  readonly tools: boolean;
  readonly usage: boolean;
  readonly errors: boolean;
}

export function providerTransportCapability(
  providerId: string,
): ProviderTransportCapability {
  const cataloged = BUNDLED_PROVIDER_MANIFESTS.some(
    (manifest) => manifest.id === providerId,
  );
  const manifest = environmentCredentialManifest(providerId);
  const adapterId = manifest === null
    ? null
    : environmentByokAdapterId(manifest);
  const implemented = adapterId !== null;
  const modelDiscoveryReadinessProbe = implemented &&
    hasEnvironmentProviderModelDiscovery(providerId);
  return Object.freeze({
    providerId,
    cataloged,
    adapterId,
    authentication: implemented,
    modelDiscoveryReadinessProbe,
    streaming: implemented,
    tools: implemented,
    usage: implemented,
    errors: implemented,
  });
}
