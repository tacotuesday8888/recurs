/* global process, console, URL */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  parseCompanyBenchmarkCampaign,
  parseCompanyBenchmarkTrial,
  parseCompanyBenchmarkSlotSettlement,
} from "../packages/contracts/dist/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = isDeepStrictEqual;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const passed = (trial) => trial.executionStatus === "completed" &&
  trial.verification.status === "passed" && trial.verification.workspaceIntegrity === "passed";

// A one-way, stable alias preserves exact route equality without publishing local IDs.
function publicRecord(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => key === "connectionId"
    ? `route-${digest(item).slice(0, 24)}` : item));
}

export function validateEvidence(evidence) {
  assert(evidence.version === 1 && evidence.kind === "historical_model_backed", "Unsupported evidence");
  const ids = new Set();
  for (const entry of evidence.campaigns) {
    const campaign = parseCompanyBenchmarkCampaign(entry.campaign);
    assert(!ids.has(campaign.id), "Duplicate campaign");
    ids.add(campaign.id);
    const arms = [campaign.baseline, ...campaign.companyArms];
    const slots = new Map(campaign.armOrder.map((slot) => [slot.slotId, slot]));
    const trials = new Map();
    for (const raw of entry.trials) {
      const trial = parseCompanyBenchmarkTrial(raw);
      const slot = slots.get(trial.slotId);
      const arm = arms.find((item) => item.id === trial.armId);
      assert(trial.campaignId === campaign.id && slot?.armId === trial.armId &&
        slot.repetition === trial.repetition && trial.armKind === arm?.kind, "Trial slot mismatch");
      assert(!trials.has(trial.slotId), "Duplicate trial slot");
      assert(same(trial.scenario, campaign.scenario) &&
        same(trial.blueprint, arm.kind === "company" ? campaign.blueprint : null) &&
        trial.harnessRevision === campaign.harnessRevision &&
        trial.launchProtocolRevision === campaign.launchProtocolRevision &&
        same(trial.configuredRoutes, arm.configuredRoutes), "Trial authority mismatch");
      assert(trial.activatedRoutes.every((route) => arm.configuredRoutes.some((configured) => same(route, configured))), "Unconfigured activated route");
      trials.set(trial.slotId, trial);
    }
    const settled = new Set();
    for (const raw of entry.settlements) {
      const settlement = parseCompanyBenchmarkSlotSettlement(raw);
      assert(settlement.campaignId === campaign.id && slots.has(settlement.slotId), "Settlement slot mismatch");
      assert(!settled.has(settlement.slotId), "Duplicate settlement slot");
      settled.add(settlement.slotId);
      const trial = trials.get(settlement.slotId);
      if (settlement.status === "completed") {
        assert(trial?.id === settlement.trialId &&
          trial.usage.requestsUsed === settlement.requestsCharged &&
          trial.usage.reportedCostUsd === settlement.reportedCostUsd &&
          Date.parse(settlement.settledAt) >= Date.parse(trial.completedAt), "Settlement does not back trial");
      } else assert(trial === undefined, "Failed settlement has a trial");
    }
    assert([...trials.keys()].every((slot) => settled.has(slot)), "Unsettled trial");
    assert(settled.size === slots.size, "Missing settlement: retain incomplete evidence explicitly");
  }
  return evidence;
}

const sum = (values) => values.reduce((a, b) => a + b, 0);
const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const totalWhenComplete = (trials, coverage, field) => trials.length > 0 &&
  trials.every((trial) => trial.usage[coverage] === "complete" && trial.usage[field] !== null)
  ? sum(trials.map((trial) => trial.usage[field])) : null;

