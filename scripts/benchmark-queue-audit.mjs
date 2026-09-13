/* global console, URL */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCompanyBenchmarkScenario, initializeCompanyBenchmarkWorkspace, verifyCompanyBenchmarkWorkspace } from "../packages/core/dist/index.js";

// Offline re-evaluation only. Never changes a recorded trial or calls a provider.
const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = JSON.parse(await readFile(path.join(root, "benchmarks/task-fit-results.json"), "utf8"));
const campaign = evidence.campaigns.find(entry => entry.campaign.scenario.id === "queue_cancellation");
const records = [];
for (const trial of campaign.trials) {
  const captured = path.join(root, "benchmarks/task-fit-artifacts/queue_cancellation", trial.slotId);
  const manifest = JSON.parse(await readFile(path.join(captured, "manifest.json"), "utf8"));
  if (manifest.trialId !== trial.id) throw new Error("Capture trial mismatch");
  const scenario = getCompanyBenchmarkScenario("queue_cancellation", 1);
  const workspace = await mkdtemp(path.join(tmpdir(), "recurs-queue-audit-"));
  try {
    const prepared = await initializeCompanyBenchmarkWorkspace({ scenario, workspaceRoot: workspace });
    const hashes = [];
    let unchanged = true;
    for (const fixture of scenario.files) {
      const file = manifest.files.find(item => item.path === fixture.path);
      if (file?.status !== "retained") throw new Error("Incomplete capture");
      const source = path.join(captured, "candidate", fixture.path + ".txt");
      const bytes = await readFile(source);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      if (sha256 !== file.sha256) throw new Error("Capture hash mismatch");
      unchanged &&= bytes.equals(Buffer.from(fixture.content));
      hashes.push({ path: fixture.path, sha256 });
      await copyFile(source, path.join(workspace, fixture.path));
    }
    const original = await verifyCompanyBenchmarkWorkspace({ scenario, workspaceRoot: workspace, baseRevision: prepared.baseRevision });
    const corrected = await verifyCompanyBenchmarkWorkspace({ scenario: getCompanyBenchmarkScenario("queue_cancellation", 2), workspaceRoot: workspace, baseRevision: prepared.baseRevision });
    records.push({ trialId: trial.id, slotId: trial.slotId, executionStatus: trial.executionStatus, originalRecordedVerification: trial.verification, originalReplay: original, correctedReplay: corrected, unchangedFromFixture: unchanged, candidateFiles: hashes });
  } finally { await rm(workspace, { recursive: true, force: true }); }
}
const report = { version: 1, kind: "offline_verifier_amendment", campaignId: campaign.campaign.id, originalVerifierId: "queue_cancellation_hidden_v1", correctedVerifierId: "queue_cancellation_hidden_v2", reason: "Exact add/remove call counts rejected valid repeated cleanup and once-only listeners. The amendment inspects actual retained abort listeners. All four final workspaces are replayed; original records remain unchanged. No model reruns.", stagedCandidates: "Unavailable for the failed team attempt; final-workspace replay cannot assess rejected staged code.", records };
await writeFile(path.join(root, "benchmarks/queue-verifier-audit.json"), JSON.stringify(report, null, 2) + "\n");
console.log(records.map(record => ({ slot: record.slotId, original: record.originalReplay.status, corrected: record.correctedReplay.status, unchanged: record.unchangedFromFixture })));
