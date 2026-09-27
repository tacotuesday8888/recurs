// Claude Code arm of benchmarks/three-way/PROTOCOL.md: same fixture, objective,
// five-minute execution limit and hidden verifier as the Recurs harness.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import console from "node:console";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const option = (name) => { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; };
const scenarioId = option("--scenario"), version = Number(option("--version")), attempt = Number(option("--attempt")), output = option("--output"), artifacts = option("--artifacts");
if (!scenarioId || !version || !attempt || !output) throw new Error("Usage: --scenario <id> --version <n> --attempt <n> --output <file> [--artifacts <dir>]");
const LIMIT_MS = 300_000;
const core = await import(pathToFileURL(path.join(root, "packages/core/dist/index.js")).href);
const scenario = core.getCompanyBenchmarkScenario(scenarioId, version);
const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "recurs-three-way-claude-")));
const startedAt = new Date();
const started = performance.now();
const prepared = await core.initializeCompanyBenchmarkWorkspace({ scenario, workspaceRoot: workspace });
const args = ["-p", scenario.objective, "--model", "sonnet", "--output-format", "json", "--permission-mode", "acceptEdits",
  "--allowedTools", "Bash(node:*)", "Bash(npm:*)", "--setting-sources", "project", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"];
const child = spawn("claude", args, { cwd: workspace, env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = "", timedOut = false;
child.stdout.on("data", (data) => { stdout += data; });
child.stderr.on("data", (data) => { stderr += data; });
const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5_000).unref(); }, LIMIT_MS);
const exitCode = await new Promise((resolve) => child.on("exit", (code, signal) => resolve(code ?? signal)));
clearTimeout(timer);
const executionMs = Math.round(performance.now() - started);
let reported = null;
try { reported = JSON.parse(stdout.trim().split("\n").at(-1)); } catch { /* Not a completed JSON result. */ }
const usageLimited = /usage limit|rate limit|limit reached|credit balance/iu.test(`${stdout}\n${stderr}`);
// The deadline stops execution, not the check of what it left behind.
const verification = await core.verifyCompanyBenchmarkWorkspace({ scenario, workspaceRoot: workspace, baseRevision: prepared.baseRevision });
const elapsedMs = Math.round(performance.now() - started);
const executionCompleted = !timedOut && exitCode === 0 && reported?.is_error === false;
const finished = executionCompleted && verification.status === "passed";
const files = [];
if (artifacts !== undefined) {
  const directory = path.join(artifacts, `${scenarioId}-claude-code-${attempt}`);
  for (const file of scenario.files) {
    let content = null;
    try { content = await readFile(path.join(workspace, file.path)); } catch { /* Removed by the candidate. */ }
    if (content !== null) {
      await mkdir(path.dirname(path.join(directory, "candidate", `${file.path}.txt`)), { recursive: true });
      await writeFile(path.join(directory, "candidate", `${file.path}.txt`), content);
    }
    files.push({ path: file.path, sha256: content === null ? null : createHash("sha256").update(content).digest("hex") });
  }
}
const record = {
  protocol: "benchmarks/three-way/PROTOCOL.md",
  product: "claude-code", scenario: { id: scenarioId, version, verifierId: scenario.verifierId, fixtureSha256: scenario.fixtureSha256 }, attempt,
  startedAt: startedAt.toISOString(), executionMs, elapsedMs, exitCode, timedOut,
  validity: usageLimited ? "invalid" : "valid", ...(usageLimited ? { invalidReason: "subscription usage limit" } : {}),
  executionStatus: timedOut ? "timed_out" : executionCompleted ? "completed" : "failed",
  verification, finished,
  reported: reported === null ? null : { model: Object.keys(reported.modelUsage ?? {}), numTurns: reported.num_turns ?? null, durationMs: reported.duration_ms ?? null, usage: reported.usage ?? null, estimatedCostUsd: reported.total_cost_usd ?? null },
  candidateFiles: files,
};
await writeFile(output, `${JSON.stringify(record, null, 2)}\n`);
console.error(`claude-code ${scenarioId} #${attempt}: ${finished ? "FINISHED" : "not finished"} · ${record.executionStatus} · verification ${verification.status} · ${(executionMs / 1000).toFixed(1)} s${usageLimited ? " · USAGE LIMIT" : ""}`);
await rm(workspace, { recursive: true, force: true });