export function summarizeEvidence(evidence) {
  validateEvidence(evidence);
  return evidence.campaigns.map(({ campaign, trials, settlements }) => ({
    id: campaign.id,
    date: campaign.createdAt.slice(0, 10),
    scenario: campaign.scenario.id,
    harnessRevision: campaign.harnessRevision,
    plannedSlots: campaign.armOrder.length,
    recordedTrials: trials.length,
    settledSlots: settlements.length,
    complete: trials.length === campaign.armOrder.length,
    arms: [campaign.baseline, ...campaign.companyArms].map((arm) => {
      const selected = trials.filter((trial) => trial.armId === arm.id);
      const parent = arm.configuredRoutes.find((route) => route.role === "parent");
      return {
        id: arm.id,
        routes: arm.configuredRoutes,
        parentMatched: same(parent, campaign.baseline.configuredRoutes[0]),
        planned: campaign.armOrder.filter((slot) => slot.armId === arm.id).length,
        recorded: selected.length,
        passed: selected.filter(passed).length,
        medianWallClockMs: median(selected.map((trial) => trial.wallClockMs)),
        requests: sum(selected.map((trial) => trial.usage.requestsUsed)),
        inputTokens: totalWhenComplete(selected, "tokenCoverage", "inputTokens"),
        outputTokens: totalWhenComplete(selected, "tokenCoverage", "outputTokens"),
        cachedInputTokens: totalWhenComplete(selected, "tokenCoverage", "cachedInputTokens"),
        reportedCostUsd: totalWhenComplete(selected, "costCoverage", "reportedCostUsd"),
        confirmationRequests: sum(selected.map((trial) => trial.interventions.externalConfirmationRequests)),
        userInputRequests: sum(selected.map((trial) => trial.interventions.userInputRequests)),
        falseApprovals: selected.filter((trial) => trial.review.finalVerdict === "approved" && !passed(trial)).length,
        repairAttempts: sum(selected.map((trial) => trial.roles.find((role) => role.role === "repair")?.attempts ?? 0)),
      };
    }),
  }));
}

export async function exportEvidence(dataDirectory, selection) {
  const directory = path.join(dataDirectory, "evaluations/company-proof-v1");
  const readRecords = async (folder) => Promise.all((await readdir(path.join(directory, folder)))
    .filter((name) => name.endsWith(".json")).sort().map(async (name) =>
      JSON.parse(await readFile(path.join(directory, folder, name), "utf8"))));
  const [campaigns, trials, settlements] = await Promise.all([
    readRecords("campaigns"), readRecords("trials"), readRecords("settlements"),
  ]);
  const entries = selection.campaignIds.map((id) => {
    const campaign = campaigns.find((record) => record.id === id);
    assert(campaign, "Selected campaign unavailable");
    const records = {
      campaign: parseCompanyBenchmarkCampaign(campaign),
      trials: trials.filter((trial) => trial.campaignId === id).map(parseCompanyBenchmarkTrial).sort((a, b) => a.slotId.localeCompare(b.slotId, "en")),
      settlements: settlements.filter((item) => item.campaignId === id).map(parseCompanyBenchmarkSlotSettlement).sort((a, b) => a.slotId.localeCompare(b.slotId, "en")),
    };
    return { sourceSha256: digest(records), ...publicRecord(records) };
  });
  return validateEvidence({
    version: 1,
    kind: "historical_model_backed",
    selection,
    // No prompts, auth files, environment, account identities, or raw model output are read.
    redactions: ["Local connection IDs replaced with stable SHA-256 aliases"],
    campaigns: entries,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  try {
    if (action === "export") {
      assert(args.length === 0 || args.length === 2 && args[0] === "--recurs-home", "Use export [--recurs-home path]");
      const selection = JSON.parse(await readFile(path.join(root, "benchmarks/selection.json"), "utf8"));
      const evidence = await exportEvidence(args[1] ?? process.env.RECURS_HOME ?? path.join(homedir(), ".recurs"), selection);
      await writeFile(path.join(root, "benchmarks/results.json"), `${JSON.stringify(evidence, null, 2)}\n`);
      console.log(`Exported ${evidence.campaigns.length} campaigns; no provider requests.`);
    } else {
      assert(action === "check" && args.length === 0, "Use benchmark-evidence.mjs export|check");
      const evidence = JSON.parse(await readFile(path.join(root, "benchmarks/results.json"), "utf8"));
      const selection = JSON.parse(await readFile(path.join(root, "benchmarks/selection.json"), "utf8"));
      assert(same(evidence.selection, selection) && same(evidence.campaigns.map((entry) => entry.campaign.id), selection.campaignIds), "Evidence selection drift");
      console.log(JSON.stringify(summarizeEvidence(evidence), null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Evidence validation failed");
    process.exitCode = 1;
  }
}
