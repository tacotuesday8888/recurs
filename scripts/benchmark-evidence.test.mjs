/* global URL, structuredClone */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { summarizeEvidence, validateEvidence } from "./benchmark-evidence.mjs";

const evidence = JSON.parse(await readFile(new URL("../benchmarks/results.json", import.meta.url), "utf8"));
const fresh = JSON.parse(await readFile(new URL("../benchmarks/current-results.json", import.meta.url), "utf8"));
const changed = (edit) => { const copy = structuredClone(evidence); edit(copy); return copy; };
test("published evidence retains interrupted slots and unmatched-parent campaigns", () => {
  const summaries = summarizeEvidence(evidence);
  assert.equal(summaries.length, 4);
  assert.equal(summaries.reduce((count, item) => count + item.recordedTrials, 0), 27);
  assert.equal(summaries.reduce((count, item) => count + item.settledSlots, 0), 30);
  assert.equal(summaries[0].arms[1].parentMatched, false);
  assert.equal(summaries[2].complete, false);
  assert.equal(summaries[2].arms[0].inputTokens, null);
  assert.deepEqual(summaries[3].arms.map((arm) => arm.passed), [3, 2, 2]);
  assert.deepEqual(summaries[3].arms.map((arm) => arm.medianWallClockMs), [108298, 222661, 245275]);
  assert.ok(summaries.every((campaign) => campaign.arms.every((arm) => arm.reportedCostUsd === null)));
});
test("rejects a trial recorded against a different immutable fixture", () => {
  assert.throws(() => validateEvidence(changed((copy) => {
    copy.campaigns[0].trials[0].scenario.fixtureSha256 = "0".repeat(64);
  })), /authority mismatch/u);
});
test("rejects duplicate and unsettled trials instead of silently inflating results", () => {
  assert.throws(() => validateEvidence(changed((copy) => {
    copy.campaigns[0].trials.push(copy.campaigns[0].trials[0]);
  })), /Duplicate trial/u);
  assert.throws(() => validateEvidence(changed((copy) => {
    copy.campaigns[0].settlements.pop();
  })), /Unsettled trial/u);
});
test("rejects a mismatched usage settlement", () => {
  assert.throws(() => validateEvidence(changed((copy) => {
    copy.campaigns[0].settlements[0].requestsCharged += 1;
  })), /does not back trial/u);
});
test("unknown cost is never replaced by conservative charged allowance", () => {
  const copy = changed((item) => {
    item.campaigns[0].settlements[0].costChargedUsd = 5;
  });
  assert.equal(summarizeEvidence(copy)[0].arms[0].reportedCostUsd, null);
});
test("export contains no original local connection IDs, raw outputs or private paths", () => {
  const serialized = JSON.stringify([evidence, fresh]);
  assert.doesNotMatch(serialized, /codex-[0-9a-f]{8}-|\/Users\/|\/home\/|api[_-]?key|access[_-]?token|refresh[_-]?token|rawOutput/iu);
  assert.ok(evidence.campaigns.every((entry) => /^[0-9a-f]{64}$/u.test(entry.sourceSha256)));
});
test("fresh probe uses the exact Luna parent for both arms and preserves the one-pair limit", () => {
  const [campaign] = summarizeEvidence(fresh);
  assert.equal(campaign.repetitions, 1);
  assert.deepEqual(campaign.arms.map((arm) => arm.passed), [1, 1]);
  assert.ok(campaign.arms.every((arm) => arm.parentMatched && arm.routes[0].modelId === "gpt-5.6-luna" && arm.routes[0].reasoningEffort === "medium"));
  assert.deepEqual(campaign.arms.map((arm) => arm.medianWallClockMs), [90432, 229438]);
  assert.deepEqual(campaign.arms.map((arm) => arm.inputTokens), [76674, 409620]);
  assert.deepEqual(campaign.arms.map((arm) => arm.reportedCostUsd), [null, null]);
  assert.equal(fresh.selection.executedArtifactSha256, "760393acc9f3b3b9be2bcd20c0c095a1004156fd77f3fca3777cc2503e07142f");
});
