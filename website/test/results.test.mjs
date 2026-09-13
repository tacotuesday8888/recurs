/* global URL */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { taskResults } from "../.build/results.js";
const campaigns = JSON.parse(await readFile(new URL("../.build/summary.json", import.meta.url), "utf8"));
const html = await readFile(new URL("../.build/index.html", import.meta.url), "utf8");

test("plain task results use the three declared comparisons and preserve failures", () => {
  const result = taskResults(campaigns);
  const groups = [...result.matchAll(/<article[\s\S]*?<\/article>/gu)].map(match => match[0]);
  assert.equal(groups.length, 3);
  const values = groups.map(group => [...group.matchAll(/data-count-to="(\d+)"/gu)].map(match => Number(match[1])));
  assert.deepEqual(values, [[2,2,114,140,0,2,0,0], [2,0,141,230,0,3,0,1], [1,2,136,199,0,3,0,1]]);
  assert.equal((result.match(/Not reported/gu) ?? []).length, 6);
  assert.match(groups[1], /failed the checks twice/u);
  assert.throws(() => taskResults(campaigns.filter(campaign => campaign.scenarioVersion !== 2)), /Missing public task result/u);
});

test("public copy separates unmeasured claims from observations and retains the complete audit", () => {
  const publicView = html.slice(html.indexOf('id="evidence"'), html.indexOf('<details class="inspect-trials"'));
  assert.match(publicView, /Both ran inside Recurs/u);
  assert.match(publicView, /Bugs found<\/dt><dd>Not measured/u);
  assert.match(publicView, /A full development project<\/dt><dd>Not tested/u);
  assert.match(publicView, /Dollar cost<\/dt><dd>Not reported/u);
  assert.doesNotMatch(publicView, /Codex|input tokens|harnessRevision|launchProtocol/u);
  assert.match(html, /<details class="inspect-trials">[\s\S]*id="chart-task"[\s\S]*id="campaign"/u);
  assert.match(html, /v1 · invalid team setup/u);
});

test("count-up markup starts at final values and provides static accessible text", () => {
  const counters = [...taskResults(campaigns).matchAll(/<span class="sr-only">([^<]+)<\/span><span aria-hidden="true" data-count-to="([^"]+)">([^<]+)<\/span>/gu)];
  assert.equal(counters.length, 24);
  for (const match of counters) {
    assert.equal(match[1], match[3]);
    assert.equal(Number(match[2]), Number(match[3].replaceAll(",", "")));
  }
  assert.doesNotMatch(html, /scroll-progress/u);
});
