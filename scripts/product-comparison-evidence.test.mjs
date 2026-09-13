/* global URL */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { getCompanyBenchmarkScenario } from "../packages/core/dist/company-benchmark-scenario.js";
import { validateEvidence } from "./benchmark-evidence.mjs";

const root = new URL("../benchmarks/product-comparison/", import.meta.url);
const bytes = name => readFile(new URL(name, root));
const json = async name => JSON.parse(await bytes(name));
const hash = value => createHash("sha256").update(value).digest("hex");
const [declaration, selection, results, initial, contract, audit, website, native, repairs] = await Promise.all(
  ["declaration.json", "selection.json", "results.json", "candidate-audit.json", "contract-audit.json", "audit.json", "website-results.json", "native-event-inventory.json", "repair-diagnostics.json"].map(json),
);
const slotKey = value => `${value.campaignId}/${value.slotId}`;
const completed = a => a.validity === "valid" && a.executionStatus === "completed" && a.verificationStatus === "passed" && a.workspaceIntegrity === "passed" && a.sourceReview === "passed";

async function fileInventory(url) {
  const result = [];
  for (const entry of await readdir(url, { withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), "Public evidence cannot contain symlinks");
    if (entry.isDirectory()) for (const child of await fileInventory(new URL(`${entry.name}/`, url))) result.push(`${entry.name}/${child}`);
    else { assert.ok(entry.isFile()); result.push(entry.name); }
  }
  return result.sort();
}

test("fresh public records bind every declared slot to immutable selection and audit inputs", async () => {
  validateEvidence(results);
  assert.deepEqual(results.selection, selection);
  assert.equal(selection.sourceRevision, declaration.sourceRevision);
  assert.equal(selection.executedArtifactSha256, declaration.recursBundleSha256);
  assert.equal(hash(await bytes("PLAN.md")), declaration.planSha256);
  // Compare all fields and within-file connection equality without publishing a cross-alias map.
  const routePattern = campaigns => {
    const identities = [];
    return JSON.parse(JSON.stringify(campaigns, (key, value) => {
      if (key !== "connectionId") return value;
      if (!identities.includes(value)) identities.push(value);
      return `redacted-connection-${identities.indexOf(value)}`;
    }));
  };
  assert.deepEqual(routePattern(results.campaigns.map(c => c.campaign)), routePattern(declaration.campaigns));
  assert.equal(Object.hasOwn(audit.routeAliasAudit, "mapping"), false);
  assert.equal(results.campaigns.reduce((n, c) => n + c.reservations.length, 0), 12);
  assert.equal(results.campaigns.reduce((n, c) => n + c.trials.length, 0), 11);
  assert.equal(audit.records.length, 12);
  assert.equal(new Set(audit.records.map(slotKey)).size, 12);
  for (const [field, name] of Object.entries({ declarationSha256: "declaration.json", selectionSha256: "selection.json", resultsSha256: "results.json", candidateAuditSha256: "candidate-audit.json", contractAuditSha256: "contract-audit.json", nativeEventInventorySha256: "native-event-inventory.json", repairDiagnosticsSha256: "repair-diagnostics.json", reviewFindingSha256: "review-finding.json" })) assert.equal(audit[field], hash(await bytes(name)), name);
});

test("all eleven candidate archives contain only hash-bound declared source and original fixtures", async () => {
  assert.equal(initial.candidates.length, 11);
  let fileCount = 0;
  const expectedArchive = [];
  for (const candidate of initial.candidates) {
    const entry = results.campaigns.find(c => c.campaign.id === candidate.campaignId);
    const trial = entry.trials.find(t => t.slotId === candidate.slotId);
    const scenario = getCompanyBenchmarkScenario(candidate.scenarioId, 1);
    const archive = `artifacts/${candidate.scenarioId}/${candidate.slotId}/`;
    const manifest = await json(`${archive}manifest.json`);
    assert.equal(manifest.retainedDirectory, candidate.directory);
    assert.equal(manifest.trialId, trial.id);
    assert.equal(manifest.campaignId, entry.campaign.id);
    assert.equal(manifest.slotId, trial.slotId);
    assert.equal(manifest.fixtureSha256, scenario.fixtureSha256);
    assert.equal(manifest.fixtureSha256, trial.scenario.fixtureSha256);
    assert.deepEqual(candidate.files.map(f => f.path).sort(), scenario.files.map(f => f.path).sort());
    assert.deepEqual(manifest.files.map(({ path, sha256 }) => ({ path, sha256 })), candidate.files);
    expectedArchive.push(`${archive}manifest.json`);
    for (const fixture of scenario.files) {
      const file = manifest.files.find(f => f.path === fixture.path);
      for (const kind of ["candidate", "fixture"]) {
        const name = `${archive}${kind}/${file.path}.txt`;
        const content = await bytes(name);
        assert.ok(content.length <= 65536);
        assert.equal(hash(content), kind === "candidate" ? file.sha256 : file.fixtureSha256);
        if (kind === "fixture") assert.equal(content.toString("utf8"), fixture.content);
        if (!scenario.allowedChangedPaths.includes(file.path)) assert.equal(content.toString("utf8"), fixture.content);
        expectedArchive.push(name);
      }
      fileCount++;
    }
  }
  assert.equal(fileCount, 67);
  assert.deepEqual((await fileInventory(new URL("artifacts/", root))).map(p => `artifacts/${p}`), expectedArchive.sort());
});

