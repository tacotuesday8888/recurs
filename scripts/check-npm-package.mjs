import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  publicationStateForFailures,
  releaseMetadataFailures,
} from "./check-npm-release.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(root, "package.json");
const bundlePath = path.join(root, "dist/cli/main.js");
const licensePath = path.join(root, "LICENSE");
const noticesPath = path.join(root, "THIRD_PARTY_NOTICES.md");
const expectedDependencies = Object.freeze({
  "@agentclientprotocol/codex-acp": "1.1.2",
  "@agentclientprotocol/sdk": "1.2.1",
  "@openai/codex": "0.144.0",
  typescript: "6.0.3",
  ws: "8.21.1",
  yaml: "2.9.0",
  zod: "4.4.3",
});
const expectedOptionalDependencies = Object.freeze({
  "@lydell/node-pty": "1.1.0",
});
const expectedNoticeRows = Object.freeze([
  "| `@agentclientprotocol/codex-acp` | 1.1.2 | Apache-2.0 |",
  "| `@agentclientprotocol/sdk` | 1.2.1 | Apache-2.0 |",
  "| `@lydell/node-pty` | 1.1.0 | MIT |",
  "| `@openai/codex` | 0.144.0 | Apache-2.0 |",
  "| `typescript` | 6.0.3 | Apache-2.0 |",
  "| `ws` | 8.21.1 | MIT |",
  "| `yaml` | 2.9.0 | ISC |",
  "| `zod` | 4.4.3 | MIT |",
]);
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const licenseText = await readFile(licensePath, "utf8").catch((error) => {
  if (error?.code === "ENOENT") return null;
  throw error;
});
const notices = await readFile(noticesPath, "utf8");
const publicationState = publicationStateForFailures(
  releaseMetadataFailures({ packageJson, licenseText, noticesText: notices }),
);
assert(
  publicationState !== "invalid",
  "The package publication metadata is partially configured.",
);
const expectedFiles = [
  ...(publicationState === "ready" ? ["LICENSE"] : []),
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "dist/cli/main.js",
  "package.json",
];

assert(packageJson.name === "recurs", "The release package name must be recurs.");
if (publicationState === "locked") {
  assert(packageJson.private === true, "The unpublished package must remain private.");
  assert(
    packageJson.license === "UNLICENSED",
    "The unpublished package must truthfully declare its license state.",
  );
} else {
  assert(packageJson.private !== true, "A release-ready package cannot be private.");
  assert(licenseText !== null, "A release-ready package must include its license.");
}
assert(
  packageJson.files?.includes("THIRD_PARTY_NOTICES.md"),
  "The package must include its reviewed third-party notices.",
);
assert(packageJson.bin?.recurs === "dist/cli/main.js", "The package binary must target the bundled CLI.");
assert(
  JSON.stringify(packageJson.dependencies) === JSON.stringify(expectedDependencies),
  "Runtime dependencies must remain exact and reviewed.",
);
assert(
  JSON.stringify(packageJson.optionalDependencies) ===
    JSON.stringify(expectedOptionalDependencies),
  "Optional runtime dependencies must remain exact and reviewed.",
);
for (const row of expectedNoticeRows) {
  assert(
    notices.includes(row),
    `The third-party notice is missing an exact runtime dependency row: ${row}`,
  );
}

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
