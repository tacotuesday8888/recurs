// Synthetic session-list resource probe. No real home, provider or user logs.
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { URL, fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const directory = await mkdtemp(path.join(tmpdir(), "recurs-history-resources-"));
const modulePath = path.resolve(process.argv[2] ?? fileURLToPath(new URL("../packages/core/dist/jsonl-session-store.js", import.meta.url)));
const at = "2026-09-20T00:00:00Z";
let bytes = 0;
try {
  for (let session = 0; session < 4; session += 1) {
    const id = `synthetic-${session}`;
    const file = await open(path.join(directory, `${id}.jsonl`), "wx", 0o600);
    try {
      const header = JSON.stringify({ version:1, type:"session_created", sessionId:id, at, cwd:"/synthetic", model:"fixture" }) + "\n";
      await file.writeFile(header); bytes += Buffer.byteLength(header);
      const record = JSON.stringify({ version:1, type:"message_appended", sessionId:id, at, message:{role:"assistant",content:"x".repeat(8192)} }) + "\n";
      for (let i=0; i<1024; i+=1) { await file.writeFile(record); bytes += Buffer.byteLength(record); }
    } finally { await file.close(); }
  }
  const program = `
    import process from 'node:process';
    import { performance } from 'node:perf_hooks';
    const { JsonlSessionStore } = await import(process.argv[1]);
    const start = performance.now();
    const entries = await new JsonlSessionStore(process.argv[2]).list();
    if (entries.length !== 4 || entries.some(entry => entry.cwd !== '/synthetic')) throw new Error('Invalid synthetic history');
    process.stdout.write(JSON.stringify({wallMs:performance.now()-start,peakRssBytes:process.resourceUsage().maxRSS*1024,entries:entries.length}));
  `;
  const samples = [];
  for (let repetition=0; repetition<4; repetition+=1) {
    const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", program, pathToFileURL(modulePath).href, directory], {
      cwd: directory, env: { PATH:process.env.PATH, HOME:directory, USERPROFILE:directory }, timeout:30_000, maxBuffer:4096,
    });
    if (repetition > 0) samples.push({repetition,...JSON.parse(stdout)});
  }
  process.stdout.write(JSON.stringify({moduleSha256:createHash("sha256").update(await readFile(modulePath)).digest("hex"),node:process.version,platform:process.platform,arch:process.arch,fixture:{sessions:4,messagesPerSession:1024,bytes},method:"Three fresh child processes after a discarded warmup; complete synthetic legacy logs, no crash-tail recovery; parent RSS only; no provider calls.",samples},null,2)+"\n");
} finally { await rm(directory, {recursive:true,force:true}); }
