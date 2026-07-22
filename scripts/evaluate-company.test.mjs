import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = path.resolve("scripts/evaluate-company.mjs");

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
