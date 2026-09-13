/* global URL */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { getCompanyBenchmarkScenario } from "../packages/core/dist/index.js";

const root = new URL("../benchmarks/", import.meta.url);
const evidence = JSON.parse(await readFile(new URL("task-fit-results.json", root), "utf8"));
test("every original trial has an exact bounded declared-file archive", async () => {
  let count = 0;
  for (const { campaign, trials } of evidence.campaigns) {
    const scenario = getCompanyBenchmarkScenario(campaign.scenario.id, campaign.scenario.version);
    for (const trial of trials) {
      const directory = new URL(`task-fit-artifacts/${scenario.id}/${trial.slotId}/`, root);
      const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
      assert.equal(manifest.trialId, trial.id);
      assert.equal(manifest.campaignId, campaign.id);
      assert.equal(manifest.fixtureSha256, scenario.fixtureSha256);
      assert.deepEqual(manifest.files.map(file => file.path).sort(), scenario.files.map(file => file.path).sort());
      for (const kind of ["candidate", "fixture"]) {
        const archive = new URL(`${kind}/`, directory);
        const paths = await readdir(archive, { recursive: true, withFileTypes: true });
        assert.equal(paths.filter(file => file.isFile()).length, scenario.files.length);
        for (const fixture of scenario.files) {
          const bytes = await readFile(new URL(fixture.path + ".txt", archive));
          assert.ok(bytes.length <= 65536);
          if (kind === "fixture") assert.equal(bytes.toString("utf8"), fixture.content);
          else assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.files.find(file => file.path === fixture.path).sha256);
        }
      }
      count++;
    }
  }
  assert.equal(count, 12);
});

test("queue amendment binds every replay to the unchanged original record and candidate", async () => {
  const audit = JSON.parse(await readFile(new URL("queue-verifier-audit.json", root), "utf8"));
  const { trials } = evidence.campaigns.find(entry => entry.campaign.id === audit.campaignId);
  assert.equal(audit.records.length, trials.length);
  for (const trial of trials) {
    const record = audit.records.find(item => item.trialId === trial.id);
    assert.deepEqual(record.originalRecordedVerification, trial.verification);
    assert.deepEqual(record.originalReplay.checks, trial.verification.checks);
    assert.equal(record.originalReplay.status, trial.verification.status);
    assert.equal(record.correctedReplay.status, trial.verification.status);
    const manifest = JSON.parse(await readFile(new URL(`task-fit-artifacts/queue_cancellation/${trial.slotId}/manifest.json`, root), "utf8"));
    assert.deepEqual(record.candidateFiles, manifest.files.map(({ path, sha256 }) => ({ path, sha256 })));
  }
});
