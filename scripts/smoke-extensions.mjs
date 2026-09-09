import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseSingleNpmPackReport } from "./npm-pack-report.mjs";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { setTimeout, clearTimeout } from "node:timers";
import { spawn } from "@lydell/node-pty";
import { createInstalledCompanyResponder } from "./installed-company-smoke.mjs";

const exec = promisify(execFile);
let executable = process.argv[2];
assert(executable === undefined || path.isAbsolute(executable), "Pass an absolute installed recurs executable path or omit it to pack/install.");
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "recurs-installed-extensions-")));
const artifact = {};
if (executable === undefined) {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const prefix = path.join(root, "prefix");
  const cache = path.join(root, "npm-cache");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = parseSingleNpmPackReport((await exec(npm, ["pack", "--ignore-scripts", "--json", "--cache", cache, "--pack-destination", root], { cwd: repository })).stdout);
  const archive = path.join(root, packed.filename);
  artifact.version = packed.version;
  artifact.archiveSha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
  await exec(npm, ["install", "--prefix", prefix, "--cache", cache, "--ignore-scripts", "--omit=dev", "--no-package-lock", "--no-audit", "--no-fund", archive], { timeout: 120000 });
  executable = path.join(prefix, "node_modules", ".bin", process.platform === "win32" ? "recurs.cmd" : "recurs");
}
const model = "installed-extensions-fixture";
const responder = createInstalledCompanyResponder();
const requests = [];
const mcpMethods = [];
const results = { skills: [], mcp: [], formation: [] };
const clean = (text) => text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "").replaceAll("\r", ""); // eslint-disable-line no-control-regex
const server = createServer(async (request, response) => {
  try {
    let payload = "";
    for await (const chunk of request) payload += chunk;
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: model, object: "model" }] }));
    } else if (request.url === "/v1/chat/completions") {
      const body = JSON.parse(payload);
      requests.push(body);
      const answer = responder.respond(body);
      assert.equal(answer.kind, "text");
      response.setHeader("content-type", "text/event-stream");
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
    } else if (request.url === "/mcp" && request.method === "POST") {
      const body = JSON.parse(payload);
      mcpMethods.push(body.method);
      if (body.id === undefined) { response.writeHead(202); response.end(); return; }
      let result;
      if (body.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "installed-http-probe", version: "1.0.0" } };
      if (body.method === "tools/list") result = { tools: [{ name: "probe", description: "Installed HTTP fixture", inputSchema: { type: "object" } }] };
      if (body.method === "resources/list") result = { resources: [{ uri: "fixture://guide", name: "guide" }] };
      if (body.method === "prompts/list") result = { prompts: [{ name: "probe" }] };
      if (body.method === "ping") result = {};
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...(result ? { result } : { error: { code: -32601, message: "Unknown method" } }) }));
    } else { response.writeHead(405); response.end(); }
  } catch { response.writeHead(500); response.end(); }
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const base = `http://127.0.0.1:${server.address().port}`;

async function fixture(name) {
  const cwd = path.join(root, name, "workspace");
  const home = path.join(root, name, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, RECURS_HOME: path.join(home, ".recurs"), TERM: "xterm-256color", NO_COLOR: "1", RECURS_NO_TUI: "1" };
  await writeFile(path.join(cwd, "package.json"), '{"name":"installed-fixture","private":true}\n');
  await exec(executable, ["setup", "local", "--url", `${base}/v1`, "--model", model], { cwd, env });
  const account = JSON.parse((await exec(executable, ["account", "list", "--json"], { cwd, env })).stdout).accounts.find((value) => value.primary);
  assert(account?.id);
  return { cwd, env, connectionId: `account:${account.id}` };
}

