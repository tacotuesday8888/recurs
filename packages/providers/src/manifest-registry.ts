import type { ProviderManifest } from "@recurs/contracts";

import { BUNDLED_PROVIDER_MANIFESTS } from "./bundled-manifests.js";
import { validateProviderManifest } from "./manifest-validator.js";

export interface ProviderManifestListOptions {
  includeBlocked?: boolean;
}

function isBlocked(manifest: ProviderManifest): boolean {
  return manifest.supportStatus === "blocked" ||
    manifest.supportStatus === "blocked_pending_written_approval";
}

function defensiveList(
  manifests: readonly ProviderManifest[],
): readonly ProviderManifest[] {
  return Object.freeze(manifests.map((manifest) => validateProviderManifest(manifest)));
}

export class ProviderManifestRegistry {
  readonly #manifests: readonly ProviderManifest[];
  readonly #byId: ReadonlyMap<string, ProviderManifest>;

  constructor(manifests: readonly ProviderManifest[] = BUNDLED_PROVIDER_MANIFESTS) {
    const validated: ProviderManifest[] = [];
    const byId = new Map<string, ProviderManifest>();
    for (const candidate of manifests) {
      const manifest = validateProviderManifest(candidate);
      if (byId.has(manifest.id)) {
        throw new TypeError(`Duplicate provider manifest id: ${manifest.id}`);
      }
      validated.push(manifest);
      byId.set(manifest.id, manifest);
    }
    this.#manifests = Object.freeze(validated);
    this.#byId = byId;
  }

  list(options: ProviderManifestListOptions = {}): readonly ProviderManifest[] {
    const manifests = options.includeBlocked === true
      ? this.#manifests
      : this.#manifests.filter((manifest) => !isBlocked(manifest));
    return defensiveList(manifests);
  }

  get(id: string): ProviderManifest | undefined {
    const manifest = this.#byId.get(id);
    return manifest === undefined ? undefined : validateProviderManifest(manifest);
  }

  runnable(): readonly ProviderManifest[] {
    return defensiveList(this.#manifests.filter((manifest) => manifest.runnable));
  }
}
