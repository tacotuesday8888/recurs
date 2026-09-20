/* global URL */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseProductComparison, productAttemptCompleted, renderProductComparison } from "../.build/product-comparison.js";
import { buildProductComparison } from "../scripts/product-comparison-build.mjs";
import { syntheticProductComparison } from "./product-comparison-fixtures.mjs";

test("fresh comparison renders explicit products, three tasks and every declared attempt", () => {
  const data = syntheticProductComparison();
  const html = renderProductComparison(data);
  assert.equal((html.match(/data-product-task=/gu) ?? []).length, 3);
  assert.equal((html.match(/<li\b[^>]*><p><strong>/gu) ?? []).length, 12);
  assert.equal((html.match(/data-count-to="2"/gu) ?? []).length, 6);
  assert.match(html, /Luna \(medium\) for lead/u);
  assert.match(html, /Terra \(medium\) for implementation/u);
  assert.match(html, /including delegation, remained available/u);
  assert.match(html, /three seeded regressions, not general bug finding/u);
  assert.doesNotMatch(html, /Single agent|Typical time|faster|cheaper|savings/u);
});

test("counts require execution, verification, integrity and source review, preserving other outcomes", () => {
  const data = syntheticProductComparison();
  data.attempts[0].executionStatus = "timed_out";
  data.attempts[1].sourceReview = "failed";
  data.attempts[2].verificationStatus = "failed";
  data.attempts[3].validity = "invalid";
  data.attempts[3].note = "Setup mismatch retained for audit";
  const parsed = parseProductComparison(data);
  assert.deepEqual(parsed.attempts.slice(0, 4).map(productAttemptCompleted), [false, false, false, false]);
  const html = renderProductComparison(data);
  assert.equal((html.match(/data-count-to="0"/gu) ?? []).length, 2);
  assert.match(html, /Timed out/u);
  assert.match(html, /Task checks passed; workspace checks passed; source review passed/u);
  assert.match(html, /Source review failed/u);
  assert.match(html, /Task checks failed/u);
  assert.match(html, /Invalid comparison/u);
  assert.match(html, /Setup mismatch retained for audit/u);
});

test("unstarted attempts have no invented timing or usage; measured zero remains distinct", () => {
  const data = syntheticProductComparison();
  Object.assign(data.attempts[0], { executionStatus: "not_started", verificationStatus: "not_run", workspaceIntegrity: "not_run", sourceReview: "not_run", elapsedMs: null, usage: { coverage: "none", inputTokens: null, cachedInputTokens: null, outputTokens: null } });
  data.attempts[1].elapsedMs = null;
  data.attempts[2].elapsedMs = 0;
  const html = renderProductComparison(data);
  assert.match(html, /Not started/u);
  assert.match(html, /Not recorded/u);
  assert.match(html, /0\.0 seconds/u);
  assert.equal((html.match(/data-count-to="1"/gu) ?? []).length, 1);
});

test("token comparison needs complete comparable input/output counters; cached unknown is retained", () => {
  const data = syntheticProductComparison();
  assert.doesNotMatch(renderProductComparison(data), /Input tokens: 123,456/u);
  data.tokenAccounting.comparable = true;
  data.tokenAccounting.note = "SYNTHETIC-TEST-ONLY: equivalent input/output coverage audited.";
  data.attempts[0].usage.cachedInputTokens = null;
  let html = renderProductComparison(data);
  assert.equal((html.match(/Input tokens: 123,456/gu) ?? []).length, 12);
  assert.match(html, /cached portion unknown/u);
  assert.match(html, /100,000 cached/u);
  assert.doesNotMatch(html, /223,456/u);
  data.attempts[1].usage.coverage = "partial";
  html = renderProductComparison(data);
  assert.doesNotMatch(html, /Input tokens:/u);
  assert.match(html, /equivalent, complete coverage has not been established/u);
});

test("time bars share one scale across tasks and omit unknown durations", () => {
  const data = syntheticProductComparison();
  for (const attempt of data.attempts) attempt.elapsedMs = 0;
  data.attempts[0].elapsedMs = 50_000;
  data.attempts[4].elapsedMs = 100_000;
  data.attempts[8].elapsedMs = null;
  const html = renderProductComparison(data);
  assert.match(html, /0–100 second scale/u);
  assert.match(html, /width:50\.00%/u);
  assert.match(html, /width:100\.00%/u);
  assert.equal((html.match(/class="product-time-bar"/gu) ?? []).length, 11);
  assert.match(html, /Not recorded/u);
});

