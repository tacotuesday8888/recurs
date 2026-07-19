import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(root, "package.json");
const bundlePath = path.join(root, "dist/cli/main.js");
const expectedDependencies = Object.freeze({
  "@agentclientprotocol/codex-acp": "1.1.2",
  "@agentclientprotocol/sdk": "1.2.1",
  "@openai/codex": "0.144.0",
  yaml: "2.9.0",
  zod: "4.4.3",
});
const expectedFiles = [
  "README.md",
  "SECURITY.md",
  "dist/cli/main.js",
  "package.json",
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
assert(packageJson.name === "recurs", "The release package name must be recurs.");
assert(packageJson.private === true, "Publishing must remain blocked until licensing is complete.");
assert(packageJson.license === "UNLICENSED", "The package must truthfully declare its current license state.");
assert(packageJson.bin?.recurs === "dist/cli/main.js", "The package binary must target the bundled CLI.");
assert(
  JSON.stringify(packageJson.dependencies) === JSON.stringify(expectedDependencies),
  "Runtime dependencies must remain exact and reviewed.",
);

const bundle = await readFile(bundlePath, "utf8");
const bundleStat = await stat(bundlePath);
assert(bundle.startsWith("#!/usr/bin/env node\n"), "The bundled CLI must retain its Node shebang.");
assert((bundleStat.mode & 0o111) !== 0, "The bundled CLI must be executable.");
assert(!bundle.includes("@recurs/"), "The bundled CLI must not depend on private workspace packages.");
assert(!bundle.includes(root), "The bundled CLI must not embed the build-machine path.");
assert(bundleStat.size < 2_000_000, "The unpacked CLI bundle unexpectedly exceeds 2 MB.");

const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "recurs-pack-check-"));
try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const { stdout } = await execFileAsync(npm, [
    "pack",
    "--dry-run",
    "--json",
    "--ignore-scripts",
    "--cache",
    path.join(temporaryDirectory, "cache"),
  ], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const report = JSON.parse(stdout);
  assert(Array.isArray(report) && report.length === 1, "npm pack must return one package report.");
  const packedFiles = report[0]?.files?.map((file) => file.path).sort();
  assert(
    JSON.stringify(packedFiles) === JSON.stringify(expectedFiles),
    `Unexpected npm package contents: ${JSON.stringify(packedFiles)}`,
  );
  assert(report[0]?.unpackedSize < 2_100_000, "The npm package unexpectedly exceeds its unpacked size budget.");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

process.stdout.write("npm package check passed\n");
