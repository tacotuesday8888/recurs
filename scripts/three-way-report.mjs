// Aggregate benchmarks/three-way raw records into one report, applying the
// protocol's finished rule to every attempt. Nothing is dropped.
import console from "node:console";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "benchmarks/three-way");
const LIMIT_MS = 300_000;
const read = async (folder) => {
  try {
    const names = (await readdir(path.join(directory, folder))).filter((name) => name.endsWith(".json")).sort();
    return await Promise.all(names.map(async (name) => ({ name, value: JSON.parse(await readFile(path.join(directory, folder, name), "utf8")) })));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};

const productName = { "codex-cli": "Codex CLI", "company-auto": "Recurs team", "single-strong": "Sol alone", "claude-code": "Claude Code" };
const attempts = [];
for (const { name, value } of await read("harness")) {
  const campaign = value.campaign;
  const question = name.startsWith("team-") ? "team-efficiency" : "three-way";
  for (const slot of campaign.armOrder) {
    if (value.trials.some((trial) => trial.slotId === slot.slotId)) continue;
    attempts.push({
      question, product: slot.armId, productName: productName[slot.armId] ?? slot.armId, task: campaign.scenario.id, taskVersion: campaign.scenario.version,
      attempt: slot.repetition, campaignId: campaign.id, validity: "invalid", invalidReason: "declared slot has no recorded trial", finished: false,
      outcome: "not run or interrupted", elapsedMs: null, usageByModel: {}, failures: [],
    });
  }
  for (const trial of value.trials) {
    const deadline = trial.failures.some((failure) => failure.code === "execution_deadline_exceeded");
    const finished = trial.executionStatus === "completed" && !deadline && trial.wallClockMs <= LIMIT_MS &&
      trial.verification.status === "passed" && trial.verification.workspaceIntegrity === "passed";
    const models = new Map();
    for (const role of trial.roles) {
      const model = trial.activatedRoutes.find((route) => route.role === role.role)?.modelId ?? trial.configuredRoutes.find((route) => route.role === role.role)?.modelId ?? "unknown";
      const current = models.get(model) ?? { requests: 0, inputTokens: 0, outputTokens: 0, complete: true };
      current.requests += role.usage.requestsUsed;
      current.inputTokens += role.usage.inputTokens ?? 0;
      current.outputTokens += role.usage.outputTokens ?? 0;
      current.complete &&= role.usage.tokenCoverage === "complete";
      models.set(model, current);
    }
    attempts.push({
      question, product: trial.armId, productName: productName[trial.armId] ?? trial.armId, task: trial.scenario.id, taskVersion: trial.scenario.version,
      attempt: trial.repetition, campaignId: campaign.id, validity: "valid", finished,
      outcome: finished ? "finished" : deadline || trial.wallClockMs > LIMIT_MS ? "time limit" : trial.executionStatus !== "completed" ? `execution ${trial.executionStatus}` : trial.verification.workspaceIntegrity !== "passed" ? "workspace checks failed" : "task checks failed",
      elapsedMs: trial.wallClockMs, usageByModel: Object.fromEntries(models), failures: trial.failures.map((failure) => failure.code),
    });
  }
}
for (const { value } of await read("claude")) {
  const finished = value.validity === "valid" && value.finished && value.elapsedMs <= LIMIT_MS;
  attempts.push({
    question: "three-way", product: "claude-code", productName: "Claude Code", task: value.scenario.id, taskVersion: value.scenario.version,
    attempt: value.attempt, validity: value.validity, ...(value.invalidReason ? { invalidReason: value.invalidReason } : {}), finished,
    outcome: finished ? "finished" : value.validity === "invalid" ? value.invalidReason : value.timedOut || value.elapsedMs > LIMIT_MS ? "time limit" : value.executionStatus !== "completed" ? `execution ${value.executionStatus}` : value.verification.workspaceIntegrity !== "passed" ? "workspace checks failed" : "task checks failed",
    elapsedMs: value.elapsedMs,
    usageByModel: value.reported?.usage ? { [value.reported.model.join("+") || "claude"]: { requests: value.reported.numTurns ?? null, inputTokens: (value.reported.usage.input_tokens ?? 0) + (value.reported.usage.cache_read_input_tokens ?? 0) + (value.reported.usage.cache_creation_input_tokens ?? 0), outputTokens: value.reported.usage.output_tokens ?? 0, complete: true } } : {},
    failures: [],
  });
}
const summary = {};
for (const item of attempts) {
  const key = `${item.question}:${item.productName}`;
  summary[key] ??= { question: item.question, product: item.productName, attempts: 0, finished: 0, invalid: 0 };
  summary[key].attempts += 1;
  summary[key].finished += item.finished ? 1 : 0;
  summary[key].invalid += item.validity === "invalid" ? 1 : 0;
}
const report = { version: 1, protocol: "benchmarks/three-way/PROTOCOL.md", generatedAt: new Date().toISOString(), sourceAudit: "pending", summary: Object.values(summary), attempts };
await writeFile(path.join(directory, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
for (const row of report.summary) console.log(`${row.question.padEnd(16)} ${row.product.padEnd(12)} finished ${row.finished} of ${row.attempts}${row.invalid ? ` (${row.invalid} invalid)` : ""}`);
if (attempts.length === 0) { console.error("No raw records found under benchmarks/three-way/harness or /claude."); process.exitCode = 1; }
