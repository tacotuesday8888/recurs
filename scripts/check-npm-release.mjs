import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(root, "package.json");
const licensePath = path.join(root, "LICENSE");
const noticesPath = path.join(root, "THIRD_PARTY_NOTICES.md");

const EXPECTED_REPOSITORY = "git+https://github.com/tacotuesday8888/recurs.git";
const EXPECTED_GITHUB_REPOSITORY = "tacotuesday8888/recurs";
const EXPECTED_LICENSE = "Apache-2.0";
const EXPECTED_LICENSE_SHA256 =
  "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";
const EXPECTED_WORKFLOW_REF_PREFIX =
  "tacotuesday8888/recurs/.github/workflows/publish-npm.yml@";
const REQUIRED_PACKED_RELEASE_FILES = Object.freeze([
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
]);
const LOCKED_FAILURES = Object.freeze([
  "license_file_missing",
  "license_unselected",
  "package_private",
  "placeholder_version",
  "publish_config_missing",
  "release_license_not_packaged",
]);
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:(?:0|[1-9][0-9]*)|(?:[0-9]*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9][0-9]*)|(?:[0-9]*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function hasNonemptyText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasSubstantialLicenseText(value) {
  return typeof value === "string" && value.trim().length >= 100;
}

export function releaseMetadataFailures({
  packageJson,
  licenseText,
  noticesText,
}) {
  const failures = [];
  if (packageJson.name !== "recurs") failures.push("package_name_mismatch");
  if (packageJson.repository?.url !== EXPECTED_REPOSITORY) {
    failures.push("repository_mismatch");
  }
  if (!hasNonemptyText(packageJson.version) ||
      !SEMVER.test(packageJson.version)) {
    failures.push("invalid_version");
  } else if (packageJson.version === "0.0.0") {
    failures.push("placeholder_version");
  }
  if (packageJson.private === true) failures.push("package_private");
  const licenseSelected = hasNonemptyText(packageJson.license) &&
    packageJson.license !== "UNLICENSED";
  if (!licenseSelected) {
    failures.push("license_unselected");
  } else if (packageJson.license !== EXPECTED_LICENSE) {
    failures.push("license_identifier_mismatch");
  }
  if (licenseText === null || licenseText === undefined) {
    failures.push("license_file_missing");
  } else if (!hasSubstantialLicenseText(licenseText)) {
    failures.push("license_file_incomplete");
  } else if (
    packageJson.license === EXPECTED_LICENSE &&
    createHash("sha256").update(licenseText).digest("hex") !==
      EXPECTED_LICENSE_SHA256
  ) {
    failures.push("license_file_mismatch");
  }
  if (!hasNonemptyText(noticesText)) failures.push("notices_file_missing");

  const packedFiles = new Set(
    Array.isArray(packageJson.files) ? packageJson.files : [],
  );
  for (const file of REQUIRED_PACKED_RELEASE_FILES) {
    if (!packedFiles.has(file)) {
      failures.push(
        file === "LICENSE"
          ? "release_license_not_packaged"
          : "release_notices_not_packaged",
      );
    }
  }
  if (packageJson.publishConfig === undefined) {
    failures.push("publish_config_missing");
  } else {
    if (packageJson.publishConfig.access !== "public") {
      failures.push("publish_access_not_public");
    }
    if (packageJson.publishConfig.registry !== "https://registry.npmjs.org/") {
      failures.push("publish_registry_mismatch");
    }
    if (packageJson.publishConfig.provenance !== true) {
      failures.push("publish_provenance_missing");
    }
  }
  return Object.freeze([...new Set(failures)].sort());
}

export function publicationStateForFailures(failures) {
  if (failures.length === 0) return "ready";
  return JSON.stringify(failures) === JSON.stringify(LOCKED_FAILURES)
    ? "locked"
    : "invalid";
}

export function releaseContextFailures({ tag, version, environment }) {
  const failures = [];
  if (tag !== `v${version}`) failures.push("tag_version_mismatch");
  if (environment.GITHUB_ACTIONS !== "true") {
    failures.push("not_github_actions");
  }
  if (environment.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    failures.push("not_manual_dispatch");
  }
  if (environment.GITHUB_REF_TYPE !== "tag") {
    failures.push("not_tag_ref");
  }
  if (environment.GITHUB_REF_NAME !== tag) {
    failures.push("checked_out_tag_mismatch");
  }
  if (environment.GITHUB_REPOSITORY !== EXPECTED_GITHUB_REPOSITORY) {
    failures.push("github_repository_mismatch");
  }
  if (environment.RECURS_REPOSITORY_VISIBILITY !== "public") {
    failures.push("repository_not_public");
  }
  if (!environment.GITHUB_WORKFLOW_REF?.startsWith(
    EXPECTED_WORKFLOW_REF_PREFIX,
  )) {
    failures.push("workflow_identity_mismatch");
  }
  if (environment.NODE_AUTH_TOKEN !== undefined) {
    failures.push("long_lived_token_present");
  }
  if (environment.NPM_CONFIG_PROVENANCE === "false") {
    failures.push("provenance_disabled");
  }
  return Object.freeze([...new Set(failures)].sort());
}

async function optionalText(filename) {
  try {
    return await readFile(filename, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseMode(argv) {
  if (argv.length === 1 && argv[0] === "--check-state") {
    return { kind: "check_state" };
  }
  if (argv.length === 1 && argv[0] === "--expect-blocked") {
    return { kind: "expect_blocked" };
  }
  if (argv.length === 2 && argv[0] === "--tag" && argv[1] !== undefined) {
    return { kind: "release", tag: argv[1] };
  }
  throw new Error(
    "Usage: check-npm-release.mjs --check-state | --expect-blocked | --tag <vVERSION>",
  );
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const failures = releaseMetadataFailures({
    packageJson,
    licenseText: await optionalText(licensePath),
    noticesText: await optionalText(noticesPath),
  });

  if (mode.kind === "check_state") {
    const state = publicationStateForFailures(failures);
    assert(
      state !== "invalid",
      `The publication gate is partially configured: ${failures.join(", ")}`,
    );
    process.stdout.write(
      state === "ready"
        ? "npm release metadata is ready for an authorized tagged workflow\n"
        : `npm publication remains deliberately blocked: ${failures.join(", ")}\n`,
    );
    return;
  }

  if (mode.kind === "expect_blocked") {
    assert(
      JSON.stringify(failures) === JSON.stringify(LOCKED_FAILURES),
      `The publication gate changed unexpectedly: ${JSON.stringify(failures)}`,
    );
    process.stdout.write(
      `npm publication remains deliberately blocked: ${failures.join(", ")}\n`,
    );
    return;
  }

  assert(
    failures.length === 0,
    `Release metadata is not ready: ${failures.join(", ")}`,
  );
  const contextFailures = releaseContextFailures({
    tag: mode.tag,
    version: packageJson.version,
    environment: process.env,
  });
  assert(
    contextFailures.length === 0,
    `Release authority is not valid: ${contextFailures.join(", ")}`,
  );
  process.stdout.write(`npm release preflight passed for ${mode.tag}\n`);
}

const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
