import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CODEX_CLI_VERSION,
  resolveCodexCliInstallation,
} from "@recurs/runtimes";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];

async function fakeCodex(version: string): Promise<{
  readonly directory: string;
  readonly executable: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "recurs-codex-cli-"));
  directories.push(directory);
  const executable = path.join(directory, "codex");
  await writeFile(
    executable,
    `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  return { directory, executable };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("Codex CLI installation resolution", () => {
  it("uses an explicit exact-version executable ahead of bundled packages", async () => {
    const candidate = await fakeCodex(CODEX_CLI_VERSION);
    const installation = resolveCodexCliInstallation({
      RECURS_CODEX_PATH: candidate.executable,
    });
    const executable = await realpath(candidate.executable);

    expect(installation).toEqual({
      source: "external_path",
      codexVersion: CODEX_CLI_VERSION,
      codexExecutable: executable,
    });
    expect(Object.isFrozen(installation)).toBe(true);
  });

  it("discovers an exact-version executable on PATH when no bundle exists", async () => {
    const candidate = await fakeCodex(CODEX_CLI_VERSION);
    const installation = resolveCodexCliInstallation(
      { PATH: candidate.directory },
      { resolveBundled: () => null },
    );

    expect(installation.source).toBe("external_path");
    expect(installation.codexExecutable).toBe(
      await realpath(candidate.executable),
    );
  });

  it("rejects an explicit executable with an unreviewed version", async () => {
    const candidate = await fakeCodex("0.144.1");
    expect(() => resolveCodexCliInstallation({
      RECURS_CODEX_PATH: candidate.executable,
    })).toThrow(`RECURS_CODEX_PATH must point to Codex CLI ${CODEX_CLI_VERSION}`);
  });

  it("reports actionable setup when neither a bundle nor PATH is usable", () => {
    expect(() => resolveCodexCliInstallation(
      { PATH: "" },
      { resolveBundled: () => null },
    )).toThrow(
      `Codex CLI ${CODEX_CLI_VERSION} is required for ChatGPT subscription access`,
    );
  });
});
