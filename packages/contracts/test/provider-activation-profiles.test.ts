import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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
const outputRelativePath =
  "packages/contracts/src/provider-activation-profiles.ts";
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

async function temporaryRoot(source: string | null = canonicalSource) {
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
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    ),
  );
});

describe("provider activation profile generation", () => {
  it("exports the canonical frozen identity catalog", async () => {
    expect(
      await readFile(path.join(repositoryRoot, sourceRelativePath), "utf8"),
    ).toBe(canonicalSource);
    expect(PROVIDER_ACTIVATION_PROFILES).toEqual([
      { id: "anthropic_api_v1", bundledProviderId: "anthropic-api" },
      { id: "custom_openai_compatible_v1", bundledProviderId: null },
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
  });

  it("generates deterministic TypeScript and checks without writing", async () => {
    const root = await temporaryRoot();
    const outputPath = path.join(root, outputRelativePath);

    expect(
      await generateProviderActivationProfiles({ rootDirectory: root, check: true }),
    ).toBe(false);
    await generateProviderActivationProfiles({ rootDirectory: root, check: false });
    const generated = await readFile(outputPath, "utf8");
    await generateProviderActivationProfiles({ rootDirectory: root, check: false });
    expect(await readFile(outputPath, "utf8")).toBe(generated);

    await writeFile(outputPath, "drift\n", "utf8");
    expect(
      await generateProviderActivationProfiles({ rootDirectory: root, check: true }),
    ).toBe(false);
    expect(await readFile(outputPath, "utf8")).toBe("drift\n");
  });

  it("preserves the prior output when replacement fails", async () => {
    const root = await temporaryRoot();
    const outputPath = path.join(root, outputRelativePath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, "prior output\n", "utf8");

    const renameFile = async (source: string, destination: string) => {
      if (source.endsWith(".tmp")) throw new Error("injected failure");
      await rename(source, destination);
    };
    await expect(
      generateProviderActivationProfiles(
        { rootDirectory: root, check: false },
        { renameFile },
      ),
    ).rejects.toThrowError(
      new Error("Provider activation profile generation failed"),
    );
    expect(await readFile(outputPath, "utf8")).toBe("prior output\n");
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
    [
      "65-byte profile id",
      `${JSON.stringify({
        schemaVersion: 1,
        profiles: [
          { id: `${"a".repeat(62)}_v1`, bundledProviderId: null },
        ],
      }, null, 2)}\n`,
    ],
  ])("rejects %s input with one fixed error", async (_label, source) => {
    const root = await temporaryRoot(source);
    await expect(
      generateProviderActivationProfiles({ rootDirectory: root, check: false }),
    ).rejects.toThrowError(invalidSourceError);
  });
});