async function pty(f, args, steps = [], timeoutMs = 45000) {
  let transcript = "";
  let buffer = "";
  let index = 0;
  const terminal = spawn(executable, args, { cwd: f.cwd, env: f.env, cols: 120, rows: 35 });
  terminal.onData((chunk) => {
    transcript += chunk;
    buffer = clean(buffer + chunk);
    assert(transcript.length < 2 * 1024 * 1024, "PTY output bound exceeded");
    while (index < steps.length) {
      const [marker, answer] = steps[index];
      const position = buffer.indexOf(marker);
      if (position < 0) break;
      buffer = buffer.slice(position + marker.length);
      index += 1;
      terminal.write(`${answer}\r`);
    }
  });
  let timer;
  const status = await Promise.race([
    new Promise((resolve) => terminal.onExit(resolve)),
    new Promise((_, reject) => { timer = setTimeout(() => { terminal.kill(); reject(new Error(`Installed PTY timeout at step ${index}: ${clean(transcript).slice(-5000)}`)); }, timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(status.exitCode, 0, clean(transcript));
  assert.equal(index, steps.length, clean(transcript));
  return clean(transcript);
}

function setupSteps(f, depth) {
  return [
    ["Choose a saved, detected, or recommended model connection:", f.connectionId],
    ["Choose how much Recurs may do without asking:", "ask_always"],
    ["Choose how much agent teamwork Recurs should use:", "balanced_v6"],
    ["Choose the team-control detail:", "recommended"],
    ["Tailor the first Recurs agent company to this project:", "create"],
    ["How deeply should Recurs understand the project before proposing your company?:", depth],
    ["How should Recurs form the company?:", "stable_core_specialists"],
    ["Allow company formation to inspect this project read-only", "y"],
  ];
}

async function allFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? allFiles(path.join(directory, entry.name)) : path.join(directory, entry.name)))).flat();
}

try {
  const f = await fixture("extensions");
  const source = path.join(root, 'bundle with "quotes" and \\slash', 'installed-lifecycle');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: installed-lifecycle\ndescription: Installed management fixture\n---\nRead [guide](guide.md).\n");
  await writeFile(path.join(source, "guide.md"), "INSTALLED_RESOURCE_BUNDLE\n");
  let out = await pty(f, ["skills", "add", source]);
  assert.match(out, /Added installed-lifecycle/);
  assert.equal(await readFile(path.join(f.env.RECURS_HOME, "skills/installed-lifecycle/guide.md"), "utf8"), "INSTALLED_RESOURCE_BUNDLE\n");
  results.skills.push("add exact quoted/backslash path with copied linked resource");
  out = await pty(f, ["skills", "inspect", "installed-lifecycle"]);
  assert.match(out, /Resources: guide.md/);
  results.skills.push("inspect resource listing");
  await pty(f, ["skills", "disable", "installed-lifecycle"]);
  assert.match(await pty(f, ["skills", "inspect", "installed-lifecycle"]), /user, disabled/);
  await pty(f, ["skills", "enable", "installed-lifecycle"]);
  assert.match(await pty(f, ["skills", "inspect", "installed-lifecycle"]), /user, enabled/);
  results.skills.push("disable/enable persist across processes");
  await pty(f, ["skills", "remove", "installed-lifecycle"]);
  assert.match(await pty(f, ["skills", "list"]), /No Agent Skills found/);
  assert((await allFiles(f.env.RECURS_HOME)).some((file) => file.includes("removed-skills") && file.endsWith("guide.md")));
  results.skills.push("remove preserves archived resource bundle");
  const definition = { id: "installed-http", description: "Installed HTTP fixture", transport: "http", url: `${base}/mcp` };
  assert.match(await pty(f, ["mcp", "add", "user", JSON.stringify(definition)]), /installed-http/);
  out = await pty(f, ["mcp", "diagnose", "installed-http"], [
    ["Allow network access to diagnose MCP server installed-http?", "y"],
    ["Allow network access to diagnose MCP server installed-http?", "y"],
    ["Allow network access to diagnose MCP server installed-http?", "y"],
  ]);
  assert.match(out, /tools: 1/);
  assert.match(out, /resources: 1/);
  assert.match(out, /prompts: 1/);
  assert.match(out, /installed-http-probe@1.0.0/);
  for (const method of ["initialize", "notifications/initialized", "tools/list", "resources/list", "prompts/list"]) assert(mcpMethods.includes(method), method);
  results.mcp.push("HTTP initialize and advertised tools/resources/prompts discovery with approvals");
  await pty(f, ["mcp", "disable", "user", "installed-http"]);
  assert.match(await pty(f, ["mcp", "inspect", "installed-http"]), /disabled\s+installed-http/);
  await pty(f, ["mcp", "enable", "user", "installed-http"]);
  assert.match(await pty(f, ["mcp", "inspect", "installed-http"]), /enabled\s+installed-http/);
  definition.description = "Updated installed HTTP fixture";
  assert.match(await pty(f, ["mcp", "configure", "user", JSON.stringify(definition)]), /Updated installed HTTP fixture/);
  await pty(f, ["mcp", "remove", "user", "installed-http"]);
  assert.match(await pty(f, ["mcp", "list"]), /No MCP servers configured/);
  results.mcp.push("add/configure/disable/enable/remove persist across processes");
  for (const depth of ["guided", "deep"]) {
    const company = await fixture(depth);
    const offset = requests.length;
    const first = await pty(company, ["setup"], [...setupSteps(company, depth),
      ["What outcome should this installed company own?:", "Ship the installed reviewed clamp fixture."],
      ["Review the proposed agent company:", "save_exit"],
    ]);
    assert.match(first, /Company interview · question 1/);
    assert.match(first, /Company proposal saved/);
    const revisit = await pty(company, ["setup"], [...setupSteps(company, depth),
      ["Resume the unfinished company interview?:", "resume"],
      ["Review the proposed agent company:", "approve"],
      ["Give the new agent team project context:", "skip"],
      ["recurs ›", "/quit"],
    ]);
    assert.match(revisit, /Company approved/);
    const files = await allFiles(company.env.RECURS_HOME);
    const stored = (await Promise.all(files.filter((file) => /\.(json|jsonl|yaml)$/u.test(file)).map((file) => readFile(file, "utf8")))).join("\n");
    assert(stored.includes(`"depth":"${depth}"`) || stored.includes(`"depth": "${depth}"`), "Selected formation depth was not persisted");
    results.formation.push({ depth, localModelRequests: requests.length - offset, question: "What outcome should this installed company own?", proposal: "Ship the installed company journey through one reviewed patch.", savedProposal: true, resumedAndApproved: true });
  }
  process.stdout.write(`${JSON.stringify({ passed: true, artifact, executable, ...results, mcpMethods, liveModelRequests: 0 }, null, 2)}\n`);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
