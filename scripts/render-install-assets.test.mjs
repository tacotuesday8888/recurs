import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { promisify } from "node:util";

import test from "node:test";
import assert from "node:assert/strict";

import {
  archiveIntegrity,
  renderChecksums,
  renderHomebrewFormula,
  renderInstaller,
  verifyPublishedIntegrity,
} from "./render-install-assets.mjs";

const execFileAsync = promisify(execFile);
const fixture = Object.freeze({
  version: "1.2.3",
  tag: "v1.2.3",
  sha256: "a".repeat(64),
  license: "Apache-2.0",
});

test("renders one exact checksummed npm artifact for curl and Homebrew", () => {
  const installer = renderInstaller(fixture);
  const formula = renderHomebrewFormula(fixture);

  assert.match(installer, /^#!\/bin\/sh\nset -eu\n/u);
  assert.match(installer, /releases\/download\/v1\.2\.3\/recurs-1\.2\.3\.tgz/u);
  assert.match(installer, /archive checksum mismatch/u);
  assert.match(installer, /npm install --global --ignore-scripts/u);
  assert.match(installer, /RECURS_INSTALL_PREFIX/u);
  assert.match(installer, /trap 'exit 1' HUP INT TERM/u);
  assert.doesNotMatch(installer, /sudo/u);
  assert.match(formula, /url "https:\/\/registry\.npmjs\.org\/recurs\/-\/recurs-1\.2\.3\.tgz"/u);
  assert.match(formula, /depends_on "node"/u);
  assert.match(formula, /system "npm", "install", \*std_npm_args/u);
  assert.match(formula, /bin\.install_symlink libexec\.glob\("bin\/\*"\)/u);
  assert.equal(renderChecksums(fixture), `${"a".repeat(64)}  recurs-1.2.3.tgz\n`);
});

test("rejects placeholder, mismatched, unsafe, and malformed release inputs", () => {
  for (const input of [
    { ...fixture, version: "0.0.0", tag: "v0.0.0" },
    { ...fixture, tag: "v1.2.4" },
    { ...fixture, sha256: "A".repeat(64) },
    { ...fixture, license: 'MIT"\n  system "bad"' },
  ]) {
    assert.throws(() => renderInstaller(input));
    assert.throws(() => renderHomebrewFormula(input));
  }
});

test("verifies exact npm SRI integrity", () => {
  const archive = Buffer.from("release archive", "utf8");
  const integrity = archiveIntegrity(archive);
  assert.equal(
    integrity,
    `sha512-${createHash("sha512").update(archive).digest("base64")}`,
  );
  assert.doesNotThrow(() => verifyPublishedIntegrity(archive, integrity));
  assert.throws(
    () => verifyPublishedIntegrity(archive, `sha512-${Buffer.alloc(64).toString("base64")}`),
    /does not match/u,
  );
});

test("release workflow drafts and attests assets before publishing", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/publish-npm.yml", import.meta.url),
    "utf8",
  );
  const preflight = workflow.indexOf("Verify release authority and metadata");
  const build = workflow.indexOf("Build the exact release package and install assets");
  const draft = workflow.indexOf("Create or refresh the draft GitHub release");
  const attest = workflow.indexOf("Attest the exact release assets");
  const publish = workflow.indexOf("Publish or verify the exact npm package");
  const release = workflow.indexOf("Publish the verified GitHub release");

  assert.ok(preflight >= 0 && preflight < build);
  assert.ok(build < draft && draft < attest && attest < publish && publish < release);
  assert.match(workflow, /attestations: write/u);
  assert.match(workflow, /--verify-published-integrity/u);
  assert.match(workflow, /--draft=false --latest/u);
});

test("installer verifies the archive and uses a user-owned npm prefix", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "recurs-installer-test-"));
  try {
    const bin = path.join(root, "bin");
    const home = path.join(root, "home");
    const prefix = path.join(root, "prefix");
    const archive = path.join(root, "recurs-1.2.3.tgz");
    const npmLog = path.join(root, "npm.json");
    const installerPath = path.join(root, "install.sh");
    await Promise.all([mkdir(bin), mkdir(home), writeFile(archive, "archive bytes")]);
    const bytes = await readFile(archive);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(installerPath, renderInstaller({ ...fixture, sha256 }), { mode: 0o755 });
    await writeFile(path.join(bin, "curl"), `#!/usr/bin/env node
import { copyFileSync } from "node:fs";
const output = process.argv[process.argv.indexOf("--output") + 1];
copyFileSync(process.env.RECURS_TEST_ARCHIVE, output);
`, { mode: 0o755 });
    await writeFile(path.join(bin, "npm"), `#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const prefix = process.argv[process.argv.indexOf("--prefix") + 1];
writeFileSync(process.env.RECURS_TEST_NPM_LOG, JSON.stringify(process.argv.slice(2)));
mkdirSync(path.join(prefix, "bin"), { recursive: true });
const executable = path.join(prefix, "bin", "recurs");
writeFileSync(executable, "#!/bin/sh\\nprintf 'Recurs coding-agent harness\\n'\\n");
chmodSync(executable, 0o755);
`, { mode: 0o755 });
    await Promise.all([chmod(path.join(bin, "curl"), 0o755), chmod(path.join(bin, "npm"), 0o755)]);

    const environment = {
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      RECURS_INSTALL_PREFIX: prefix,
      RECURS_TEST_ARCHIVE: archive,
      RECURS_TEST_NPM_LOG: npmLog,
    };
    const { stdout, stderr } = await execFileAsync("/bin/sh", [installerPath], {
      cwd: root,
      encoding: "utf8",
      env: environment,
    });

    assert.match(stdout, /Recurs 1\.2\.3 installed/u);
    assert.equal(stderr, "");
    const npmArguments = JSON.parse(await readFile(npmLog, "utf8"));
    assert.deepEqual(npmArguments.slice(0, 7), [
      "install",
      "--global",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      prefix,
    ]);
    assert.equal(path.basename(npmArguments[7]), "recurs-1.2.3.tgz");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer refuses a checksum mismatch before npm runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "recurs-installer-hash-test-"));
  try {
    const bin = path.join(root, "bin");
    const home = path.join(root, "home");
    const archive = path.join(root, "recurs-1.2.3.tgz");
    const npmLog = path.join(root, "npm-ran");
    const installerPath = path.join(root, "install.sh");
    await Promise.all([mkdir(bin), mkdir(home), writeFile(archive, "tampered")]);
    await writeFile(installerPath, renderInstaller(fixture), { mode: 0o755 });
    await writeFile(path.join(bin, "curl"), `#!/usr/bin/env node
import { copyFileSync } from "node:fs";
copyFileSync(process.env.RECURS_TEST_ARCHIVE, process.argv[process.argv.indexOf("--output") + 1]);
`, { mode: 0o755 });
    await writeFile(path.join(bin, "npm"), `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.RECURS_TEST_NPM_LOG, "ran");
`, { mode: 0o755 });
    await Promise.all([chmod(path.join(bin, "curl"), 0o755), chmod(path.join(bin, "npm"), 0o755)]);

    await assert.rejects(
      execFileAsync("/bin/sh", [installerPath], {
        cwd: root,
        encoding: "utf8",
        env: {
          HOME: home,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RECURS_TEST_ARCHIVE: archive,
          RECURS_TEST_NPM_LOG: npmLog,
        },
      }),
      (error) => error?.stderr.includes("archive checksum mismatch") === true,
    );
    await assert.rejects(readFile(npmLog), (error) => error?.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
