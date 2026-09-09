import path from "node:path";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { darwinSandboxLaunch, linuxSandboxArguments } from "../src/process.js";

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
  it("exposes an exact temporary hook executable while keeping neighboring files hidden and credentials masked last", async () => {
    const temporary = await mkdtemp("/tmp/recurs-linux-hook-policy-");
    try {
      const root = await realpath(temporary);
      const workspaceRoot = path.join(root, "workspace");
      const privateRoot = path.join(root, "private");
      const hostHome = path.join(root, "home");
      const auth = path.join(root, "auth");
      await Promise.all([workspaceRoot, privateRoot, hostHome, auth].map((directory) => mkdir(directory, { mode: 0o700 })));
      const command = path.join(root, "hook");
      const credential = path.join(auth, "credentials");
      await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await writeFile(credential, "TEST_ONLY_CANARY", { mode: 0o600 });
      const args = linuxSandboxArguments(command, [], {
        mode: "workspace", network: "deny", readOnlyFiles: [command, credential], deniedReadPaths: [auth],
      }, { workspaceRoot, privateRoot, hostHome });
      const operations = args.join("\n");
      const temporaryRoot = await realpath("/tmp");
      const placeholder = operations.indexOf(`--ro-bind\n/dev/null\n${command}`);
      const hideReadOnly = operations.indexOf(`--remount-ro\n${temporaryRoot}\n`);
      const expose = operations.indexOf(`--ro-bind\n${command}\n${command}`);
      const mask = operations.lastIndexOf(`--tmpfs\n${auth}\n--remount-ro\n${auth}`);
      expect(placeholder).toBeGreaterThan(-1);
      expect(hideReadOnly).toBeGreaterThan(placeholder);
      expect(expose).toBeGreaterThan(hideReadOnly);
      expect(mask).toBeGreaterThan(operations.indexOf(`--ro-bind\n${credential}\n${credential}`));
      expect(operations).not.toContain(`--ro-bind\n${root}\n${root}`);
      expect(operations).not.toContain(`--ro-bind\n${temporaryRoot}\n${temporaryRoot}`);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });

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
