/* global URL, structuredClone */
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";
import { campaignName, context, pairedRows, resultRows, trialDetails } from "../.build/evidence.js";

const root = new URL("../.build/", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
const campaigns = JSON.parse(await readFile(new URL("summary.json", root), "utf8"));
test("static first render includes actual results and all campaign choices", () => {
  assert.match(html, /2 \/ 2/u);
  assert.match(html, /114\.0 s/u);
  assert.match(html, /408,985/u);
  assert.match(html, /Dollar cost is unavailable, not zero/u);
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/u);
  assert.equal(campaigns.length, 8);
  for (const campaign of campaigns) assert.ok(html.includes(campaignName(campaign)));
  assert.match(html, /gpt-5\.6-luna/u);
  assert.match(html, /69e39cb6ed7ec1fd5d3d69292c7a62298f52554f7a6a30ab173c5c9ffd4bda42/u);
});
test("local asset links resolve and captures match repository sources byte for byte", async () => {
  for (const match of html.matchAll(/(?:src|href)="\.\/([^"#]+)"/gu)) await access(new URL(match[1], root));
  for (const name of ["terminal-patch.svg", "terminal-v19-working.svg", "terminal-diff.svg", "terminal-permission.svg", "terminal-workflow.mp4", "terminal-workflow.json"]) {
    assert.deepEqual(await readFile(new URL(`assets/${name}`, root)), await readFile(new URL(`../../docs/assets/${name}`, import.meta.url)));
  }
});
test("render escapes model identity and verification evidence", () => {
  const campaign = structuredClone(campaigns[3]);
  campaign.arms[0].id = "<script>";
  campaign.arms[0].routes[0].modelId = '<img src=x onerror="alert(1)">';
  assert.doesNotMatch(resultRows(campaign), /<script>/iu);
  assert.doesNotMatch(trialDetails(campaign), /<img/iu);
  assert.match(trialDetails(campaign), /&lt;img/u);
});
test("unknown metrics and incomplete denominators remain explicit", () => {
  const interrupted = campaigns[2];
  assert.match(resultRows(interrupted), /1 \/ 3/u);
  assert.match(resultRows(interrupted), /Unknown/u);
  assert.match(trialDetails(interrupted), /not a count of human interventions/u);
});

test("paired observations preserve missing slots and separate cached input", () => {
  const fresh = campaigns.find((campaign) => campaign.scenario === "retry_after");
  const rows = pairedRows(fresh);
  assert.match(rows, /17,538/u);
  assert.match(rows, /59,136/u);
  assert.match(context(fresh), /not structurally disabled/u);
  const interrupted = campaigns.find((campaign) => !campaign.complete);
  assert.match(pairedRows(interrupted), /Missing trial/u);
  const unknown = structuredClone(fresh);
  unknown.trials[0].usage.cachedInputTokens = null;
  assert.match(pairedRows(unknown), /Unknown/u);
  const invalid = structuredClone(fresh);
  invalid.trials[0].usage.cachedInputTokens = invalid.trials[0].usage.inputTokens + 1;
  assert.match(pairedRows(invalid), /Unknown/u);
});

test("invalid team topology is explicit and never described as efficiency", () => {
  const invalid = campaigns.find(campaign => campaign.scenario === "workspace_maintenance");
  assert.match(context(invalid), /Invalid team setup/u);
  assert.match(pairedRows(invalid), /Invalid setup/u);
  assert.match(html, /Workers never started/u);
  assert.match(html, /has not run/u);
});
