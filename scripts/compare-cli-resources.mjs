// Compare CLI time and memory against one deterministic local model server.
// Protocol: benchmarks/cli-resources/PROTOCOL.md. No provider account is used.
import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import console from "node:console";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const option = (name, fallback) => { const index = process.argv.indexOf(name); return index === -1 ? fallback : process.argv[index + 1]; };
const samples = Number(option("--samples", 5));
const only = option("--only");
const workloadsFilter = option("--workloads");
const output = option("--output");

const LONG_LINES = 6_000;
const replies = {
  short: "The parser splits on commas and trims each entry.\nRESULT-END",
  long: `${Array.from({ length: LONG_LINES }, (_, index) => `Line ${index}: bounded synthetic output with Unicode 界面.`).join("\n")}\nRESULT-END`,
};
const pieces = (text) => text.match(/[\s\S]{1,90}/gu) ?? [];
let mode = "short";
const requests = [];

// One server, three wire protocols; every product receives the same text.
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  requests.push(`${request.method} ${request.url}`);
  const text = replies[mode];
  const sse = (event) => response.write(`${event.event ? `event: ${event.event}\n` : ""}data: ${JSON.stringify(event.data)}\n\n`);
  if (request.method === "GET" && /\/models/u.test(request.url)) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ object: "list", data: [{ id: "bench-model", object: "model", created: 0, owned_by: "bench" }] }));
    return;
  }
  if (request.method !== "POST") { response.writeHead(404).end(); return; }
  const parsed = body === "" ? {} : JSON.parse(body);
  if (/\/messages\/count_tokens/u.test(request.url)) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ input_tokens: 10 }));
    return;
  }
  if (/\/v1\/messages/u.test(request.url)) {
    if (parsed.stream !== true) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "msg_bench", type: "message", role: "assistant", model: parsed.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    sse({ event: "message_start", data: { type: "message_start", message: { id: "msg_bench", type: "message", role: "assistant", model: parsed.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } } });
    sse({ event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
    for (const piece of pieces(text)) sse({ event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } } });
    sse({ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } });
    sse({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } } });
    sse({ event: "message_stop", data: { type: "message_stop" } });
    response.end();
    return;
  }
  if (/\/responses/u.test(request.url)) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const item = { id: "msg_bench", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    sse({ event: "response.created", data: { type: "response.created", response: { id: "resp_bench", status: "in_progress", output: [] } } });
    sse({ event: "response.output_item.added", data: { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } } });
    for (const piece of pieces(text)) sse({ event: "response.output_text.delta", data: { type: "response.output_text.delta", item_id: "msg_bench", output_index: 0, content_index: 0, delta: piece } });
    sse({ event: "response.output_item.done", data: { type: "response.output_item.done", output_index: 0, item } });
    sse({ event: "response.completed", data: { type: "response.completed", response: { id: "resp_bench", status: "completed", output: [item], usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 20 } } } });
    response.end();
    return;
  }
  if (/\/chat\/completions/u.test(request.url)) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const piece of pieces(text)) sse({ data: { id: "chat_bench", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] } });
    sse({ data: { id: "chat_bench", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } } });
    response.end("data: [DONE]\n\n");
    return;
  }
  response.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "recurs-cli-compare-")));
const prompt = "Explain how the parser treats commas.";

async function workspace(name) {
  const directory = path.join(temporary, name, "project");
  await mkdir(directory, { recursive: true });
  await exec("git", ["init", "--quiet", directory]);
  await writeFile(path.join(directory, "README.md"), "Fixture.\n");
  return directory;
}