test("strict export validation rejects missing/duplicate slots, invented metrics and unaudited kinds", () => {
  for (const alter of [
    data => { data.kind = "synthetic"; },
    data => { data.attempts.pop(); },
    data => { data.attempts[1] = { ...data.attempts[0] }; },
    data => { data.attempts[0].elapsedMs = -1; },
    data => { data.attempts[0].elapsedMs = Infinity; },
    data => { data.attempts[0].usage.inputTokens = null; },
    data => { data.attempts[0].usage.cachedInputTokens = 9999999; },
    data => { data.attempts[0].usage.coverage = "none"; },
    data => { data.attempts[0].executionStatus = "not_started"; },
    data => { data.attempts[0].validity = "invalid"; data.attempts[0].note = ""; },
    data => { data.configurations[1].id = "codex-cli"; },
    data => { data.configurations[0].routes.push(data.configurations[0].routes[0]); },
    data => { data.sourceRevision = "unknown"; },
    data => { data.reportedCostUsd = 0; },
  ]) {
    const data = syntheticProductComparison();
    alter(data);
    assert.throws(() => parseProductComparison(data));
  }
});

test("text is escaped and evidence links are constrained to public repository or local artifacts", () => {
  const data = syntheticProductComparison();
  data.attempts[0].note = '<img src=x onerror="alert(1)"><IMG src=x onerror="alert(1)">';
  data.tokenAccounting.note = "<ScRiPt>invalid</ScRiPt>";
  data.configurations[0].routes[0].modelId = "<CuStOm>";
  const html = renderProductComparison(data);
  assert.doesNotMatch(html, /<img|<script|<custom/iu);
  assert.ok(html.includes('&lt;IMG src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.ok(html.includes("&lt;ScRiPt&gt;invalid&lt;/ScRiPt&gt;"));
  assert.ok(html.includes("&lt;CuStOm&gt;"));
  for (const href of ["javascript:alert(1)", "//example.com", "https://example.com/a", "https://github.com/another/repo", "./../secret", "./file?bad"]) {
    data.auditHref = href;
    assert.throws(() => parseProductComparison(data));
  }
});

test("static completion text uses existing motion hooks and accessible final values", () => {
  const html = renderProductComparison(syntheticProductComparison());
  const counters = [...html.matchAll(/<span class="sr-only">([^<]+)<\/span><span aria-hidden="true" data-count-to="([^"]+)">([^<]+)<\/span>/gu)];
  assert.equal(counters.length, 6);
  for (const [, accessible, target, visible] of counters) {
    assert.equal(accessible, target);
    assert.equal(accessible, visible);
  }
  assert.equal((html.match(/data-scroll-reveal/gu) ?? []).length, 3);
  assert.match(html, /<details class="product-attempts"><summary>Attempt details<\/summary>/u);
  assert.doesNotMatch(html, /<script|onclick=|scrollIntoView|autofocus/u);
});

test("optional build hook publishes no placeholders and validates existing local artifact links", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "product-display-test-"));
  const dataPath = path.join(root, "website-results.json");
  const options = { dataPath, outputPath: root, parse: parseProductComparison, render: renderProductComparison };
  try {
    assert.equal(await buildProductComparison(options), "");
    assert.equal(renderProductComparison(), "");
    await writeFile(dataPath, "not json");
    await assert.rejects(buildProductComparison(options));
    const data = syntheticProductComparison();
    data.auditHref = "./audit.md";
    await writeFile(dataPath, JSON.stringify(data));
    await assert.rejects(buildProductComparison(options));
    await writeFile(path.join(root, "audit.md"), "Synthetic test-only artifact");
    assert.match(await buildProductComparison(options), /Codex CLI and Recurs/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("normal website build contains neither synthetic metrics nor placeholder comparison rows", async () => {
  const html = await readFile(new URL("../.build/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /SYNTHETIC-TEST-ONLY|\{\{PRODUCT_COMPARISON\}\}/u);
  const styles = await readFile(new URL("../.build/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.product-measures \{ min-width: 0;/u);
  assert.doesNotMatch(styles.slice(styles.indexOf("/* Uses the existing Recurs palette")), /#[a-f0-9]{3,8}\b|animation:|scroll-behavior:|\.brand/u);
});

test("real audited page preserves every outcome and separates reviewer observation from reproduction", async () => {
  const exported = JSON.parse(await readFile(new URL("../../benchmarks/product-comparison/website-results.json", import.meta.url), "utf8"));
  const parsed = parseProductComparison(exported);
  assert.deepEqual(["codex-cli", "company-auto"].map(arm => parsed.attempts.filter(a => a.armId === arm && productAttemptCompleted(a)).length), [3, 2]);
  const html = await readFile(new URL("../.build/index.html", import.meta.url), "utf8");
  assert.match(html, /href="#product-comparison">Benchmarks/u);
  assert.match(html, /Review flagged an edge case\. Our audit confirmed the test gap\./u);
  assert.match(html, /Recurs flagged a rebuild edge case, but the repair did not finish\./u);
  assert.match(html, /<details><summary>See the review finding<\/summary>/u);
  assert.match(html, /Separately, our offline audit/u);
  assert.match(html, /not a replay of that candidate/u);
  assert.match(html, /repair did not deliver an accepted result/u);
  assert.doesNotMatch(html, /Earlier tests inside Recurs/u);
  assert.match(html, /Codex CLI finished <strong>3 of 6<\/strong>; Recurs finished <strong>2 of 6<\/strong>/u);
  assert.match(html, /<details class="product-evidence-details"><summary>Explore the 12 attempts<\/summary>/u);
  assert.equal((html.match(/data-product-task=/gu) ?? []).length, 3);
  assert.equal((html.match(/<li\b[^>]*><p><strong>/gu) ?? []).length, 12);
  assert.match(html, /464\.9 seconds/u);
  assert.match(html, /no final trial, candidate, elapsed time or token counters were retained/iu);
  assert.doesNotMatch(html, /SYNTHETIC-TEST-ONLY/u);
});

test("optional review observation escapes text and rejects incomplete unsupported records", () => {
  const finding = { version: 1, title: "<em>Review</em>", summary: "<EM>Summary</EM>", reviewerObservation: "Reviewer observation", auditObservation: "Separate reproduction", outcome: "Repair failed" };
  const html = renderProductComparison(syntheticProductComparison(), finding);
  assert.match(html, /&lt;em&gt;Review&lt;\/em&gt;/u);
  assert.equal(html.includes("<em>Review</em>"), false);
  assert.throws(() => renderProductComparison(syntheticProductComparison(), { ...finding, version: 2 }));
  assert.throws(() => renderProductComparison(syntheticProductComparison(), { version: 1 }));
  assert.doesNotMatch(renderProductComparison(syntheticProductComparison()), /product-review-story/u);
});

test("benchmark overview preserves all outcomes with twelve inspectable slots", async () => {
  const html = await readFile(new URL("../.build/index.html", import.meta.url), "utf8");
  assert.equal((html.match(/class="benchmark-slot /gu) ?? []).length, 12);
  assert.equal((html.match(/class="benchmark-slot finished"/gu) ?? []).length, 5);
  assert.equal((html.match(/class="benchmark-slot unfinished"/gu) ?? []).length, 5);
  assert.equal((html.match(/class="benchmark-slot invalid"/gu) ?? []).length, 2);
  assert.match(html, /Select it to inspect the result/u);
  const controls = [...html.matchAll(/data-inspect-task="([^"]+)" aria-controls="([^"]+)" aria-label="([^"]+)"/gu)];
  assert.equal(controls.length, 12);
  assert.equal(new Set(controls.map(match => match[2])).size, 12);
  for (const [, task, target, label] of controls) {
    const attempt = /attempt (\d): (.+)$/u.exec(label);
    const arm = label.startsWith("Codex CLI,") ? "codex-cli" : "company-auto";
    assert.equal(target, `attempt-${task}-${arm}-${attempt[1]}`);
    assert.ok(html.includes(`<li id="${target}" tabindex="-1"><p><strong>${label.split(",")[0]}, attempt ${attempt[1]}: ${attempt[2]}</strong>`));
  }
});
