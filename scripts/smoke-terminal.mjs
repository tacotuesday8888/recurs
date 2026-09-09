// Exercise the exact packed CLI through a real PTY and a VT terminal emulator.
// The local deterministic provider validates harness behavior, not model quality.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import process from "node:process";
import console from "node:console";
import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers";
import { execFile, spawn as spawnProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { spawn } from "@lydell/node-pty";
import xterm from "@xterm/headless";
import { parseSingleNpmPackReport } from "./npm-pack-report.mjs";

const interactive = process.argv.includes("--interactive");
if (interactive && (!process.stdin.isTTY || !process.stdout.isTTY)) {
  console.error("Run the UI walkthrough in an interactive terminal.");
  process.exit(1);
}
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "recurs-terminal-")));
const home = path.join(temporary, "home");
const workspace = path.join(temporary, "parser-project");
const prefix = path.join(temporary, "installed");
await Promise.all([mkdir(home), mkdir(workspace)]);
await exec("git", ["init", "--quiet", workspace]);
await writeFile(path.join(workspace, "parser.ts"), "export const parse = (input: string) => input.trim();\n");
const environment = { HOME: home, USERPROFILE: home, RECURS_HOME: path.join(home, ".recurs"), PATH: process.env.PATH, LANG: "en_US.UTF-8", TERM: "xterm-256color", NO_COLOR: "1" };
let executable = path.join(root, "dist/cli/main.js");
let measurements;
let packed;
if (!interactive) {
  packed = parseSingleNpmPackReport((await exec("npm", ["pack", "--ignore-scripts", "--json", "--cache", path.join(temporary, "cache"), "--pack-destination", temporary], { cwd: root })).stdout);
  await exec("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--omit=dev", "--no-package-lock", "--no-audit", "--no-fund", "--cache", path.join(temporary, "cache"), path.join(temporary, packed.filename)], { env: environment, timeout: 120_000 });
  executable = path.join(prefix, "node_modules", ".bin", "recurs");
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
  measurements = {
    archiveSha256: createHash("sha256").update(await readFile(path.join(temporary, packed.filename))).digest("hex"),
    compressedBytes: packed.size, unpackedBytes: packed.unpackedSize,
    installedFileBytes: await fileBytes(prefix), startupVersionMs: startupMs,
    node: process.version, platform: `${process.platform}-${process.arch}`,
  };
}
let requests = 0;
let releaseChild;
const childGate = new Promise((resolve) => { releaseChild = resolve; });
const server = createServer(async (request, response) => {
  if (request.method === "GET") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "terminal-fixture" }] })); return; }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  requests += 1;
  const prompt = [...body.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const childPrompt = String(prompt).includes("Child terminal inspection");
  const delegationPrompt = String(prompt).includes("Inspect with terminal child");
  if (childPrompt || delegationPrompt) {
    const lastUser = body.messages.findLastIndex((message) => message.role === "user");
    const results = body.messages.slice(lastUser + 1).filter((message) => message.role === "tool");
    if (results.length === 0) {
      const call = childPrompt ? { name: "read_file", arguments: JSON.stringify({ path: "parser.ts" }) }
        : { name: "delegate_task", arguments: JSON.stringify({ profile: "explore", description: "Inspect parser boundaries", prompt: "Child terminal inspection: read parser.ts and report the boundary behavior." }) };
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: childPrompt ? "child-read" : "delegate-inspection", type: "function", function: call }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (childPrompt) {
      await childGate;
      if (process.argv.includes("--interactive")) await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  if (String(prompt).includes("Apply terminal fixture patch")) {
    const lastUser = body.messages.findLastIndex((message) => message.role === "user");
    const results = body.messages.slice(lastUser + 1).filter((message) => message.role === "tool");
    if (results.length < 2) {
      const call = results.length === 0
        ? { name: "read_file", arguments: JSON.stringify({ path: "parser.ts" }) }
        : { name: "apply_patch", arguments: JSON.stringify({ patch: "--- a/parser.ts\n+++ b/parser.ts\n@@ -1 +1,2 @@\n-export const parse = (input: string) => input.trim();\n+// Normalize whitespace at the parser boundary.\n+export const parse = (input: string) => input.trim();\n", files: [{ path: "parser.ts", expected_hash: "observed" }] }) };
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `fixture-${results.length}`, type: "function", function: call }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
  }
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
if (interactive) {
  const design = process.argv[process.argv.indexOf("--design") + 1];
  const selectedDesign = process.argv.includes("--design") && design === "v19" ? "v19" : "r";
  await writeFile(path.join(home, ".recurs/config/appearance.json"), JSON.stringify({ version: 1, theme: "orange", design: selectedDesign }), { mode: 0o600 });
  releaseChild();
  console.log("Recurs UI walkthrough · isolated fixture workspace · no API account needed");
  console.log("Try: Apply terminal fixture patch · Inspect with terminal child · show long output");
  console.log("F2: colors · F3: permissions · Ctrl+G: team · Ctrl+T: executions · Ctrl+Q: exit");
  const child = spawnProcess(executable, process.argv.includes("--setup") ? ["setup"] : [], { cwd: workspace, env: Object.fromEntries(Object.entries({ ...environment, NO_COLOR: undefined }).filter(([, value]) => value !== undefined)), stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)); });
  await new Promise((resolve) => server.close(resolve));
  process.exit(code);
}
const capture = [];
let current;
const captureStart = performance.now();
async function launch(args, overrides = {}) {
  const terminal = new xterm.Terminal({ cols: 100, rows: 30, scrollback: 1000, allowProposedApi: true });
  const env = Object.fromEntries(Object.entries({ ...environment, ...overrides }).filter(([, value]) => value !== undefined));
  const process = spawn(executable, args, { name: "xterm-256color", cols: 100, rows: 30, cwd: workspace, env });
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
const escapeXml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
// Serialize terminal cell attributes; coalesce backgrounds to avoid raster seams.
function cellColor(cell, foreground) {
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) return `#${value.toString(16).padStart(6, "0")}`;
  if (foreground ? cell.isFgPalette() : cell.isBgPalette()) {
    const ansi = ["000000", "cd0000", "00cd00", "cdcd00", "0000ee", "cd00cd", "00cdcd", "e5e5e5", "7f7f7f", "ff0000", "00ff00", "ffff00", "5c5cff", "ff00ff", "00ffff", "ffffff"];
    if (value < 16) return `#${ansi[value]}`;
    const rgb = value < 232 ? [Math.floor((value - 16) / 36), Math.floor((value - 16) / 6) % 6, (value - 16) % 6].map((part) => part === 0 ? 0 : 55 + part * 40) : [0, 0, 0].map(() => 8 + (value - 232) * 10);
    return `#${rgb.map((part) => part.toString(16).padStart(2, "0")).join("")}`;
  }
  return foreground ? "#e5e7eb" : "#111827";
}
async function captureColorScreen(ui, name) {
  const backgrounds = []; const glyphs = [];
  for (let row = 0; row < ui.terminal.rows; row++) {
    const line = ui.terminal.buffer.active.getLine(ui.terminal.buffer.active.viewportY + row);
    let start = 0; let lastBackground;
    const y = 40 + row * 18;
    for (let column = 0; column <= ui.terminal.cols; column++) {
      const cell = column < ui.terminal.cols ? line?.getCell(column) : undefined;
      const background = cell === undefined ? undefined : cellColor(cell, false);
      if (background !== lastBackground) {
        if (lastBackground !== undefined) backgrounds.push(`<rect x="${16 + start * 8}" y="${y - 14}" width="${(column - start) * 8}" height="18" fill="${lastBackground}"/>`);
        start = column; lastBackground = background;
      }
      if (!cell || cell.getWidth() === 0 || !cell.getChars().trim()) continue;
      glyphs.push(`<text x="${16 + column * 8}" y="${y}" fill="${cellColor(cell, true)}"${cell.isBold() ? ' font-weight="bold"' : ""}${cell.isDim() ? ' opacity="0.65"' : ""}>${escapeXml(cell.getChars())}</text>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="832" height="586"><rect width="832" height="586" rx="10" fill="#111827"/><text x="16" y="18" fill="#9ca3af" font-family="monospace" font-size="11">Recurs · actual installed terminal · ${escapeXml(name)}</text><g shape-rendering="crispEdges">${backgrounds.join("")}</g><g font-family="monospace" font-size="13">${glyphs.join("")}</g></svg>`;
  await writeFile(path.join(temporary, `terminal-${name}.svg`), svg);
  if (process.argv.includes("--update-capture")) await writeFile(path.join(root, "docs/assets", `terminal-${name}.svg`), svg);
}

try {
  const motion = await launch(["setup"], { NO_COLOR: undefined });
  await motion.wait((screen) => screen.includes("model connection"), "animated onboarding connection selection");
  const firstFrame = motion.screen();
  await new Promise((resolve) => setTimeout(resolve, 640));
  assert.notEqual(motion.screen(), firstFrame, "onboarding R must visibly rotate while waiting for input");
  motion.process.write("\u001b");
  await motion.wait(() => motion.exit() !== undefined, "animated onboarding cancellation");
  assert.equal(motion.exit(), 130);
  motion.terminal.dispose();
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
  ui.process.write("/model\r");
  await ui.wait((screen) => screen.includes("Esc cancel") && screen.includes("terminal-fixture"), "saved model picker");
  ui.process.write("\u001b");
  await ui.wait((screen) => screen.includes("/ CHAT"), "cancel model picker");
  ui.process.write("/permissions ask\r");
  await ui.wait((screen) => screen.includes("Permission mode: Ask Always"), "initial permission boundary");
  ui.process.write("\u001b[13~");
  await ui.wait((screen) => screen.includes("Permissions · this session"), "permission keyboard picker");
  ui.process.write("\u001b[B\r");
  await ui.wait((screen) => screen.includes("Permission mode: Approved for Me"), "permission selection applied");
  ui.process.write("/permissions full\r");
  await ui.wait((screen) => screen.includes("APPROVAL REQUIRED"), "full access confirmation");
  ui.process.write("\u001b");
  await ui.wait((screen) => screen.includes("Full Access was not enabled"), "escape denies full access");
  ui.process.write("/permissions ask\r");
  await ui.wait((screen) => screen.includes("Permission mode: Ask Always"), "restore permission boundary");
  ui.process.write("\u0007");
  await ui.wait((screen) => screen.includes("Team"), "team floor before children");
  ui.process.write("\u0007");
  await ui.wait((screen) => screen.includes("/ CHAT"), "team returns to conversation");
  ui.process.write("Draft stays here");
  ui.process.write("\u001b[12~");
  await ui.wait((screen) => screen.includes("Appearance"), "theme keyboard picker");
  ui.process.write("\u001b[B");
  ui.process.write("\u001b");
  await ui.wait((screen) => screen.includes("Draft stays here") && screen.includes("/ CHAT"), "theme cancellation preserves draft");
  ui.process.write("\u0015/theme light\r");
  await ui.wait((screen) => screen.includes("Appearance: light (saved)"), "theme saved without color");
  assert.equal(JSON.parse(await readFile(path.join(home, ".recurs/config/appearance.json"), "utf8")).theme, "light");
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
  const colorful = await launch([], { NO_COLOR: undefined, RECURS_REDUCED_MOTION: "1" });
  await colorful.wait((screen) => screen.includes("Current chat"), "colored launcher");
  colorful.process.write("\r");
  await colorful.wait((screen) => screen.includes("/ CHAT"), "saved light theme reopen");
  assert.equal(colorful.terminal.buffer.active.getLine(0).getCell(0).getBgColor(), 0xffffff);
  colorful.process.write("/new\r");
  await colorful.wait((screen) => screen.includes("/ CHAT") && !screen.includes("Inspection line 64"), "fresh colored conversation");
  colorful.process.write("Review parser.ts\r");
  await colorful.wait((screen) => screen.includes("Terminal fixture complete.") && screen.includes("Parent · ready"), "colored Markdown and code");
  await captureColorScreen(colorful, "light");
  colorful.process.write("/theme dark\r");
  await colorful.wait((screen) => screen.includes("Appearance: dark (saved)"), "live dark theme");
  assert.equal(colorful.terminal.buffer.active.getLine(0).getCell(0).getBgColor(), 0x111827);
  await captureColorScreen(colorful, "dark");
  colorful.process.write("/theme orange\r");
  await colorful.wait((screen) => screen.includes("Appearance: orange (saved)"), "live orange theme");
  assert.equal(colorful.terminal.buffer.active.getLine(0).getCell(0).getBgColor(), 0x191714);
  await captureColorScreen(colorful, "orange");
  colorful.process.write("\u001b[12~");
  await colorful.wait((screen) => screen.includes("Appearance · preview"), "color palette preview");
  await captureColorScreen(colorful, "appearance");
  colorful.process.write("\u001b");
  await colorful.wait((screen) => screen.includes("/ CHAT"), "leave color palette");
  colorful.process.write("/new\r");
  await colorful.wait((screen) => screen.includes("One task. A team you control."), "native opening");
  await captureColorScreen(colorful, "opening");
  colorful.process.write("/permissions ask\r");
  await colorful.wait((screen) => screen.includes("Permission mode: Ask Always"), "fixture ask permission");
  colorful.process.write("Apply terminal fixture patch\r");
  await colorful.wait((screen) => screen.includes("PERMISSION REQUIRED"), "real patch approval");
  await captureColorScreen(colorful, "permission");
  colorful.process.write("yes\r");
  await colorful.wait((screen) => screen.includes("observed patch lines") && screen.includes("Parent · ready"), "applied patch activity");
  assert((await readFile(path.join(workspace, "parser.ts"), "utf8")).startsWith("// Normalize whitespace"));
  assert(colorful.screen().includes("+2") && colorful.screen().includes("−1"));
  await captureColorScreen(colorful, "patch");
  colorful.process.write("\u0014");
  await colorful.wait((screen) => screen.includes("TASKS"), "orange execution list");
  await captureColorScreen(colorful, "executions");
  colorful.process.write("\u001b");
  await colorful.wait((screen) => screen.includes("/ CHAT"), "return from orange execution list");
  colorful.process.write("Inspect with terminal child\r");
  await colorful.wait((screen) => screen.includes("explore") || screen.includes("delegate_task"), "child delegation starts");
  colorful.process.write("\u0014");
  await colorful.wait((screen) => screen.includes("explore") && screen.includes("RUNNING"), "live child execution");
  await captureColorScreen(colorful, "agents-working");
  colorful.process.write("\r");
  await colorful.wait((screen) => screen.includes("read-only transcript"), "inspect active child");
  await captureColorScreen(colorful, "inspector");
  colorful.process.write("\u001b");
  await colorful.wait((screen) => screen.includes("TASKS"), "inspector returns to tasks");
  colorful.process.write("\u001b");
  await colorful.wait((screen) => screen.includes("/ CHAT"), "tasks return to conversation");
  colorful.process.write("\u0007");
  await colorful.wait((screen) => screen.includes("Team") && screen.includes("explore"), "working agent floor");
  await captureColorScreen(colorful, "v19-working");
  releaseChild();
  colorful.process.write("\u0007");
  await colorful.wait((screen) => screen.includes("Parent · ready"), "child settled");
  colorful.process.write("/theme design v19\r");
  await colorful.wait((screen) => screen.includes("Team"), "select V19 design");
  assert.equal(JSON.parse(await readFile(path.join(home, ".recurs/config/appearance.json"), "utf8")).design, "v19");
  await captureColorScreen(colorful, "v19");
  colorful.process.write("\u0007");
  await colorful.wait((screen) => screen.includes("/ CHAT"), "V19 conversation");
  colorful.process.write("/theme design r\r");
  await colorful.wait((screen) => screen.includes("Design: r"), "select R design");
  assert.equal(JSON.parse(await readFile(path.join(home, ".recurs/config/appearance.json"), "utf8")).design, "r");


  colorful.process.write("\u0011");
  await colorful.wait(() => colorful.exit() !== undefined, "colored exit");
  colorful.terminal.dispose();
  const escaped = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="940" height="580" viewBox="0 0 940 580"><rect width="940" height="580" rx="12" fill="#11151b"/><text x="20" y="26" fill="#9ba8b8" font-family="monospace" font-size="12">Recurs · installed CLI · deterministic terminal fixture</text><g fill="#e0e6ee" font-family="monospace" font-size="13">${transcript.split("\n").map((line, index) => `<text x="20" y="${54 + index * 17}" xml:space="preserve" textLength="${line.length * 7.8}" lengthAdjust="spacingAndGlyphs">${escaped(line)}</text>`).join("")}</g></svg>`;
  await writeFile(path.join(temporary, "terminal-session.svg"), svg);
  if (process.argv.includes("--update-capture")) await writeFile(path.join(root, "docs/assets/terminal-session.svg"), svg);
  await writeFile(path.join(temporary, "terminal.cast"), [JSON.stringify({ version: 2, width: 100, height: 30, title: "Recurs installed terminal acceptance", env: { TERM: "xterm-256color" } }), ...capture.map((event) => JSON.stringify(event))].join("\n") + "\n");
  console.log(JSON.stringify({ status: "passed", artifact: packed.filename, measurements, requests, checks: ["clean packed install", "saved connection", "first-run quick start", "bracketed paste", "streamed Markdown/code", "long output", "history scroll", "32x10 resize", "execution list", "clean exit", "durable reopen", "saved-model picker cancellation", "theme preview restores draft", "no-color preference save", "light theme persists", "live dark theme", "actual color captures", "native R opening", "orange preset", "file-write approval", "real applied patch and line counts", "working child and inspector", "legacy view aliases", "permission picker and applied mode", "Escape cancels full access", "team navigation before children"], capture: temporary }, null, 2));
} finally {
  releaseChild();
  try { current?.kill(); } catch { /* The child may already have exited. */ }
  server.closeAllConnections(); server.close();
}
