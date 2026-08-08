import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  GITHUB_COPILOT_SDK_VERSION,
  githubCopilotSdkAddonPrefix,
  githubCopilotSdkInstallArguments,
  resolveGitHubCopilotSdk,
} from "@recurs/runtimes";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

async function fixturePackage(
  dataDirectory: string,
  version = GITHUB_COPILOT_SDK_VERSION,
  source = "export class CopilotClient {}\n",
) {
  const root = path.join(
    githubCopilotSdkAddonPrefix(dataDirectory),
    "node_modules",
    "@github",
    "copilot-sdk",
  );
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "@github/copilot-sdk",
    version,
    type: "module",
    exports: "./index.js",
  }));
  await writeFile(path.join(root, "index.js"), source);
  const executable = path.join(
    githubCopilotSdkAddonPrefix(dataDirectory),
    "node_modules",
    ".bin",
    "copilot",
  );
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(executable, 0o700);
  return root;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("GitHub Copilot SDK optional installation", () => {
  it("returns a typed nonfatal absence with the exact fixed-prefix npm argv", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "recurs-copilot-addon-"));
    directories.push(dataDirectory);
    const result = await resolveGitHubCopilotSdk({
      dataDirectory,
      resolvePeer: () => { throw Object.assign(new Error("missing"), { code: "MODULE_NOT_FOUND" }); },
    });

    expect(result).toEqual({
      status: "unavailable",
      addonPrefix: githubCopilotSdkAddonPrefix(dataDirectory),
      installArguments: githubCopilotSdkInstallArguments(dataDirectory),
    });
  });

  it("loads only the reviewed package from the deterministic add-on prefix", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "recurs-copilot-addon-"));
    directories.push(dataDirectory);
    await fixturePackage(dataDirectory);
    const result = await resolveGitHubCopilotSdk({
      dataDirectory,
      resolvePeer: () => { throw Object.assign(new Error("missing"), { code: "MODULE_NOT_FOUND" }); },
    });

    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.source).toBe("recurs_addon");
      expect(typeof result.module.CopilotClient).toBe("function");
      expect(result.loginCommand).toEqual({
        command: await realpath(path.join(
          githubCopilotSdkAddonPrefix(dataDirectory),
          "node_modules",
          ".bin",
          "copilot",
        )),
        arguments: [],
        environment: {
          COPILOT_DISABLE_KEYTAR: "1",
          COPILOT_HOME: path.join(dataDirectory, "runtimes", "github-copilot-home"),
        },
        thenEnter: "/login",
      });
    }
  });

  it("keeps default peer resolution nonfatal when the opt-in SDK is absent", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "recurs-copilot-peer-absent-"));
    directories.push(dataDirectory);
    const result = await resolveGitHubCopilotSdk({ dataDirectory });
    expect(result).toMatchObject({ status: "unavailable" });
  });

  it("rejects wrong versions and package symlinks that escape the add-on prefix", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "recurs-copilot-addon-"));
    const outside = await mkdtemp(path.join(tmpdir(), "recurs-copilot-outside-"));
    directories.push(dataDirectory, outside);
    await fixturePackage(outside);
    const packageParent = path.join(
      githubCopilotSdkAddonPrefix(dataDirectory),
      "node_modules",
      "@github",
    );
    await mkdir(packageParent, { recursive: true });
    await symlink(
      path.join(githubCopilotSdkAddonPrefix(outside), "node_modules", "@github", "copilot-sdk"),
      path.join(packageParent, "copilot-sdk"),
      "dir",
    );

    await expect(resolveGitHubCopilotSdk({
      dataDirectory,
      resolvePeer: () => { throw Object.assign(new Error("missing"), { code: "MODULE_NOT_FOUND" }); },
    })).rejects.toMatchObject({ code: "invalid_response" });

    await rm(path.join(packageParent, "copilot-sdk"), { force: true });
    await fixturePackage(dataDirectory, "1.0.7");
    await expect(resolveGitHubCopilotSdk({
      dataDirectory,
      resolvePeer: () => { throw Object.assign(new Error("missing"), { code: "MODULE_NOT_FOUND" }); },
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("fails closed for a wrong-version or broken present peer", async () => {
    for (const fixture of [
      { version: "1.0.7", source: "export class CopilotClient {}\n" },
      { version: GITHUB_COPILOT_SDK_VERSION, source: "import './missing.js'; export class CopilotClient {}\n" },
    ]) {
      const dataDirectory = await mkdtemp(path.join(tmpdir(), "recurs-copilot-peer-"));
      directories.push(dataDirectory);
      const root = await fixturePackage(dataDirectory, fixture.version, fixture.source);
      await expect(resolveGitHubCopilotSdk({
        dataDirectory: path.join(dataDirectory, "empty-data"),
        resolvePeer: () => ({
          entry: path.join(root, "index.js"),
          packageJson: path.join(root, "package.json"),
        }),
      })).rejects.toMatchObject({ code: "invalid_response" });
    }
  });
});
