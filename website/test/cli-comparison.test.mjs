/* global URL */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseCliComparison, renderCliComparison } from "../.build/cli-comparison.js";

const record = JSON.parse(await readFile(new URL("../../benchmarks/cli-resources/results.json", import.meta.url), "utf8"));

test("speed chart shows every valid run and the recorded medians", () => {
  const html = renderCliComparison(record);
  for (const [id, name] of [["recurs", "Recurs"], ["codex", "Codex CLI"], ["claude-code", "Claude Code"]]) {
    const valid = record.results[id].long.samples.filter((sample) => sample.valid).map((sample) => sample.wallMs).sort((a, b) => a - b);
    assert.ok(html.includes(`${name}: median ${valid[Math.floor(valid.length / 2)]} milliseconds`));
  }
  assert.equal((html.match(/class="speed-dot"/gu) ?? []).length, 15);
  assert.match(html, /Protocol and every sample/u);
});

test("speed chart refuses records it cannot trace", () => {
  assert.throws(() => parseCliComparison({ ...record, protocolSha256: "unknown" }));
  assert.throws(() => parseCliComparison({ ...record, results: { ...record.results, recurs: {} } }));
});

test("the homepage includes the traced speed chart", async () => {
  const html = await readFile(new URL("../.build/index.html", import.meta.url), "utf8");
  assert.match(html, /Finishing a long streamed answer/u);
});
