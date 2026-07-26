import path from "node:path";

import { describe, expect, it } from "vitest";

import { darwinSandboxLaunch } from "../src/process.js";

const credentialPaths = [
  ["HOME_SSH", ".ssh", true],
  ["HOME_AWS", ".aws", true],
  ["HOME_AZURE", ".azure", true],
  ["HOME_DOCKER", ".docker", true],
  ["HOME_GNUPG", ".gnupg", true],
  ["HOME_KUBE", ".kube", true],
  ["HOME_PASSWORD_STORE", ".password-store", true],
  ["HOME_GCLOUD", path.join(".config", "gcloud"), true],
  ["HOME_GH", path.join(".config", "gh"), true],
  ["HOME_KEYRINGS", path.join(".local", "share", "keyrings"), true],
  ["HOME_KEYCHAINS", path.join("Library", "Keychains"), true],
  ["HOME_GIT_CREDENTIALS", ".git-credentials", false],
  ["HOME_NETRC", ".netrc", false],
  ["HOME_NPMRC", ".npmrc", false],
  ["HOME_PYPIRC", ".pypirc", false],
] as const;

describe("workspace process sandbox policy", () => {
  it("binds every canonical credential path into the Darwin read-denial profile", () => {
    const hostHome = path.join(path.parse(process.cwd()).root, "Users", "fixture");
    const launch = darwinSandboxLaunch(
      "/usr/bin/env",
      ["true"],
      { mode: "workspace", network: "deny" },
      {
        hostHome,
        workspaceRoot: path.join(hostHome, "project"),
        privateRoot: path.join(hostHome, "private"),
      },
    );
    const profile = launch.args[1];
    expect(profile).toBeDefined();
    const definitions = new Map<string, string>();
    for (let index = 2; launch.args[index] === "-D"; index += 2) {
      const definition = launch.args[index + 1];
      expect(definition).toBeDefined();
      const separator = definition!.indexOf("=");
      definitions.set(
        definition!.slice(0, separator),
        definition!.slice(separator + 1),
      );
    }

    expect([...definitions.keys()].sort()).toEqual([
      "PRIVATE_ROOT",
      "WORKSPACE",
      ...credentialPaths.map(([parameter]) => parameter),
    ].sort());
    for (const [parameter, relative, directory] of credentialPaths) {
      expect(definitions.get(parameter)).toBe(path.join(hostHome, relative));
      expect(profile).toContain(
        `(require-not (literal (param "${parameter}")))`,
      );
      expect(profile?.includes(
        `(require-not (subpath (param "${parameter}")))`,
      )).toBe(directory);
    }
  });
});
