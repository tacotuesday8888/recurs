import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowDirectory = path.join(root, ".github/workflows");
const dependabotPath = path.join(root, ".github/dependabot.yml");
const packagePath = path.join(root, "package.json");

const workflowNames = (await readdir(workflowDirectory))
  .filter((name) => /\.ya?ml$/u.test(name))
  .sort();
const [workflowEntries, dependabotText, packageText] = await Promise.all([
  Promise.all(workflowNames.map(async (name) => [
    name,
    await readFile(path.join(workflowDirectory, name), "utf8"),
  ])),
  readFile(dependabotPath, "utf8"),
  readFile(packagePath, "utf8"),
]);
const workflows = new Map(workflowEntries);
const ciText = workflows.get("ci.yml");
const releaseText = workflows.get("publish-npm.yml");
assert.equal(typeof ciText, "string", "The CI workflow is missing.");
assert.equal(typeof releaseText, "string", "The release workflow is missing.");
const ci = parse(ciText);
const dependabot = parse(dependabotText);
const packageJson = JSON.parse(packageText);

function actionStep(job, action) {
  return job.steps.find(
    (step) => typeof step.uses === "string" && step.uses.startsWith(`${action}@`),
  );
}

function commands(job) {
  return job.steps
    .map((step) => step.run)
    .filter((command) => typeof command === "string");
}

test("the complete Linux gate runs on the exact declared minimum Node version", () => {
  const match = /^>=(\d+\.\d+\.\d+)$/u.exec(packageJson.engines?.node);
  assert.ok(match, "The Node engine must declare one exact supported floor.");
  const minimumNode = match[1];
  const verify = ci.jobs?.verify;

  assert.equal(verify?.["runs-on"], "ubuntu-latest");
  assert.equal(
    String(actionStep(verify, "actions/setup-node")?.with?.["node-version"]),
    minimumNode,
  );
  assert.ok(commands(verify).includes("npm run check"));
  assert.ok(commands(verify).includes("npm run package:smoke-install"));
});

test("macOS runs the complete suite and verifies the installed package", () => {
  const macos = ci.jobs?.["verify-macos"];
  const macosCommands = commands(macos);

  assert.match(macos?.["runs-on"], /^macos-/u);
  assert.ok(actionStep(macos, "actions/setup-node"));
  assert.ok(macosCommands.includes("npm run check"));
  assert.ok(macosCommands.includes("npm run package:smoke-install"));
});

test("Bun is pinned and tested only as an installer for the Node package", () => {
  const bun = ci.jobs?.["verify-bun-installer"];
  const bunCommands = commands(bun);

  assert.equal(bun?.["runs-on"], "ubuntu-latest");
  assert.equal(
    String(actionStep(bun, "actions/setup-node")?.with?.["node-version"]),
    "22.22.0",
  );
  assert.equal(
    String(actionStep(bun, "oven-sh/setup-bun")?.with?.["bun-version"]),
    "1.3.14",
  );
  assert.ok(bunCommands.includes("npm run package:build"));
  assert.ok(bunCommands.includes("npm run package:smoke-install-bun"));
  assert.ok(!bunCommands.some((command) => /\bbun run\b/u.test(command)));
  assert.ok(!bunCommands.some((command) => /\bbun test\b/u.test(command)));
});

test("every external workflow action is immutably pinned with a release annotation", () => {
  assert.ok(workflows.size > 0, "At least one GitHub Actions workflow is required.");
  for (const [name, workflow] of workflows) {
    const actionLines = workflow
      .split("\n")
      .filter((line) => /^\s*(?:-\s+)?uses:\s+(?!\.\/)/u.test(line));
    assert.ok(actionLines.length > 0, `${name} must contain reviewed Actions.`);
    for (const line of actionLines) {
      assert.match(
        line,
        /^\s*(?:-\s+)?uses:\s+[\w.-]+\/[\w.-]+@[0-9a-f]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/u,
        `${name} contains a floating or undocumented Action reference: ${line.trim()}`,
      );
    }
  }
});

test("Dependabot covers npm packages and immutable GitHub Action pins", () => {
  assert.equal(dependabot.version, 2);
  const ecosystems = new Map(
    dependabot.updates?.map((entry) => [entry["package-ecosystem"], entry]),
  );

  for (const ecosystem of ["npm", "github-actions"]) {
    const update = ecosystems.get(ecosystem);
    assert.ok(update, `Dependabot must update ${ecosystem}.`);
    assert.equal(update.directory, "/");
    assert.equal(update.schedule?.interval, "weekly");
    assert.ok(update["open-pull-requests-limit"] > 0);
  }
});
