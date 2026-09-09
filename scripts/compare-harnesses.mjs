// Deterministic operational comparison, not a model-quality benchmark.
// Run: node scripts/compare-harnesses.mjs --recurs /installed/bin/recurs --pi /installed/bin/pi
// Optional --only pi exercises the peer before a Recurs candidate is available.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import process from "node:process";
import console from "node:console";
import { setTimeout, clearTimeout } from "node:timers";

const exec = promisify(execFile);
const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const argument = (name) => process.argv.includes(name) ? option(name) : undefined;
const executables = { recurs: argument("--recurs"), pi: argument("--pi") };
const harnesses = argument("--only") ? [argument("--only")] : ["recurs", "pi"];
for (const name of harnesses) assert(executables[name], `Supply --${name} /absolute/executable`);
const root = await realpath(await mkdtemp(path.join(tmpdir(), "recurs-harness-comparison-")));
const marker = "RECOVERY_MARKER_739";
const cases = [
  {
    id: "multifile-bug",
    prompt: "Fix normalization and matching across both modules. Read both modules, fix the two bugs, and run node verify.mjs.",
    files: {
      "normalize.mjs": "export const normalize = value => value.trim();\n",
      "match.mjs": "import { normalize } from './normalize.mjs';\nexport const isMatch = (left, right) => normalize(left) === right;\n",
      "verify.mjs": "import assert from 'node:assert/strict';\nimport { normalize } from './normalize.mjs';\nimport { isMatch } from './match.mjs';\nassert.equal(normalize(' AbC '), 'abc');\nassert.equal(isMatch(' Hello ', ' HELLO '), true);\nassert.equal(isMatch('a', 'b'), false);\nconsole.log('VERIFIER_PASS');\n",
    },
    actions: [
      { kind: "read", file: "normalize.mjs" }, { kind: "read", file: "match.mjs" },
      { kind: "edit", file: "normalize.mjs", before: "export const normalize = value => value.trim();", after: "export const normalize = value => value.trim().toLowerCase();" },
      { kind: "edit", file: "match.mjs", before: "export const isMatch = (left, right) => normalize(left) === right;", after: "export const isMatch = (left, right) => normalize(left) === normalize(right);" },
      { kind: "verify" }, { kind: "final" },
    ],
  },
  {
    id: "interruption-recovery",
    prompt: `Fix twice.mjs and verify it. Retain ${marker} in the conversation for recovery.`,
    files: {
      "twice.mjs": "export const twice = value => value;\n",
      "verify.mjs": "import assert from 'node:assert/strict';\nimport { twice } from './twice.mjs';\nassert.equal(twice(7), 14);\nassert.equal(twice(-2), -4);\nconsole.log('VERIFIER_PASS');\n",
    },
    actions: [
      { kind: "read", file: "twice.mjs" }, { kind: "interrupt" },
      { kind: "read", file: "twice.mjs" },
      { kind: "edit", file: "twice.mjs", before: "export const twice = value => value;", after: "export const twice = value => value * 2;" },
      { kind: "verify" }, { kind: "final" },
    ],
  },
  {
    id: "review-repair",
    prompt: "Read total.mjs and REVIEW.md. Repair the finding without changing the review or verifier, then run node verify.mjs.",
    files: {
      "total.mjs": "export const total = items => items.reduce((sum, item) => sum + item.price, 0);\n",
      "REVIEW.md": "The total ignores item quantity. Multiply each price by quantity. Preserve empty-list behavior.\n",
      "verify.mjs": "import assert from 'node:assert/strict';\nimport { total } from './total.mjs';\nassert.equal(total([{ price: 3, quantity: 2 }, { price: 5, quantity: 0 }]), 6);\nassert.equal(total([]), 0);\nconsole.log('VERIFIER_PASS');\n",
    },
    actions: [
      { kind: "read", file: "total.mjs" }, { kind: "read", file: "REVIEW.md" },
      { kind: "edit", file: "total.mjs", before: "export const total = items => items.reduce((sum, item) => sum + item.price, 0);", after: "export const total = items => items.reduce((sum, item) => sum + item.price * item.quantity, 0);" },
      { kind: "verify" }, { kind: "final" },
    ],
  },
];

