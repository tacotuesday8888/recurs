import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);

async function text(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("current release documents match the package version", async () => {
  const documents = await Promise.all([
    "CHANGELOG.md",
    "docs/CLI.md",
    "docs/FEATURE_STATUS.md",
    "docs/PUBLIC_ALPHA.md",
    "docs/README.md",
  ].map(text));
  const version = new RegExp(
    packageJson.version.replaceAll(".", "\\."),
    "u",
  );

  for (const document of documents) assert.match(document, version);
});

test("current support surfaces do not regress to pre-publication claims", async () => {
  const [cli, support, security, privacy, packageText] = await Promise.all([
    text("docs/CLI.md"),
    text("SUPPORT.md"),
    text("SECURITY.md"),
    text("PRIVACY.md"),
    text("package.json"),
  ]);

  assert.doesNotMatch(cli, /source-only alpha/u);
  assert.doesNotMatch(support, /cannot be obtained from the registry/u);
  assert.doesNotMatch(security, /0\.1\.0-alpha\.2/u);
  assert.doesNotMatch(security, /owner-controlled and unpublished/u);
  assert.match(cli, /recurs data path/u);
  assert.match(privacy, /does not operate an analytics or telemetry service/u);
  assert.ok(JSON.parse(packageText).files.includes("PRIVACY.md"));
});
