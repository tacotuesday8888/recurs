// Exercise the exact packed CLI through a real PTY and a VT terminal emulator.
// The local deterministic provider validates harness behavior, not model quality.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import process from "node:process";
import console from "node:console";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { spawn } from "@lydell/node-pty";
import xterm from "@xterm/headless";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "recurs-terminal-")));
const home = path.join(temporary, "home");
const workspace = path.join(temporary, "parser-project");
const prefix = path.join(temporary, "installed");
await Promise.all([mkdir(home), mkdir(workspace)]);
await writeFile(path.join(workspace, "parser.ts"), "export const parse = (input: string) => input.trim();\n");
const environment = { HOME: home, USERPROFILE: home, RECURS_HOME: path.join(home, ".recurs"), PATH: process.env.PATH, LANG: "en_US.UTF-8", TERM: "xterm-256color", NO_COLOR: "1" };
const packed = JSON.parse((await exec("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], { cwd: root })).stdout)[0];
await exec("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--omit=dev", "--no-package-lock", "--no-audit", "--no-fund", "--cache", path.join(temporary, "cache"), path.join(temporary, packed.filename)], { env: environment, timeout: 120_000 });
const executable = path.join(prefix, "node_modules", ".bin", "recurs");
const startupMs = [];
for (let index = 0; index < 5; index += 1) {
  const start = performance.now();
  await exec(executable, ["--version"], { cwd: workspace, env: environment });
  startupMs.push(Math.round(performance.now() - start));
}
async function fileBytes(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await fileBytes(filename);
    else if (entry.isFile()) total += (await stat(filename)).size;
  }
  return total;
}
const measurements = {
  archiveSha256: createHash("sha256").update(await readFile(path.join(temporary, packed.filename))).digest("hex"),
  compressedBytes: packed.size, unpackedBytes: packed.unpackedSize,
  installedFileBytes: await fileBytes(prefix), startupVersionMs: startupMs,
  node: process.version, platform: `${process.platform}-${process.arch}`,
};
let requests = 0;
const server = createServer(async (request, response) => {
  if (request.method === "GET") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "terminal-fixture" }] })); return; }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  requests += 1;
  const prompt = [...body.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const text = String(prompt).includes("long output")
    ? Array.from({ length: 65 }, (_, index) => `Inspection line ${index}: parser boundary checked.\n\n`).join("")
    : "## Parser review\n\nThe parser trims whitespace. Add cases for empty input and surrounding spaces.\n\n```ts\nexpect(parse('  hello  ')).toBe('hello');\nexpect(parse('   ')).toBe('');\n```\n\nTerminal fixture complete.";
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  for (const piece of text.match(/.{1,90}/gs) ?? []) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece }, finish_reason: null }] })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 25, completion_tokens: 50 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
await exec(executable, ["setup", "local", "--url", baseUrl, "--model", "terminal-fixture"], { cwd: workspace, env: environment });
const capture = [];
let current;
const captureStart = performance.now();
async function launch(args) {
  const terminal = new xterm.Terminal({ cols: 100, rows: 30, scrollback: 1000, allowProposedApi: true });
  const process = spawn(executable, args, { name: "xterm-256color", cols: 100, rows: 30, cwd: workspace, env: environment });
  current = process;
  let exit;
  process.onExit((event) => { exit = event.exitCode; });
  process.onData((data) => { capture.push([(performance.now() - captureStart) / 1000, "o", data]); terminal.write(data); });
  terminal.onData((data) => process.write(data));
  const screen = () => Array.from({ length: terminal.rows }, (_, i) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + i)?.translateToString(true) ?? "").join("\n");
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (predicate(screen())) return;
      if (exit !== undefined) throw new Error(`${label}: process exited ${exit}\n${screen()}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error(`${label}: timed out\n${screen()}`);
  };
  return { process, terminal, screen, wait, exit: () => exit };
}
try {
  const ui = await launch(["setup"]);
  await ui.wait((screen) => screen.includes("model connection"), "connection selection");
  ui.process.write("\r");
  await ui.wait((screen) => screen.includes("without asking"), "permission selection");
  ui.process.write("\r");
  await ui.wait((screen) => screen.includes("Start coding"), "quick-start selection");
  ui.process.write("\r");
  await ui.wait((screen) => screen.includes("/ CHAT"), "productive conversation");
  ui.process.write("\u001b[200~Review parser.ts\u001b[201~\r");
  await ui.wait((screen) => screen.includes("Terminal fixture complete."), "streamed Markdown");
  await ui.wait((screen) => screen.includes("Parent · ready"), "completed parent status");
  const transcript = ui.screen();
  ui.process.write("\u001b[200~show long output\u001b[201~\r");
  await ui.wait((screen) => screen.includes("Inspection line 64"), "long output");
  ui.process.write("\u001b[5~");
  await ui.wait((screen) => screen.includes("lines below"), "history scrolling");
  assert(!ui.screen().includes("Inspection line 64"));
  ui.process.resize(32, 10); ui.terminal.resize(32, 10);
  await ui.wait((screen) => screen.includes("Enter") || screen.includes("PgDn"), "small-window input");
  ui.process.resize(100, 30); ui.terminal.resize(100, 30);
  ui.process.write("\u0014");
  await ui.wait((screen) => screen.includes("TASKS"), "execution navigation");
  ui.process.write("\u001b");
  await ui.wait((screen) => screen.includes("/ CHAT"), "return to parent");
  ui.process.write("\u0011");
  await ui.wait(() => ui.exit() !== undefined, "clean exit");
  assert.equal(ui.exit(), 0);
  ui.terminal.dispose();
  const resumed = await launch([]);
  await resumed.wait((screen) => screen.includes("Current chat"), "session launcher");
  resumed.process.write("\r");
  await resumed.wait((screen) => screen.includes("Inspection line 64"), "durable transcript reopening");
  resumed.process.write("\u0011");
  await resumed.wait(() => resumed.exit() !== undefined, "resumed exit");
  resumed.terminal.dispose();
  const escaped = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="940" height="580" viewBox="0 0 940 580"><rect width="940" height="580" rx="12" fill="#11151b"/><text x="20" y="26" fill="#9ba8b8" font-family="monospace" font-size="12">Recurs · installed CLI · deterministic terminal fixture</text><g fill="#e0e6ee" font-family="monospace" font-size="13">${transcript.split("\n").map((line, index) => `<text x="20" y="${54 + index * 17}" xml:space="preserve" textLength="${line.length * 7.8}" lengthAdjust="spacingAndGlyphs">${escaped(line)}</text>`).join("")}</g></svg>`;
  await writeFile(path.join(temporary, "terminal-session.svg"), svg);
  if (process.argv.includes("--update-capture")) await writeFile(path.join(root, "docs/assets/terminal-session.svg"), svg);
  await writeFile(path.join(temporary, "terminal.cast"), [JSON.stringify({ version: 2, width: 100, height: 30, title: "Recurs installed terminal acceptance", env: { TERM: "xterm-256color" } }), ...capture.map((event) => JSON.stringify(event))].join("\n") + "\n");
  console.log(JSON.stringify({ status: "passed", artifact: packed.filename, measurements, requests, checks: ["clean packed install", "saved connection", "first-run quick start", "bracketed paste", "streamed Markdown/code", "long output", "history scroll", "32x10 resize", "execution list", "clean exit", "durable reopen"], capture: temporary }, null, 2));
} finally {
  try { current?.kill(); } catch { /* The child may already have exited. */ }
  server.closeAllConnections(); server.close();
}
