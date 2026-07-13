import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BUNDLED_PROVIDER_ACTIVATION_PROFILE_IDS,
  PROVIDER_ACTIVATION_PROFILES,
} from "../src/provider-activation-profiles.js";
import { generateProviderActivationProfiles } from "../../../scripts/generate-provider-activation-profiles.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const sourceRelativePath = "policy/provider-activation-profiles.v1.json";
const typescriptRelativePath =
  "packages/contracts/src/provider-activation-profiles.ts";
const swiftRelativePath =
  "native/macos/Sources/RecursBrokerCore/GeneratedProviderActivationProfiles.swift";
const invalidSourceError = new Error(
  "Invalid provider activation profile source",
);
const canonicalSource = `{
  "schemaVersion": 1,
  "profiles": [
    {
      "id": "anthropic_api_v1",
      "bundledProviderId": "anthropic-api"
    },
    {
      "id": "custom_openai_compatible_v1",
      "bundledProviderId": null
    },
    {
      "id": "kimi_code_v1",
      "bundledProviderId": "kimi-code"
    },
    {
      "id": "openai_api_v1",
      "bundledProviderId": "openai-api"
    }
  ]
}
`;

const temporaryDirectories: string[] = [];

async function temporaryRoot(source: string | null = canonicalSource): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "recurs-provider-profiles-"));
  temporaryDirectories.push(root);
  if (source !== null) {
    await mkdir(path.join(root, "policy"), { recursive: true });
    await writeFile(path.join(root, sourceRelativePath), source, "utf8");
  }
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("provider activation profile generation", () => {
  it("exports one exact frozen cross-language identity catalog", async () => {
    const sourceText = await readFile(
      path.join(repositoryRoot, sourceRelativePath),
      "utf8",
    );
    const swift = await readFile(
      path.join(repositoryRoot, swiftRelativePath),
      "utf8",
    );

    expect(sourceText).toBe(canonicalSource);
    expect(PROVIDER_ACTIVATION_PROFILES).toEqual([
      { id: "anthropic_api_v1", bundledProviderId: "anthropic-api" },
      {
        id: "custom_openai_compatible_v1",
        bundledProviderId: null,
      },
      { id: "kimi_code_v1", bundledProviderId: "kimi-code" },
      { id: "openai_api_v1", bundledProviderId: "openai-api" },
    ]);
    expect(Object.isFrozen(PROVIDER_ACTIVATION_PROFILES)).toBe(true);
    expect(
      PROVIDER_ACTIVATION_PROFILES.every((profile) => Object.isFrozen(profile)),
    ).toBe(true);
    expect(BUNDLED_PROVIDER_ACTIVATION_PROFILE_IDS).toEqual({
      "anthropic-api": "anthropic_api_v1",
      "kimi-code": "kimi_code_v1",
      "openai-api": "openai_api_v1",
    });
    expect(Object.isFrozen(BUNDLED_PROVIDER_ACTIVATION_PROFILE_IDS)).toBe(true);
    expect(BUNDLED_PROVIDER_ACTIVATION_PROFILE_IDS).not.toHaveProperty(
      "custom-openai-compatible",
    );

    for (const id of PROVIDER_ACTIVATION_PROFILES.map(({ id }) => id)) {
      expect(swift).toContain(`= "${id}"`);
    }
    expect(swift).toContain(
      "enum ProviderActivationProfileID: String, Codable, Hashable, CaseIterable, Sendable",
    );
    expect(swift).toContain("var bundledProviderID: String?");
    expect(swift).not.toMatch(/endpoint|route|header|billing|wire/iu);
  });

  it("generates deterministic TypeScript and Swift and checks without writes", async () => {
    const root = await temporaryRoot();
    expect(
      await generateProviderActivationProfiles({ rootDirectory: root, check: true }),
    ).toBe(false);
    expect(
      await generateProviderActivationProfiles({ rootDirectory: root, check: false }),
    ).toBe(true);

    const typescriptPath = path.join(root, typescriptRelativePath);
    const swiftPath = path.join(root, swiftRelativePath);
    const first = await Promise.all([
      readFile(typescriptPath, "utf8"),
      readFile(swiftPath, "utf8"),
    ]);
    await generateProviderActivationProfiles({ rootDirectory: root, check: false });
    expect(await Promise.all([
      readFile(typescriptPath, "utf8"),
      readFile(swiftPath, "utf8"),
    ])).toEqual(first);

    await writeFile(typescriptPath, "drift\n", "utf8");
    expect(
      await generateProviderActivationProfiles({ rootDirectory: root, check: true }),
    ).toBe(false);
    expect(await readFile(typescriptPath, "utf8")).toBe("drift\n");
    expect(await readFile(swiftPath, "utf8")).toBe(first[1]);
  });

  it("stages every output before replacing any generated file", async () => {
    const root = await temporaryRoot();
    const blockedParent = path.join(root, "native/macos/Sources/RecursBrokerCore");
    await mkdir(path.dirname(blockedParent), { recursive: true });
    await writeFile(blockedParent, "not a directory", "utf8");

    await expect(
      generateProviderActivationProfiles({ rootDirectory: root, check: false }),
    ).rejects.toThrowError(new Error("Provider activation profile generation failed"));
    await expect(access(path.join(root, typescriptRelativePath))).rejects.toThrow();
  });

  it.each([
    ["missing", null],
    ["malformed", "{"],
    ["noncanonical", JSON.stringify(JSON.parse(canonicalSource))],
    [
      "duplicate",
      `${JSON.stringify({
        schemaVersion: 1,
        profiles: [
          { id: "openai_api_v1", bundledProviderId: "openai-api" },
          { id: "openai_api_v1", bundledProviderId: "other-api" },
        ],
      }, null, 2)}\n`,
    ],
    [
      "unsorted",
      `${JSON.stringify({
        schemaVersion: 1,
        profiles: [
          { id: "openai_api_v1", bundledProviderId: "openai-api" },
          { id: "anthropic_api_v1", bundledProviderId: "anthropic-api" },
        ],
      }, null, 2)}\n`,
    ],
    [
      "unversioned",
      `${JSON.stringify({
        schemaVersion: 1,
        profiles: [
          { id: "openai_api", bundledProviderId: "openai-api" },
        ],
      }, null, 2)}\n`,
    ],
  ])("rejects %s input with one fixed non-disclosing error", async (_label, source) => {
    const root = await temporaryRoot(source);

    await expect(
      generateProviderActivationProfiles({ rootDirectory: root, check: false }),
    ).rejects.toThrowError(invalidSourceError);
  });
});