test("supplementary contract failures bind exact captured outputs and source lines without rewriting frozen grades", async () => {
  assert.equal(contract.previousAudit.path, "./candidate-audit.json");
  assert.equal(contract.previousAudit.sha256, hash(await bytes("candidate-audit.json")));
  assert.equal(hash(contract.reference.source), contract.reference.sha256);
  assert.equal(contract.probes.length, 4);
  assert.deepEqual(contract.candidates.map(c => c.directory), ["conforming_reference", "trial-CGjm7K", "trial-EsPVZn", "trial-oGtkuW"]);
  for (const c of contract.candidates) {
    assert.equal(c.sourceIntegrity, "passed");
    assert.equal(c.contractReview, c.directory === "conforming_reference" ? "passed" : "failed");
    assert.equal(c.results.length, 4);
    for (const result of c.results) {
      assert.deepEqual(result.expected, contract.probes.find(p => p.id === result.id).expected);
      assert.equal(result.status, isDeepStrictEqual(result.actual, result.expected) ? "passed" : "failed");
    }
    if (c.directory === "conforming_reference") { assert.ok(c.results.every(r => r.status === "passed")); continue; }
    const original = initial.candidates.find(i => i.directory === c.directory);
    assert.equal(original.replay.status, "passed");
    for (const file of c.files) assert.equal(file.sha256, original.files.find(f => f.path === file.path).sha256);
    for (const source of c.sourceLines) {
      const text = (await bytes(`artifacts/${c.scenarioId}/${c.slotId}/candidate/${source.path}.txt`)).toString("utf8");
      assert.equal(text.split("\n")[source.line - 1], source.text);
    }
  }
  assert.deepEqual(contract.candidates.map(c => c.results.filter(r => r.status === "failed").length), [0, 3, 4, 4]);
});

