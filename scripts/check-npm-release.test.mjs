import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { URL } from "node:url";

import {
  publicationStateForFailures,
  releaseContextFailures,
  releaseMetadataFailures,
} from "./check-npm-release.mjs";

const apacheLicenseText = await readFile(
  new URL("../LICENSE", import.meta.url),
  "utf8",
);

const basePackage = Object.freeze({
  name: "recurs",
  version: "0.1.0-alpha.1",
  repository: {
    type: "git",
    url: "git+https://github.com/tacotuesday8888/recurs.git",
  },
  license: "Apache-2.0",
  files: ["LICENSE", "THIRD_PARTY_NOTICES.md"],
  publishConfig: {
    access: "public",
    registry: "https://registry.npmjs.org/",
    provenance: true,
  },
});

test("accepts one exact public release metadata shape", () => {
  assert.deepEqual(releaseMetadataFailures({
    packageJson: basePackage,
    licenseText: apacheLicenseText,
    noticesText: "reviewed third-party notices",
  }), []);
});

test("rejects a placeholder project license", () => {
  const failures = releaseMetadataFailures({
    packageJson: basePackage,
    licenseText: "TODO",
    noticesText: "reviewed third-party notices",
  });
  assert.deepEqual(failures, ["license_file_incomplete"]);
  assert.equal(publicationStateForFailures(failures), "invalid");
});

test("pins the selected SPDX identifier to the official Apache-2.0 text", () => {
  assert.deepEqual(releaseMetadataFailures({
    packageJson: { ...basePackage, license: "MIT" },
    licenseText: apacheLicenseText,
    noticesText: "reviewed third-party notices",
  }), ["license_identifier_mismatch"]);
  assert.deepEqual(releaseMetadataFailures({
    packageJson: basePackage,
    licenseText: apacheLicenseText.replace("January 2004", "February 2004"),
    noticesText: "reviewed third-party notices",
  }), ["license_file_mismatch"]);
});

test("reports the deliberate unpublished repository gates", () => {
  const failures = releaseMetadataFailures({
    packageJson: {
      ...basePackage,
      version: "0.0.0",
      private: true,
      license: "UNLICENSED",
      files: ["THIRD_PARTY_NOTICES.md"],
      publishConfig: undefined,
    },
    licenseText: null,
    noticesText: "reviewed third-party notices",
  });
  assert.deepEqual(failures, [
    "license_file_missing",
    "license_unselected",
    "package_private",
    "placeholder_version",
    "publish_config_missing",
    "release_license_not_packaged",
  ]);
  assert.equal(publicationStateForFailures(failures), "locked");
  assert.equal(publicationStateForFailures([]), "ready");
  assert.equal(
    publicationStateForFailures(["license_unselected"]),
    "invalid",
  );
});

test("fails closed for a wrong package, repository, version, or registry", () => {
  assert.deepEqual(releaseMetadataFailures({
    packageJson: {
      ...basePackage,
      name: "recurs-cli-copy",
      version: "01.2.3",
      repository: { url: "https://example.invalid/repo" },
      publishConfig: {
        access: "restricted",
        registry: "https://registry.example.invalid/",
        provenance: false,
      },
    },
    licenseText: apacheLicenseText,
    noticesText: "reviewed third-party notices",
  }), [
    "invalid_version",
    "package_name_mismatch",
    "publish_access_not_public",
    "publish_provenance_missing",
    "publish_registry_mismatch",
    "repository_mismatch",
  ]);
});

test("accepts only the exact manual trusted-publisher context", () => {
  const environment = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF_TYPE: "tag",
    GITHUB_REF_NAME: "v0.1.0-alpha.1",
    GITHUB_REPOSITORY: "tacotuesday8888/recurs",
    RECURS_REPOSITORY_VISIBILITY: "public",
    GITHUB_WORKFLOW_REF:
      "tacotuesday8888/recurs/.github/workflows/publish-npm.yml@refs/tags/v0.1.0-alpha.1",
  };
  assert.deepEqual(releaseContextFailures({
    tag: "v0.1.0-alpha.1",
    version: "0.1.0-alpha.1",
    environment,
  }), []);

  assert.deepEqual(releaseContextFailures({
    tag: "v9.9.9",
    version: "0.1.0-alpha.1",
    environment: {
      ...environment,
      GITHUB_ACTIONS: "false",
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF_TYPE: "branch",
      GITHUB_REF_NAME: "main",
      GITHUB_REPOSITORY: "someone/fork",
      RECURS_REPOSITORY_VISIBILITY: "private",
      GITHUB_WORKFLOW_REF: "someone/fork/.github/workflows/publish-npm.yml@main",
      NODE_AUTH_TOKEN: "present",
      NPM_CONFIG_PROVENANCE: "false",
    },
  }), [
    "checked_out_tag_mismatch",
    "github_repository_mismatch",
    "long_lived_token_present",
    "not_github_actions",
    "not_manual_dispatch",
    "not_tag_ref",
    "provenance_disabled",
    "repository_not_public",
    "tag_version_mismatch",
    "workflow_identity_mismatch",
  ]);
});