function toolCall(harness, action, seed) {
  if (action.kind === "read") return { name: harness === "pi" ? "read" : "read_file", arguments: { path: action.file } };
  if (action.kind === "verify") return { name: harness === "pi" ? "bash" : "run_command", arguments: { command: "node verify.mjs" } };
  if (harness === "pi") return { name: "edit", arguments: { path: action.file, oldText: action.before, newText: action.after } };
  const lines = seed[action.file].trimEnd().split("\n");
  const changed = lines.map((line) => line === action.before ? action.after : line);
  const hunk = lines.flatMap((line, index) => line === changed[index] ? [` ${line}`] : [`-${line}`, `+${changed[index]}`]).join("\n");
  return { name: "apply_patch", arguments: { patch: `diff --git a/${action.file} b/${action.file}\n--- a/${action.file}\n+++ b/${action.file}\n@@ -1,${lines.length} +1,${lines.length} @@\n${hunk}\n`, files: [{ path: action.file, expected_hash: "observed" }] } };
}

let active;
const server = createServer(async (request, response) => {
  if (request.method === "GET") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "matched-fixture" }] })); return;
  }
  try {
    let raw = "";
    for await (const chunk of request) { raw += chunk; if (raw.length > 2_000_000) throw new Error("Request too large"); }
    const body = JSON.parse(raw);
    const index = active.requests.length;
    const action = active.scenario.actions[index];
    active.requests.push({ index, action: action?.kind, messages: body.messages, toolNames: body.tools?.map((tool) => tool.function?.name) });
    if (index >= 8 || action === undefined) throw new Error("Eight-request case budget or prescribed action plan exceeded");
    if (action.kind === "interrupt") { active.interruptReady(); return; }
    if (active.scenario.id === "interruption-recovery" && index === 2) active.recoveredMarker = JSON.stringify(body.messages).includes(marker);
    response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
    const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `fixture-${index}`, object: "chat.completion.chunk", created: 1, model: "matched-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: "assistant" });
    if (action.kind === "final") { emit({ content: "MATCHED_CASE_COMPLETE" }); emit({}, "stop"); }
    else {
      const call = toolCall(active.harness, action, active.scenario.files);
      assert(body.tools.some((tool) => tool.function?.name === call.name), `Tool unavailable: ${call.name}`);
      emit({ tool_calls: [{ index: 0, id: `call_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] });
      emit({}, "tool_calls");
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    active.errors.push(String(error));
    if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: String(error) } }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;

async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(file));
    else result.push(file);
  }
  return result;
}
const results = [];
try {
  for (const harness of harnesses) {
    for (const scenario of cases) {
      const directory = path.join(root, harness, scenario.id);
      const home = path.join(directory, "home");
      const workspace = path.join(directory, "workspace");
      await mkdir(home, { recursive: true }); await mkdir(workspace);
      const env = { HOME: home, USERPROFILE: home, PATH: process.env.PATH, LANG: "en_US.UTF-8", NO_COLOR: "1", PI_SKIP_VERSION_CHECK: "1", PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent"), RECURS_HOME: path.join(home, ".recurs") };
      for (const [name, content] of Object.entries(scenario.files)) await writeFile(path.join(workspace, name), content);
      await exec("git", ["init", "-q"], { cwd: workspace, env });
      await exec("git", ["add", "."], { cwd: workspace, env });
      await exec("git", ["-c", "user.name=Harness Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Seed identical fixture"], { cwd: workspace, env });
      const version = (await exec(executables[harness], ["--version"], { cwd: workspace, env })).stdout.trim();
      if (harness === "pi") {
        await mkdir(env.PI_CODING_AGENT_DIR, { recursive: true });
        await writeFile(path.join(env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: endpoint, api: "openai-completions", apiKey: "fixture-not-a-secret", models: [{ id: "matched-fixture", contextWindow: 32000, maxTokens: 2048, reasoning: false }] } } }));
      } else await exec(executables.recurs, ["setup", "local", "--url", endpoint, "--model", "matched-fixture"], { cwd: workspace, env, timeout: 15000 });
      let interruptReady;
      const interrupt = new Promise((resolve) => { interruptReady = resolve; });
      active = { harness, scenario, requests: [], errors: [], interruptReady, recoveredMarker: null };
      const logs = [];
      function launch(resume) {
        const prompt = resume ? "Continue the interrupted task using the saved conversation. Finish the repair and verifier." : scenario.prompt;
        const args = harness === "pi"
          ? ["--provider", "fixture", "--model", "matched-fixture", "--thinking", "off", "--mode", "json", "-p", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--tools", "read,edit,bash", ...(resume ? ["--session", resume] : []), prompt]
          : ["run", "--format", "jsonl", ...(resume ? ["--resume", resume] : ["--permissions", "full_access"]), prompt];
        const child = spawn(executables[harness], args, { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
        const log = { args, stdout: "", stderr: "" }; logs.push(log);
        child.stdout.on("data", (data) => { log.stdout += data; }); child.stderr.on("data", (data) => { log.stderr += data; });
        const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
        const done = new Promise((resolve) => child.on("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); }));
        return { child, done };
      }
      const start = performance.now();
      let run = launch();
      let interrupted = null;
      if (scenario.id === "interruption-recovery") {
        const ready = await Promise.race([interrupt.then(() => true), run.done.then(() => false)]);
        if (ready) {
          const stop = performance.now(); run.child.kill("SIGINT");
          interrupted = { ...await run.done, latencyMs: Math.round(performance.now() - stop) };
          const sessionFiles = (await filesUnder(home)).filter((file) => file.endsWith(".jsonl") && file.includes("sessions"));
          assert.equal(sessionFiles.length, 1, "Expected exactly one isolated session");
          const first = JSON.parse((await readFile(sessionFiles[0], "utf8")).split("\n")[0]);
          const id = harness === "pi" ? sessionFiles[0] : first.sessionId;
          assert(id, "Recorded session has an exact identifier");
          run = launch(id);
        }
      }
      const exit = await run.done;
      let verifier;
      try { verifier = { passed: true, output: (await exec(process.execPath, ["verify.mjs"], { cwd: workspace, env, timeout: 5000 })).stdout.trim() }; }
      catch (error) { verifier = { passed: false, output: error.stderr?.slice(0, 1000) }; }
      const finalFiles = {};
      for (const file of Object.keys(scenario.files)) finalFiles[file] = createHash("sha256").update(await readFile(path.join(workspace, file))).digest("hex");
      const harnessVerifier = active.requests.some((request) => request.messages.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("VERIFIER_PASS")));
      const verifierUnchanged = finalFiles["verify.mjs"] === createHash("sha256").update(scenario.files["verify.mjs"]).digest("hex");
      const result = { harness, case: scenario.id, version, executableSha256: createHash("sha256").update(await readFile(await realpath(executables[harness]))).digest("hex"), exit, interrupted, requests: active.requests.length, durationMs: Math.round(performance.now() - start), recoveredMarker: active.recoveredMarker, verifier, harnessVerifier, verifierUnchanged, finalFiles, fixtureErrors: active.errors, finalResponse: logs.at(-1).stdout.includes("MATCHED_CASE_COMPLETE") };
      results.push(result);
      await writeFile(path.join(directory, "observations.json"), JSON.stringify({ result, logs, requests: active.requests }, null, 2));
      console.log(JSON.stringify(result));
    }
  }
} finally { server.closeAllConnections(); server.close(); }
const matchedFinalFiles = harnesses.length === 2 ? cases.every((scenario) => {
  const pair = results.filter((result) => result.case === scenario.id);
  return pair.length === 2 && JSON.stringify(pair[0].finalFiles) === JSON.stringify(pair[1].finalFiles);
}) : null;
const report = { kind: "deterministic operational comparison; not a model benchmark", node: process.version, platform: `${process.platform}-${process.arch}`, requestCapPerCase: 8, processTimeoutMs: 20000, root, matchedFinalFiles, results };
await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
console.log(`Report: ${path.join(root, "report.json")}`);
if (matchedFinalFiles === false || results.some((result) => result.exit.code !== 0 || !result.verifier.passed || !result.harnessVerifier || !result.verifierUnchanged || !result.finalResponse || result.fixtureErrors.length || (result.case === "interruption-recovery" && result.recoveredMarker !== true))) process.exitCode = 1;
