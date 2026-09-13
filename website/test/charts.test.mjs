/* global URL, structuredClone */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { observations, renderChart } from "../.build/charts.js";
const campaigns = JSON.parse(await readFile(new URL("../.build/summary.json", import.meta.url), "utf8"));
const options = campaigns.find(campaign => campaign.scenario === "options_precedence");
const queue = campaigns.find(campaign => campaign.scenario === "queue_cancellation");
const workspace = campaigns.find(campaign => campaign.scenario === "workspace_maintenance");

test("runtime shows both original trials per arm instead of hiding variation in an average", () => {
  assert.deepEqual(observations(options, "runtime").map(point => point.value), [81.342, 146.725, 132.091, 148.499]);
  assert.deepEqual(observations(queue, "correctness").map(point => point.value), [1, 1, 0, 0]);
  assert.match(renderChart(queue, "correctness"), /No verified completion/u);
  assert.match(renderChart(options, "runtime"), /2 trials per arm/u);
});

test("token parts count cached input once and preserve review and repair overhead", () => {
  const points = observations(options, "tokens");
  assert.deepEqual(points[0].segments.map(part => part.value), [19875, 119296, 3069]);
  assert.equal(points[0].value, 142240);
  const baselineInput = points.slice(0, 2).reduce((sum, point) => sum + point.segments[0].value + point.segments[1].value, 0);
  assert.equal(baselineInput, 408985);
  assert.deepEqual(observations(queue, "overhead").map(point => point.value), [0, 0, 3, 1]);
  const invalid = structuredClone(options);
  invalid.trials[0].usage.cachedInputTokens = invalid.trials[0].usage.inputTokens + 1;
  assert.equal(observations(invalid, "tokens").find(point => point.arm === invalid.trials[0].armId && point.repetition === invalid.trials[0].repetition).value, null);
});

test("invalid setups preserve measurements without becoming speed comparison bars", () => {
  const points = observations(workspace, "runtime");
  assert.deepEqual(points.slice(2).map(point => [point.value, point.setupInvalid]), [[25.984, true], [25.309, true]]);
  const html = renderChart(workspace, "runtime");
  assert.equal((html.match(/class="chart-point chart-invalid"/gu) ?? []).length, 2);
  assert.match(html, /excluded from the comparison scale/u);
  assert.doesNotMatch(html, /class="chart-part team"/u);
});

test("missing records and unknown dollars are never plotted as measured zero", () => {
  assert.ok(observations(options, "cost").every(point => point.value === null));
  assert.match(renderChart(options, "cost"), /did not report dollar cost/u);
  assert.doesNotMatch(renderChart(options, "cost"), /\$0|class="chart-axis"/u);
  const missing = structuredClone(options);
  missing.trials = [];
  assert.ok(observations(missing, "runtime").every(point => point.value === null && point.outcome === "Missing trial"));
  const known = structuredClone(options);
  known.trials[0].usage.costCoverage = "complete";
  known.trials[0].usage.reportedCostUsd = 0.12;
  assert.match(renderChart(known, "cost"), /\$0\.1200/u);
});


test("corrected workspace results are quantitative observations distinct from invalid v1 setups", () => {
  const corrected = campaigns.find(campaign => campaign.scenario === "workspace_maintenance" && campaign.scenarioVersion === 2);
  assert.deepEqual(observations(corrected, "correctness").map(point => point.value), [1, 0, 1, 1]);
  assert.deepEqual(observations(corrected, "runtime").map(point => point.value), [113.02, 157.999, 170.41, 226.613]);
  assert.ok(observations(corrected, "runtime").every(point => !point.setupInvalid));
  assert.match(renderChart(corrected, "runtime"), /class="chart-part team"/u);
  assert.doesNotMatch(renderChart(corrected, "runtime"), /invalid|excluded from the comparison scale/iu);
});
