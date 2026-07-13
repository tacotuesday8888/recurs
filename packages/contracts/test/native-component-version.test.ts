import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NATIVE_COMPONENT_VERSION } from "../src/index.js";
import { generateNativeComponentVersion } from "../../../scripts/generate-native-component-version.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];
const fixtureVersion = "0.1.0";

function fixturePlist(version: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>CFBundleShortVersionString</key>",
    `\t<string>${version}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "recurs-component-version-"));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, "native"), { recursive: true });
  await writeFile(
    path.join(root, "native/component-version.json"),
    `{\n  "schemaVersion": 1,\n  "version": "${fixtureVersion}"\n}\n`,
    "utf8",
  );
  const resources = path.join(root, "native/macos/Resources");
  await mkdir(resources, { recursive: true });
  await Promise.all(
    ["RecursBroker-Info.plist", "RecursLauncher-Info.plist"].map(
      async (name) => writeFile(
        path.join(resources, name),
        fixturePlist("9.9.9"),
        "utf8",
      ),
    ),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("native component version generation", () => {
  it("exports the exact canonical source version to TypeScript and Swift", async () => {
    const sourceText = await readFile(
      path.join(repositoryRoot, "native/component-version.json"),
      "utf8",
    );
    const source = JSON.parse(sourceText) as {
      schemaVersion: number;
      version: string;
    };
    const canonicalSource = `${JSON.stringify(source, null, 2)}\n`;
    const swift = await readFile(
      path.join(
        repositoryRoot,
        "native/macos/Sources/RecursNativeProtocol/GeneratedNativeComponentVersion.swift",
      ),
      "utf8",
    );

    expect(sourceText).toBe(canonicalSource);
    expect(Object.keys(source).sort()).toEqual(["schemaVersion", "version"]);
    expect(source.schemaVersion).toBe(1);
    expect(source.version).toMatch(
      /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u,
    );
    expect(NATIVE_COMPONENT_VERSION).toBe(source.version);
    expect(swift).toContain(
      `public static let current = ${JSON.stringify(source.version)}`,
    );

    for (const executable of [
      "RecursNativeBrokerExecutable/main.swift",
      "RecursNativeLauncherExecutable/main.swift",
    ]) {
      const main = await readFile(
        path.join(repositoryRoot, "native/macos/Sources", executable),
        "utf8",
      );
      expect(main).toContain("NativeComponentVersion.current");
      expect(main).not.toContain(JSON.stringify(source.version));
    }

    for (const plist of [
      "RecursBroker-Info.plist",
      "RecursLauncher-Info.plist",
    ]) {
      const contents = await readFile(
        path.join(repositoryRoot, "native/macos/Resources", plist),
        "utf8",
      );
      expect(contents).toContain(
        `<key>CFBundleShortVersionString</key>\n\t<string>${source.version}</string>`,
      );
    }
  });

  it("reports missing or drifted outputs in check mode without writing", async () => {
    const root = await temporaryRoot();
    expect(
      await generateNativeComponentVersion({ rootDirectory: root, check: true }),
    ).toBe(false);

    expect(
      await generateNativeComponentVersion({ rootDirectory: root, check: false }),
    ).toBe(true);
    const typescriptPath = path.join(
      root,
      "packages/contracts/src/native-component-version.ts",
    );
    await writeFile(typescriptPath, "drift\n", "utf8");

    const launcherPlist = path.join(
      root,
      "native/macos/Resources/RecursLauncher-Info.plist",
    );
    expect(await readFile(launcherPlist, "utf8")).toBe(
      fixturePlist(fixtureVersion),
    );

    expect(
      await generateNativeComponentVersion({ rootDirectory: root, check: true }),
    ).toBe(false);
    expect(await readFile(typescriptPath, "utf8")).toBe("drift\n");

    await rm(typescriptPath);
    expect(
      await generateNativeComponentVersion({ rootDirectory: root, check: true }),
    ).toBe(false);
    await expect(access(typescriptPath)).rejects.toThrow();

    await generateNativeComponentVersion({ rootDirectory: root, check: false });
    await writeFile(launcherPlist, fixturePlist("8.8.8"), "utf8");
    expect(
      await generateNativeComponentVersion({ rootDirectory: root, check: true }),
    ).toBe(false);
  });

  it("rejects non-canonical sources with one fixed non-disclosing error", async () => {
    const root = await temporaryRoot();
    await writeFile(
      path.join(root, "native/component-version.json"),
      '{"schemaVersion":1,"version":"01.2.3","private":"do-not-disclose"}',
      "utf8",
    );

    await expect(
      generateNativeComponentVersion({ rootDirectory: root, check: false }),
    ).rejects.toThrowError(new Error("Invalid native component version source"));

    await writeFile(
      path.join(root, "native/component-version.json"),
      '{\n  "schemaVersion": 1,\n  "version": "1.2.3-beta.1+4"\n}\n',
      "utf8",
    );
    await expect(
      generateNativeComponentVersion({ rootDirectory: root, check: false }),
    ).rejects.toThrowError(new Error("Invalid native component version source"));
  });
});