test("every displayed attempt matches frozen timing and usage while applying explicit audited completion rules", () => {
  assert.equal(website.attempts.length, 12);
  assert.equal(website.sourceRevision, declaration.sourceRevision);
  assert.equal(website.auditedAt, audit.auditedAt);
  assert.equal(website.tokenAccounting.comparable, false);
  const config = c => c.configuredRoutes.map(({ role, modelId, reasoningEffort }) => ({ role, modelId, reasoningEffort }));
  assert.deepEqual(website.configurations, [{ id: "codex-cli", routes: config(declaration.campaigns[0].baseline) }, { id: "company-auto", routes: config(declaration.campaigns[0].companyArms[0]) }]);
  for (const entry of results.campaigns) for (const slot of entry.campaign.armOrder) {
    const r = audit.records.find(r => r.campaignId === entry.campaign.id && r.slotId === slot.slotId);
    const w = website.attempts.find(w => w.scenarioId === entry.campaign.scenario.id && w.armId === slot.armId && w.repetition === slot.repetition);
    const t = entry.trials.find(t => t.slotId === slot.slotId);
    const retained = initial.candidates.find(c => slotKey(c) === slotKey(r));
    assert.equal(r.settlementId, entry.settlements.find(s => s.slotId === slot.slotId).id);
    assert.equal(r.trialId, t?.id ?? null);
    assert.equal(r.retainedDirectory, retained?.directory ?? null);
    assert.equal(r.snapshotManifest, retained ? `./artifacts/${r.scenarioId}/${r.slotId}/manifest.json` : null);
    assert.equal(r.recordedExecutionStatus, t?.executionStatus ?? null);
    assert.deepEqual(r.recordedVerification, t?.verification ?? null);
    assert.deepEqual(r.offlineReplay, retained?.replay ?? { status: "not_run", checks: [] });
    assert.equal(r.sourceIntegrity, retained?.sourceReview ?? "not_run");
    const appendix = contract.candidates.find(c => c.directory === r.retainedDirectory);
    assert.equal(r.contractReview, !retained ? "not_run" : appendix?.contractReview === "failed" || retained.replay.status === "failed" ? "failed" : "passed");
    assert.equal(w.sourceReview, r.contractReview);
    assert.equal(w.executionStatus, t?.executionStatus ?? "cancelled");
    assert.equal(w.verificationStatus, t?.verification.status ?? "not_run");
    assert.equal(w.workspaceIntegrity, t?.verification.workspaceIntegrity ?? "not_run");
    assert.equal(w.elapsedMs, t?.wallClockMs ?? null);
    assert.deepEqual(w.usage, t ? { coverage: t.usage.tokenCoverage, inputTokens: t.usage.inputTokens, cachedInputTokens: t.usage.cachedInputTokens, outputTokens: t.usage.outputTokens } : { coverage: "none", inputTokens: null, cachedInputTokens: null, outputTokens: null });
    assert.equal(w.note, r.note);
    assert.equal(w.validity, r.validity);
    assert.equal(w.validity, !t || t.wallClockMs > declaration.limits.trialDeadlineMs ? "invalid" : "valid");
  }
  assert.deepEqual(["codex-cli", "company-auto"].map(arm => website.attempts.filter(a => a.armId === arm && completed(a)).length), [3, 2]);
  assert.equal(website.attempts.filter(a => a.validity === "invalid").length, 2);
  const cancelled = website.attempts.find(a => a.executionStatus === "cancelled");
  assert.equal(cancelled.scenarioId, "release_window_regressions");
  assert.equal(cancelled.armId, "codex-cli");
  assert.equal(cancelled.repetition, 2);
  assert.equal(cancelled.elapsedMs, null);
  const overrun = website.attempts.find(a => a.elapsedMs > declaration.limits.trialDeadlineMs);
  assert.equal(overrun.elapsedMs, 464896);
  assert.equal(overrun.validity, "invalid");
  assert.equal(overrun.verificationStatus, "failed");
  assert.equal(audit.records.find(r => r.scenarioId === overrun.scenarioId && r.armId === overrun.armId && r.repetition === overrun.repetition).offlineReplay.status, "passed");
});

test("native trace inventory and failed repair observations remain bounded evidence", () => {
  assert.equal(native.traces.length, 5);
  for (const trace of native.traces) {
    assert.ok(initial.candidates.some(c => slotKey(c) === slotKey(trace)));
    assert.deepEqual(Object.keys(trace.completedItemTypes).sort(), ["agent_message", "command_execution", "file_change"]);
    assert.equal(trace.externalSkillAccess.completedSkillReadCommands, 0);
    assert.equal(trace.nativeDelegation.delegationEvents, 0);
    assert.equal(trace.eventTypes["turn.completed"], 1);
  }
  assert.equal(repairs.trials.length, 2);
  for (const r of repairs.trials) {
    const t = results.campaigns.find(c => c.campaign.id === r.campaignId).trials.find(t => t.id === r.trialId);
    assert.equal(t.executionStatus, "failed");
    assert.deepEqual(r.review, t.review);
    assert.equal(r.repairRounds, t.repairRounds);
    for (const role of r.roles) {
      const recorded = t.roles.find(v => v.role === role.role);
      for (const [key, value] of Object.entries(role)) assert.deepEqual(value, recorded[key]);
    }
    assert.equal(r.teamDiagnostics[0].stagedCandidate, "not_retained");
    assert.equal(r.teamDiagnostics[0].truncated, true);
  }
});

test("public evidence contains no raw traces, auth files or local user paths", async () => {
  const files = await fileInventory(root);
  const topLevel = ["PLAN.md", "README.md", "REPAIR_DIAGNOSIS.md", "declaration.json", "selection.json", "results.json", "candidate-audit.json", "contract-audit.json", "audit.json", "website-results.json", "native-event-inventory.json", "repair-diagnostics.json", "review-finding.json"];
  assert.deepEqual(files.filter(f => !f.startsWith("artifacts/")).sort(), topLevel.sort());
  for (const name of files) {
    assert.doesNotMatch(name, /(?:^|\/)(?:\.env|auth\.json)|stdout|stderr|\.private|\.jsonl/iu);
    const text = (await bytes(name)).toString("utf8");
    assert.doesNotMatch(text, /\/Users\/|\/home\/[^ ]+\/|\/private\/|\/tmp\/|[A-Z]:\\Users\\|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|codex-[0-9a-f]{8}-[0-9a-f-]{27,}/u, name);
    for (const match of text.matchAll(/"connectionId":\s*"([^"]+)"/gu)) assert.match(match[1], /^route-[a-f0-9]{24}$/u);
  }
});
