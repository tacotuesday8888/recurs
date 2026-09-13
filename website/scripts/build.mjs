/* global console, process, URL */
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeEvidence } from "../../scripts/benchmark-evidence.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repository = dirname(root);
const source = join(root, "src");
const output = join(root, "dist");

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

for (const file of ["index.html", "styles.css"]) {
  await cp(join(source, file), join(output, file));
}
for (const asset of ["recurs-mark.svg", "terminal-v19-working.svg", "terminal-diff.svg", "terminal-permission.svg"]) {
  await cp(join(repository, "docs/assets", asset), join(output, "assets", asset));
}

const evidenceFiles = ["results.json", "current-results.json"];
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
const { campaignName, context, resultRows, trialDetails, escapeHtml } = await import(new URL("../dist/evidence.js", import.meta.url));
const initial = summary.findLast((campaign) => campaign.complete && campaign.arms.every((arm) => arm.parentMatched));
if (!initial) throw new Error("A complete matched-parent campaign is required for the default view");
const packageInfo = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
const captureSource = await readFile(join(output, "assets/terminal-v19-working.svg"), "utf8");
const captureSize = /<svg\b[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"/u.exec(captureSource);
if (!captureSize) throw new Error("Terminal capture dimensions unavailable");
const replacements = {
  CAMPAIGN_OPTIONS: summary.map((campaign) => `<option value="${escapeHtml(campaign.id)}"${campaign.id === initial.id ? " selected" : ""}>${escapeHtml(campaignName(campaign))}</option>`).join(""),
  CAMPAIGN_CONTEXT: escapeHtml(context(initial)),
  RESULT_ROWS: resultRows(initial),
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

await writeFile(join(output, "404.html"), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Page not found — Recurs</title><h1>Page not found</h1><a href="/">Back to Recurs</a></html>');
await writeFile(join(output, ".nojekyll"), "");
console.log(`Built ${output}`);
