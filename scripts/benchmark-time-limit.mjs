/* global process, setTimeout, clearTimeout */
import { spawn } from 'node:child_process';
if (process.argv.length < 3) throw new Error('Usage: node scripts/benchmark-time-limit.mjs <CLI file> <arguments...>');
const child = spawn(process.execPath, process.argv.slice(2), { stdio: 'inherit', env: process.env });
let stop;
const timer = setTimeout(() => {
  process.stderr.write('\nPredeclared 20-minute campaign limit reached; interrupting.\n');
  child.kill('SIGINT');
  stop = setTimeout(() => child.kill('SIGTERM'), 15000);
}, 20 * 60 * 1000);
child.on('exit', (code, signal) => { clearTimeout(timer); clearTimeout(stop); process.exitCode = code ?? (signal ? 130 : 1); });
child.on('error', error => { clearTimeout(timer); process.stderr.write(error.message + '\n'); process.exitCode = 1; });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => child.kill(signal));