const baseEnvironment = { PATH: process.env.PATH, LANG: "en_US.UTF-8", TERM: "dumb", NO_COLOR: "1" };
const products = {
  "claude-code": async () => {
    const home = path.join(temporary, "claude", "home");
    await mkdir(home, { recursive: true });
    const cwd = await workspace("claude");
    const env = { ...baseEnvironment, HOME: home, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: "local-bench", CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1" };
    const command = option("--claude", "claude");
    return { command, cwd, env, version: ["--version"], run: ["-p", prompt, "--model", "claude-bench", "--output-format", "text"] };
  },
  codex: async () => {
    const home = path.join(temporary, "codex", "home");
    await mkdir(home, { recursive: true });
    const cwd = await workspace("codex");
    const env = { ...baseEnvironment, HOME: home, CODEX_HOME: path.join(home, ".codex"), BENCH_KEY: "local-bench" };
    await mkdir(env.CODEX_HOME, { recursive: true });
    const command = option("--codex", path.join(root, "node_modules/.bin/codex"));
    const provider = `model_providers.bench={ name = "bench", base_url = "${baseUrl}/v1", wire_api = "responses", env_key = "BENCH_KEY" }`;
    return { command, cwd, env, version: ["--version"], run: ["exec", "--skip-git-repo-check", "-c", provider, "-c", "model_provider=\"bench\"", "-m", "bench-model", prompt] };
  },
  recurs: async () => {
    const home = path.join(temporary, "recurs", "home");
    await mkdir(home, { recursive: true });
    const cwd = await workspace("recurs");
    const env = { ...baseEnvironment, HOME: home, RECURS_HOME: path.join(home, ".recurs") };
    const executable = option("--recurs", path.join(root, "dist/cli/main.js"));
    await exec(process.execPath, [executable, "setup", "local", "--url", `${baseUrl}/v1`, "--model", "bench-model"], { cwd, env });
    return { command: process.execPath, prefix: [executable], cwd, env, version: ["--version"], run: ["run", prompt] };
  },
};

async function measure(product, workload) {
  const args = [...(product.prefix ?? []), ...(workload === "startup" ? product.version : product.run)];
  mode = workload === "long" ? "long" : "short";
  const started = performance.now();
  const child = spawn("/usr/bin/time", ["-l", product.command, ...args], { cwd: product.cwd, env: product.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.on("exit", (exitCode, signal) => { clearTimeout(timer); resolve(exitCode ?? (signal ? `signal ${signal}` : null)); });
  });
  const wallMs = Math.round(performance.now() - started);
  const peak = /(\d+)\s+maximum resident set size/u.exec(stderr);
  const expected = workload === "startup" ? stdout.trim().length > 0 : stdout.includes("RESULT-END");
  const valid = code === 0 && expected && peak !== null;
  return {
    wallMs, peakRssBytes: peak === null ? null : Number(peak[1]), exitCode: code, valid,
    ...(valid ? {} : { reason: code !== 0 ? `exit ${code}: ${stderr.split("\n").filter((line) => line.trim() && !/^\s+\d+\s/u.test(line)).slice(-3).join(" | ").slice(0, 300)}` : "final line missing from output" }),
  };
}

const names = only === undefined ? Object.keys(products) : only.split(",");
const configured = {};
for (const name of names) configured[name] = await products[name]();
const versions = {};
for (const name of names) {
  const product = configured[name];
  const { stdout } = await exec(product.command, [...(product.prefix ?? []), ...product.version], { cwd: product.cwd, env: product.env }).catch((error) => ({ stdout: `unavailable: ${error.message}` }));
  versions[name] = stdout.trim();
}
const workloads = workloadsFilter === undefined ? ["startup", "short", "long"] : workloadsFilter.split(",");
const results = Object.fromEntries(names.map((name) => [name, Object.fromEntries(workloads.map((workload) => [workload, { warmup: null, samples: [] }]))]));
for (const workload of workloads) {
  for (const name of names) results[name][workload].warmup = await measure(configured[name], workload);
  for (let round = 0; round < samples; round += 1) {
    const order = names.map((_, index) => names[(index + round) % names.length]);
    for (const name of order) {
      const sample = await measure(configured[name], workload);
      results[name][workload].samples.push(sample);
      console.error(`${workload.padEnd(8)} ${name.padEnd(12)} ${sample.valid ? "valid  " : "INVALID"} ${String(sample.wallMs).padStart(6)} ms  ${sample.peakRssBytes === null ? "?" : (sample.peakRssBytes / 1048576).toFixed(1)} MiB${sample.reason ? `  ${sample.reason}` : ""}`);
    }
  }
}
const median = (values) => { const sorted = values.filter((value) => value !== null).sort((a, b) => a - b); return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)]; };
const summary = Object.fromEntries(names.map((name) => [name, Object.fromEntries(workloads.map((workload) => {
  const valid = results[name][workload].samples.filter((sample) => sample.valid);
  return [workload, { validSamples: valid.length, medianWallMs: median(valid.map((sample) => sample.wallMs)), medianPeakRssBytes: median(valid.map((sample) => sample.peakRssBytes)) }];
}))]));
const report = {
  protocol: "benchmarks/cli-resources/PROTOCOL.md",
  protocolSha256: createHash("sha256").update(await readFile(path.join(root, "benchmarks/cli-resources/PROTOCOL.md"))).digest("hex"),
  measuredAt: new Date().toISOString(),
  host: `${process.platform}-${process.arch}`,
  node: process.version,
  versions,
  workloads: { startup: "--version", short: "one-sentence reply", long: `${LONG_LINES} lines, ${Buffer.byteLength(replies.long)} bytes in 90-character deltas` },
  samplesPerWorkload: samples,
  summary,
  results,
};
if (output === undefined) console.log(JSON.stringify(report, null, 2)); else await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
server.close();
await rm(temporary, { recursive: true, force: true });
