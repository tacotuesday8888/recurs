/* global URL, structuredClone */
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import test from "node:test";
import { campaignName, resultRows, trialDetails } from "../dist/evidence.js";

const root = new URL("../dist/", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
const campaigns = JSON.parse(await readFile(new URL("summary.json", root), "utf8"));
test("static first render includes actual results and all campaign choices", () => {
  assert.match(html, /3 \/ 3/u);
  assert.match(html, /108\.3 s/u);
  assert.match(html, /1,291,111/u);
  assert.match(html, /Dollar cost is unavailable, not zero/u);
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/u);
  assert.equal(campaigns.length, 4);
  for (const campaign of campaigns) assert.ok(html.includes(campaignName(campaign)));
});
test("local asset links resolve and captures match repository sources byte for byte", async () => {
  for (const match of html.matchAll(/(?:src|href)="\.\/([^"#]+)"/gu)) await access(new URL(match[1], root));
  for (const name of ["terminal-v19-working.svg", "terminal-diff.svg", "terminal-permission.svg"]) {
    assert.deepEqual(await readFile(new URL(`assets/${name}`, root)), await readFile(new URL(`../../docs/assets/${name}`, import.meta.url)));
  }
});
test("render escapes model identity and verification evidence", () => {
  const campaign = structuredClone(campaigns[3]);
  campaign.arms[0].id = "<script>";
  campaign.arms[0].routes[0].modelId = '<img src=x onerror="alert(1)">';
  assert.doesNotMatch(resultRows(campaign), /<script>/u);
  assert.doesNotMatch(trialDetails(campaign), /<img/u);
  assert.match(trialDetails(campaign), /&lt;img/u);
});
test("unknown metrics and incomplete denominators remain explicit", () => {
  const interrupted = campaigns[2];
  assert.match(resultRows(interrupted), /1 \/ 3/u);
  assert.match(resultRows(interrupted), /Unknown/u);
  assert.match(trialDetails(interrupted), /not a count of human interventions/u);
});
