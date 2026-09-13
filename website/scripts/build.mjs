/* global console, process, URL */
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeEvidence } from "../../scripts/benchmark-evidence.mjs";
import ts from "typescript";
import { RECURS_BRAND } from "../../scripts/recurs-brand.mjs";
import { buildProductComparison } from "./product-comparison-build.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repository = dirname(root);
const source = join(root, "src");
const output = join(root, ".build");

await rm(output, { recursive: true, force: true });
await mkdir(join(output, "assets"), { recursive: true });
const compiler = spawn(process.execPath, [join(repository, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.json"), "--pretty", "false"], { stdio: "inherit" });
const compilerResult = await new Promise((resolve) => {
  compiler.once("error", () => resolve({ kind: "error" }));
  compiler.once("exit", (code) => resolve({ kind: "exit", code }));
});
if (compilerResult.kind === "error") {
  console.error("Website build failed: TypeScript compiler could not start.");
  process.exit(1);
}
if (compilerResult.code !== 0) process.exit(compilerResult.code ?? 1);
const terminalArt = await readFile(join(repository, "packages/cli/src/terminal-opening-art.ts"), "utf8");
await writeFile(join(output, "terminal-opening-art.js"), ts.transpileModule(terminalArt, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText);

await cp(join(source, "index.html"), join(output, "index.html"));
const brandVariables = Object.entries(RECURS_BRAND.palette)
  .map(([name, color]) => `--recurs-${name}: ${color};`).join(" ");
await writeFile(join(output, "styles.css"),
  `/* Palette generated from scripts/recurs-brand.mjs. */\n:root { ${brandVariables} }\n${await readFile(join(source, "styles.css"), "utf8")}\n${await readFile(join(source, "product-comparison.css"), "utf8")}`);
for (const asset of ["recurs-mark.svg", "recurs-wordmark.svg", "terminal-patch.svg", "terminal-v19-working.svg", "terminal-diff.svg", "terminal-permission.svg", "terminal-workflow.mp4", "terminal-workflow.json"]) {
  await cp(join(repository, "docs/assets", asset), join(output, "assets", asset));
}

const evidenceFiles = ["results.json", "current-results.json", "task-fit-results.json", "task-fit-corrected-results.json"];
const sets = await Promise.all(evidenceFiles.map(async (file) =>
  JSON.parse(await readFile(join(repository, "benchmarks", file), "utf8"))));
const summary = sets.flatMap((evidence) => summarizeEvidence(evidence).map((campaign) => ({
  ...campaign,
  evidenceKind: evidence.kind,
  sourceRevision: evidence.selection.sourceRevision,
  sourceState: evidence.selection.sourceState ?? "Historical Round 2",
  artifactSha256: evidence.selection.executedArtifactSha256 ?? null,
  trials: evidence.campaigns.find((entry) => entry.campaign.id === campaign.id).trials,
})));
const { campaignName, context, resultRows, pairedRows, pilotOverview, trialDetails, escapeHtml } = await import(new URL("../.build/evidence.js", import.meta.url));
const initial = summary.find((campaign) => campaign.scenario === "options_precedence") ?? summary.findLast((campaign) => campaign.complete && campaign.arms.every((arm) => arm.parentMatched));
if (!initial) throw new Error("A complete matched-parent campaign is required for the default view");
const packageInfo = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
const captureSource = await readFile(join(output, "assets/terminal-patch.svg"), "utf8");
const captureSize = /<svg\b[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/u.exec(captureSource);
if (!captureSize) throw new Error("Terminal capture dimensions unavailable");
const { chartMetrics, chartCampaigns, chartTaskName, renderChart } = await import(new URL("../.build/charts.js", import.meta.url));
const { terminalLetterSvg } = await import(new URL("../.build/letter.js", import.meta.url));
const { taskResults } = await import(new URL("../.build/results.js", import.meta.url));
const { parseProductComparison, renderProductComparison } = await import(new URL("../.build/product-comparison.js", import.meta.url));
const productComparison = await buildProductComparison({
  dataPath: join(repository, "benchmarks/product-comparison/website-results.json"),
  reviewFindingPath: join(repository, "benchmarks/product-comparison/review-finding.json"),
  outputPath: output,
  parse: parseProductComparison,
  render: renderProductComparison,
});
const replacements = {
  BENCHMARKS_TARGET: productComparison ? "#product-comparison" : "./task-fit-results.md",
  PRODUCT_COMPARISON: productComparison,
  HISTORICAL_EVIDENCE_TITLE: productComparison ? "Earlier tests inside Recurs" : "What happened in our tests?",
  TASK_RESULTS: taskResults(summary),
  TERMINAL_R: terminalLetterSvg(),
  CHART_TASK_OPTIONS: chartCampaigns(summary).map(campaign => `<option value="${escapeHtml(campaign.id)}"${campaign.id === initial.id ? " selected" : ""}>${escapeHtml(chartTaskName(campaign))}</option>`).join(""),
  CHART_METRIC_OPTIONS: Object.entries(chartMetrics).map(([value, label]) => `<option value="${value}">${label}</option>`).join(""),
  CHART: renderChart(initial, "runtime"),
  CAMPAIGN_OPTIONS: summary.map((campaign) => `<option value="${escapeHtml(campaign.id)}"${campaign.id === initial.id ? " selected" : ""}>${escapeHtml(campaignName(campaign))}</option>`).join(""),
  CAMPAIGN_CONTEXT: escapeHtml(context(initial)),
  RESULT_ROWS: resultRows(initial),
  PAIRED_ROWS: pairedRows(initial),
  PILOT_OVERVIEW: pilotOverview(summary),
  TRIAL_DETAILS: trialDetails(initial),
  VERSION: escapeHtml(packageInfo.version),
  TERMINAL_WIDTH: captureSize[1],
  TERMINAL_HEIGHT: captureSize[2],
};
let html = await readFile(join(output, "index.html"), "utf8");
for (const [key, value] of Object.entries(replacements)) html = html.replaceAll(`{{${key}}}`, value);
if (/\{\{[A-Z_]+\}\}/u.test(html)) throw new Error("Unresolved website template");
await writeFile(join(output, "index.html"), html);
await writeFile(join(output, "summary.json"), `${JSON.stringify(summary)}\n`);
for (const file of evidenceFiles) await cp(join(repository, "benchmarks", file), join(output, file));

for (const [source, target] of [["TASK_FIT_PROTOCOL.md", "task-fit-protocol.md"], ["TASK_FIT_CORRECTION.md", "task-fit-correction.md"], ["queue-verifier-audit.json", "queue-verifier-audit.json"], ["workspace-v2-verifier-audit.json", "workspace-v2-verifier-audit.json"], ["TASK_FIT_RESULTS.md", "task-fit-results.md"], ["TASK_FIT_STARTUP_AMENDMENT.md", "task-fit-startup-amendment.md"]]) await cp(join(repository, "benchmarks", source), join(output, target));

await writeFile(join(output, "404.html"), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Page not found — Recurs</title><h1>Page not found</h1><a href="/">Back to Recurs</a></html>');
await writeFile(join(output, ".nojekyll"), "");
console.log(`Built ${output}`);
