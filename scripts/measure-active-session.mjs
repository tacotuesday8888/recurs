// Profile one interactive Recurs session through a real PTY and the V8
// inspector. A deterministic loopback provider streams synthetic replies, so
// no model account is used. Each checkpoint records the terminal process RSS,
// heap usage before a forced full GC, and heap usage after it. Retained heap is
// the post-GC value; the gap to RSS is collector and allocator headroom.
/* global fetch */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import console from "node:console";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { spawn } from "@lydell/node-pty";
import xterm from "@xterm/headless";
import WebSocket from "ws";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const quick = process.argv.includes("--quick");
const executable = path.resolve(option("--executable", path.join(root, "dist/cli/main.js")));
const output = option("--output");
const snapshotDirectory = option("--snapshots");
// Optional profiles cover conversation turns 11-30, after warmup.
const allocationProfile = option("--allocation-profile");
const cpuProfile = option("--cpu-profile");
const workload = {
  conversationTurns: Number(option("--turns", quick ? 20 : 120)),
  linesPerTurn: 160,
  largeOutputTurns: quick ? 1 : 4,
  linesPerLargeTurn: 6_000,
  navigationCycles: quick ? 4 : 40,
  cancellations: quick ? 4 : 20,
  checkpointEvery: 10,
};

const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "recurs-active-session-")));
const home = path.join(temporary, "home");
const workspace = path.join(temporary, "project");
await Promise.all([mkdir(home), mkdir(workspace)]);
await exec("git", ["init", "--quiet", workspace]);
await writeFile(path.join(workspace, "notes.md"), "# Fixture\n");
await exec("git", ["add", "notes.md"], { cwd: workspace });
await exec("git", ["-c", "user.name=Probe", "-c", "user.email=probe@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Seed"], { cwd: workspace });
const environment = {
  HOME: home, USERPROFILE: home, RECURS_HOME: path.join(home, ".recurs"),
  PATH: process.env.PATH, LANG: "en_US.UTF-8", TERM: "xterm-256color",
};

