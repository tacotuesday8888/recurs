import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = path.resolve("scripts/evaluate-company.mjs");

test("company evaluation scenarios are stable and discoverable", async () => {
  const { stdout, stderr } = await execute(process.execPath, [
    script,
    "--list",
    "--json",
  ]);
  const catalog = JSON.parse(stdout);
  assert.equal(stderr, "");
  assert.deepEqual(catalog.scenarios.map((scenario) => scenario.id), [
    "company_formation_v1",
    "company_goal_execution_v1",
  ]);
});

test("offline company evaluation smoke emits safe deterministic structure", async () => {
  const { stdout, stderr } = await execute(process.execPath, [
    script,
    "--scenario",
    "company_formation_v1",
    "--project",
    process.cwd(),
    "--json",
  ]);
  const report = JSON.parse(stdout);

  assert.equal(stderr, "");
  assert.equal(report.status, "passed");
  assert.equal(report.mode, "offline");
  assert.equal(report.scenarioId, "company_formation_v1");
  assert.equal(report.rubric.length, 6);
  assert.equal(JSON.stringify(report).includes("What should this company"), false);
});

test("configured evaluation requires explicit network opt-in", async () => {
  await assert.rejects(
    execute(process.execPath, [script, "--configured", "--json"]),
    (error) => {
      assert.match(error.stderr, /requires --allow-network/u);
      return true;
    },
  );
});

test("missing durable goal lookup is sanitized and never contacts a provider", async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "recurs-eval-script-"));
  try {
    await assert.rejects(
      execute(process.execPath, [
        script,
        "--scenario",
        "company_goal_execution_v1",
        "--run",
        "missing-run",
        "--project",
        process.cwd(),
        "--recurs-home",
        dataDirectory,
        "--json",
      ]),
      (error) => {
        assert.equal(error.stdout, "");
        assert.equal(
          error.stderr,
          "The selected durable company goal could not be read.\n",
        );
        assert.equal(error.stderr.includes(dataDirectory), false);
        return true;
      },
    );
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
