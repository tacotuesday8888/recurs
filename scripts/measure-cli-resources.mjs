// Offline measurements of the bundled CLI, with a fresh synthetic home per run.
// These are command startup costs, not model quality or active-agent memory.
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const probe = `import process from 'node:process';
import { writeSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(process.argv[1]);
process.on('exit', () => writeSync(3, JSON.stringify({
  peakRssBytes: process.resourceUsage().maxRSS * 1024,
  exitRssBytes: process.memoryUsage().rss,
  compilerLoaded: Object.keys(require.cache).some(p => /[\\\\/]typescript[\\\\/]lib[\\\\/]typescript\\.js$/.test(p))
})));`;
const probeUrl = `data:text/javascript;base64,${Buffer.from(probe).toString("base64")}`;
export async function measureCliCommand(entry, args) {
  const home = await mkdtemp(path.join(tmpdir(), "recurs-resources-"));
  try {
    const started = performance.now();
    const metrics = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", probeUrl, path.resolve(entry), ...args], {
        cwd: home,
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, RECURS_HOME: path.join(home, ".recurs"), NO_COLOR: "1" },
        stdio: ["ignore", "ignore", "pipe", "pipe"],
        timeout: 15_000,
      });
      let output = "";
      let errors = "";
      child.stdio[3].on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { errors = (errors + chunk).slice(-2048); });
      child.once("error", reject);
      child.once("close", code => {
        if (code !== 0) { reject(new Error(`CLI measurement failed (${code}): ${errors}`)); return; }
        try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
      });
    });
    return { command: args[0], wallMs: Math.round((performance.now() - started) * 10) / 10, ...metrics };
  } finally { await rm(home, { recursive: true, force: true }); }
}

async function main(entry) {
  const samples = [];
  for (const args of [["--version"], ["--help"]]) {
    for (let repetition = 0; repetition < 6; repetition += 1) {
      const metrics = await measureCliCommand(entry, args);
      if (repetition > 0) samples.push({ repetition, ...metrics });
    }
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    executableSha256: createHash("sha256").update(await readFile(entry)).digest("hex"),
    method: "Five fresh processes per command after one discarded warmup; isolated homes; peak RSS from Node resourceUsage in bytes; no model calls; not process-tree or active-turn memory.",
    samples,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main(path.resolve(process.argv[2] ?? "dist/cli/main.js"));
}