// Deterministic provider. Each prompt shape selects one synthetic workload.
let requests = 0;
const server = createServer(async (request, response) => {
  if (request.method === "GET") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "probe-model" }] }));
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  requests += 1;
  const body = JSON.parse(raw);
  const prompt = String([...body.messages].reverse().find((message) => message.role === "user")?.content ?? "");
  let closed = false;
  response.on("close", () => { closed = true; });
  const turn = /^(turn|large|slow)-(\d+)$/u.exec(prompt);
  const kind = turn?.[1] ?? "turn";
  const id = turn?.[2] ?? "0";
  const lines = kind === "large" ? workload.linesPerLargeTurn : kind === "slow" ? 400 : workload.linesPerTurn;
  const text = Array.from({ length: lines }, (_, index) => `Synthetic ${kind}-${id} line ${index}: bounded output with Unicode 界面🙂.\n`).join("") + `\nPROBE DONE ${kind} ${id}`;
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  const pieces = text.match(/.{1,90}/gsu) ?? [];
  for (const [index, piece] of pieces.entries()) {
    if (closed) return;
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece }, finish_reason: null }] })}\n\n`);
    if (kind === "slow") await delay(15);
    else if (index % 4 === 0) await delay(1);
  }
  response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 25, completion_tokens: 50 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
await exec(process.execPath, [executable, "setup", "local", "--url", baseUrl, "--model", "probe-model"], { cwd: workspace, env: environment });

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

class Inspector {
  #socket; #next = 1; #pending = new Map(); #chunks = null;
  static async connect(port) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        if (targets[0]?.webSocketDebuggerUrl) {
          const inspector = new Inspector();
          inspector.#socket = new WebSocket(targets[0].webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 1 << 30 });
          await new Promise((resolve, reject) => { inspector.#socket.once("open", resolve); inspector.#socket.once("error", reject); });
          inspector.#socket.on("message", (data) => inspector.#receive(JSON.parse(data.toString())));
          return inspector;
        }
      } catch { /* The child may still be starting. */ }
      await delay(50);
    }
    throw new Error("The inspector endpoint did not become available.");
  }
  #receive(message) {
    if (message.method === "HeapProfiler.addHeapSnapshotChunk") { this.#chunks?.write(message.params.chunk); return; }
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
  }
  send(method, params = {}) {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async memory() {
    const result = await this.send("Runtime.evaluate", {
      expression: "JSON.stringify({ memory: process.memoryUsage(), heap: process.getBuiltinModule('node:v8').getHeapStatistics() })",
      returnByValue: true,
    });
    const { memory, heap } = JSON.parse(result.result.value);
    return { rssBytes: memory.rss, heapTotalBytes: memory.heapTotal, heapUsedBytes: memory.heapUsed, externalBytes: memory.external, arrayBuffersBytes: memory.arrayBuffers, mallocedBytes: heap.malloced_memory, peakMallocedBytes: heap.peak_malloced_memory };
  }
  async collect() {
    await this.send("HeapProfiler.enable");
    await this.send("HeapProfiler.collectGarbage");
    await this.send("HeapProfiler.collectGarbage");
  }
  async snapshot(filename) {
    this.#chunks = createWriteStream(filename);
    await this.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: false });
    await new Promise((resolve) => this.#chunks.end(resolve));
    this.#chunks = null;
  }
  close() { this.#socket.close(); }
}

async function launch(args) {
  const port = await freePort();
  const terminal = new xterm.Terminal({ cols: 100, rows: 30, scrollback: 200, allowProposedApi: true });
  const child = spawn(process.execPath, [`--inspect=127.0.0.1:${port}`, "--inspect-publish-uid=http", executable, ...args], { name: "xterm-256color", cols: 100, rows: 30, cwd: workspace, env: environment });
  let exit;
  child.onExit((event) => { exit = event.exitCode; });
  child.onData((data) => terminal.write(data));
  terminal.onData((data) => child.write(data));
  const screen = () => Array.from({ length: terminal.rows }, (_, index) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + index)?.translateToString(true) ?? "").join("\n");
  let inspector;
  const wait = async (predicate, label, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(screen())) return;
      if (exit !== undefined) throw new Error(`${label}: process exited ${exit}\n${screen()}`);
      await delay(20);
    }
    if (process.env.RECURS_PROBE_STALL_PROFILE !== undefined) {
      await inspector.send("Profiler.enable");
      await inspector.send("Profiler.start");
      await delay(3_000);
      const { profile } = await inspector.send("Profiler.stop");
      await writeFile(process.env.RECURS_PROBE_STALL_PROFILE, JSON.stringify(profile));
    }
    throw new Error(`${label}: timed out\n${screen()}`);
  };
  inspector = await Inspector.connect(port);
  const resize = (columns, rows) => { child.resize(columns, rows); terminal.resize(columns, rows); };
  return { child, terminal, screen, wait, inspector, resize, exit: () => exit };
}

// macOS RSS can include pages V8 has already released (MADV_FREE_REUSABLE) and
// omits compressed or swapped pages. The kernel's physical footprint is the
// figure Activity Monitor reports, and it keeps a high-water mark.
async function footprint(pid) {
  if (process.platform === "darwin") {
    const { stdout } = await exec("vmmap", ["--summary", String(pid)], { maxBuffer: 16 * 1024 * 1024 });
    const value = (label) => {
      const match = new RegExp(`^${label}:\\s+([\\d.]+)([KMG])`, "mu").exec(stdout);
      return match === null ? null : Math.round(Number(match[1]) * { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[2]]);
    };
    return { footprintBytes: value("Physical footprint"), peakFootprintBytes: value("Physical footprint \\(peak\\)") };
  }
  if (process.platform === "linux") {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const value = (label) => { const match = new RegExp(`^${label}:\\s+(\\d+) kB`, "mu").exec(status); return match === null ? null : Number(match[1]) * 1024; };
    return { footprintBytes: value("VmRSS"), peakFootprintBytes: value("VmHWM") };
  }
  return { footprintBytes: null, peakFootprintBytes: null };
}

async function processTree(pid) {
  const { stdout } = await exec("ps", ["-axo", "pid=,ppid=,rss="]);
  const rows = stdout.trim().split("\n").map((line) => line.trim().split(/\s+/u).map(Number));
  const owned = new Set([pid]);
  let size;
  do {
    size = owned.size;
    for (const [child, parent] of rows) if (owned.has(parent)) owned.add(child);
  } while (owned.size !== size);
  const members = rows.filter(([child]) => owned.has(child));
  return { rssBytes: (members.find(([child]) => child === pid)?.[2] ?? 0) * 1024, treeRssBytes: members.reduce((sum, row) => sum + row[2] * 1024, 0), processes: members.length };
}

const samples = [];
async function checkpoint(ui, phase, step, snapshotLabel) {
  const beforeGc = await ui.inspector.memory();
  await ui.inspector.collect();
  const afterGc = await ui.inspector.memory();
  const tree = await processTree(ui.child.pid);
  const physical = await footprint(ui.child.pid);
  const sample = { phase, step, elapsedMs: Math.round(performance.now() - started), beforeGc, afterGc, process: { ...tree, ...physical } };
  samples.push(sample);
  const mib = (bytes) => (bytes / 1024 / 1024).toFixed(1);
  console.error(`${phase.padEnd(12)} ${String(step).padStart(4)}  heap used ${mib(beforeGc.heapUsedBytes)} → ${mib(afterGc.heapUsedBytes)} MiB after GC · footprint ${physical.footprintBytes === null ? "n/a" : mib(physical.footprintBytes)} MiB, peak ${physical.peakFootprintBytes === null ? "n/a" : mib(physical.peakFootprintBytes)} MiB · rss ${mib(tree.rssBytes)} MiB`);
  if (snapshotDirectory !== undefined && snapshotLabel !== undefined) {
    await mkdir(snapshotDirectory, { recursive: true });
    await ui.inspector.snapshot(path.join(snapshotDirectory, `${snapshotLabel}.heapsnapshot`));
  }
}

async function send(ui, prompt, marker, timeoutMs) {
  ui.child.write(`${prompt}\r`);
  await ui.wait((screen) => screen.includes(marker) && screen.includes("Parent · ready"), prompt, timeoutMs);
}

const started = performance.now();
const turnTimes = [];
let ui;
try {
  ui = await launch(["setup"]);
  await ui.wait((screen) => screen.includes("Connect a model") && screen.includes("Use primary:"), "connection selection");
  ui.child.write("\r");
  await ui.wait((screen) => screen.includes("Permissions") && screen.includes("Ask Always"), "permission selection");
  ui.child.write("\r");
  await ui.wait((screen) => screen.includes("Start coding"), "quick start");
  ui.child.write("\r");
  await ui.wait((screen) => screen.includes("/ CHAT"), "chat");
  await checkpoint(ui, "idle", 0, "idle");

  for (let turn = 1; turn <= workload.conversationTurns; turn += 1) {
    if (turn === 11 && allocationProfile !== undefined) {
      await ui.inspector.send("HeapProfiler.enable");
      await ui.inspector.send("HeapProfiler.startSampling", { samplingInterval: 16_384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    }
    if (turn === 11 && cpuProfile !== undefined) {
      await ui.inspector.send("Profiler.enable");
      await ui.inspector.send("Profiler.start");
    }
    if (turn === 31 && allocationProfile !== undefined) {
      const { profile } = await ui.inspector.send("HeapProfiler.stopSampling");
      await writeFile(allocationProfile, JSON.stringify(profile));
    }
    if (turn === 31 && cpuProfile !== undefined) {
      const { profile } = await ui.inspector.send("Profiler.stop");
      await writeFile(cpuProfile, JSON.stringify(profile));
    }
    const turnStarted = performance.now();
    await send(ui, `turn-${turn}`, `PROBE DONE turn ${turn}`);
    turnTimes.push(Math.round(performance.now() - turnStarted));
    if (turn === 1) await checkpoint(ui, "conversation", turn, "conversation-first");
    else if (turn % workload.checkpointEvery === 0) await checkpoint(ui, "conversation", turn, turn === workload.conversationTurns ? "conversation-last" : undefined);
  }

  for (let turn = 1; turn <= workload.largeOutputTurns; turn += 1) {
    await send(ui, `large-${turn}`, `PROBE DONE large ${turn}`, 120_000);
    await checkpoint(ui, "large-output", turn, turn === workload.largeOutputTurns ? "large-output" : undefined);
  }

  for (let cycle = 1; cycle <= workload.navigationCycles; cycle += 1) {
    ui.child.write(`draft-${cycle}`);
    await ui.wait((screen) => screen.includes(`draft-${cycle}`), "draft");
    ui.child.write("\u001b[12~");
    await ui.wait((screen) => screen.includes("Appearance"), "appearance");
    ui.child.write("\u001b");
    await ui.wait((screen) => screen.includes(`draft-${cycle}`) && screen.includes("/ CHAT"), "appearance closed");
    ui.child.write("\u0014");
    await ui.wait((screen) => screen.includes("TASKS"), "executions");
    ui.child.write("\u001b");
    await ui.wait((screen) => screen.includes("/ CHAT"), "executions closed");
    ui.child.write("\u0007");
    await ui.wait((screen) => screen.includes("Team"), "team");
    ui.child.write("\u0007");
    await ui.wait((screen) => screen.includes("/ CHAT"), "team closed");
    ui.child.write("\u001b[5~\u001b[5~\u001b[6~\u001b[6~");
    ui.resize(40, 12); await delay(20); ui.resize(100, 30);
    await ui.wait((screen) => screen.includes(`draft-${cycle}`), "draft survives navigation");
    ui.child.write("\u0015");
    if (cycle % workload.checkpointEvery === 0 || cycle === workload.navigationCycles) await checkpoint(ui, "navigation", cycle, cycle === workload.navigationCycles ? "navigation" : undefined);
  }

  for (let attempt = 1; attempt <= workload.cancellations; attempt += 1) {
    ui.child.write(`slow-${attempt}\r`);
    await ui.wait((screen) => screen.includes(`Synthetic slow-${attempt} line 30`), "slow stream started");
    ui.child.write("\u0003");
    await ui.wait((screen) => screen.includes("Parent · ready"), "cancelled turn");
    if (attempt % 5 === 0 || attempt === workload.cancellations) await checkpoint(ui, "cancellation", attempt, attempt === workload.cancellations ? "cancellation" : undefined);
  }

  // An attached inspector keeps Node alive after exit; detach first.
  ui.inspector.close();
  ui.child.write("\u0011");
  await ui.wait(() => ui.exit() !== undefined, "exit");
  ui.terminal.dispose();
  assert.equal(ui.exit(), 0);

  ui = await launch([]);
  await ui.wait((screen) => screen.includes("Current chat"), "session launcher");
  await checkpoint(ui, "restart", 0);
  ui.child.write("\r");
  await ui.wait((screen) => screen.includes("/ CHAT") && screen.includes(`slow-${workload.cancellations}`), "reopened history");
  await checkpoint(ui, "restart", 1, "restart-reopened");
  await send(ui, "turn-9999", "PROBE DONE turn 9999");
  await checkpoint(ui, "restart", 2);
  ui.inspector.close();
  ui.child.write("\u0011");
  await ui.wait(() => ui.exit() !== undefined, "final exit");
  assert.equal(ui.exit(), 0);
} finally {
  ui?.inspector.close();
  if (ui?.exit() === undefined) ui.child.kill();
  await new Promise((resolve) => server.close(resolve));
}

// Validate the workload itself: every prompt must have started a durable turn.
const sessionFiles = [];
async function findSessions(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await findSessions(filename);
    else if (entry.name.endsWith(".jsonl") && path.basename(directory) === "sessions") sessionFiles.push(filename);
  }
}
await findSessions(environment.RECURS_HOME);
const records = (await Promise.all(sessionFiles.map((filename) => readFile(filename, "utf8"))))
  .flatMap((text) => text.trim().split("\n")).map((line) => JSON.parse(line));
const startedTurns = records.filter((record) => record.type === "turn_started").length;
const cancelledTurns = records.filter((record) => record.type === "turn_cancelled").length;
const expectedTurns = workload.conversationTurns + workload.largeOutputTurns + workload.cancellations + 1;
assert.equal(startedTurns, expectedTurns, `expected ${expectedTurns} durable turns, found ${startedTurns}`);
assert.equal(cancelledTurns, workload.cancellations, `expected ${workload.cancellations} cancelled turns, found ${cancelledTurns}`);

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
};
const report = {
  method: "Interactive Recurs session in a real PTY with a deterministic loopback provider. Each checkpoint reads process.memoryUsage() through the V8 inspector, forces two full collections, and reads it again; process RSS comes from ps. Inspector attachment adds a small constant overhead. Not a vendor-model workload or a leak-free proof.",
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  executableSha256: createHash("sha256").update(await readFile(executable)).digest("hex"),
  workload,
  providerRequests: requests,
  durableTurns: { started: startedTurns, cancelled: cancelledTurns },
  turnMs: { median: median(turnTimes), firstTenMedian: median(turnTimes.slice(0, 10)), lastTenMedian: median(turnTimes.slice(-10)), samples: turnTimes },
  samples,
};
if (output !== undefined) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
else console.log(JSON.stringify(report, null, 2));
await rm(temporary, { recursive: true, force: true });
