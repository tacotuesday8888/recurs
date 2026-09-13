import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { setTimeout, clearTimeout } from 'node:timers';
import { promisify } from 'node:util';
import { pathToFileURL, URL } from 'node:url';
import { getTask } from './fixtures.mjs';
import { grade, readCandidate, writeFiles } from './grade.mjs';
import { digest, plan } from './suite.mjs';

const execute = promisify(execFile);
const sha = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');
const options = { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 };

export function slotArguments(slot, config, workspace) {
  return slot.arm === 'codex'
    ? [config.codexLauncher, 'exec', '--json', '--ephemeral', '--ignore-user-config',
      '--sandbox', 'workspace-write', '-c', 'approval_policy="never"',
      '-m', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="medium"', '-C', workspace, '-']
    : [config.recursBundle, 'run', '-', '--format', 'jsonl', '--permissions', 'approved',
      '--mode', 'balanced', '--connection', config.connections.parent, '-C', workspace];
}

export function assertRoutes(accounts, connections) {
  for (const [role, model] of [['parent', 'gpt-5.6-luna'], ['review', 'gpt-5.6-luna'], ['implement', 'gpt-5.6-terra'], ['repair', 'gpt-5.6-terra']]) {
    const account = accounts.find((entry) => entry.id === connections[role]);
    if (account?.modelId !== model || account.reasoningEffort !== 'medium' || account.adapterId !== 'codex-app-server' ||
        (role !== 'parent' && !account.agentRoles.includes(role))) throw new Error(`Unexpected ${role} route`);
  }
}

export function assertInvocationSupported(accounts, connections) {
  // `recurs run` is always scripted/unattended, including inside a foreground
  // PTY. Account readiness and model routing do not authorize that invocation.
  for (const role of ['parent', 'review', 'implement', 'repair']) {
    const account = accounts.find((entry) => entry.id === connections[role]);
    if (!account) throw new Error(`Missing ${role} connection`);
    if (account.adapterId === 'codex-app-server' || account.kind === 'delegated_agent') {
      throw new Error(`Unsupported ${role} invocation: recurs run is scripted; this connection requires local, user-present, manual CLI use. No comparison models were launched. A supported execution protocol must be declared separately.`);
    }
  }
}

export function hasConfigurationFailure(stdout) {
  return stdout.split('\n').some((line) => {
    try { return JSON.parse(line).type === 'configuration_error'; }
    catch { return false; }
  });
}

async function preflight(config) {
  if (process.platform === 'win32') throw new Error('This foreground process-group runner currently supports macOS and Linux only');
  for (const key of ['codexLauncher', 'codexBinary', 'recursBundle']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) throw new Error(`${key} must be an absolute path`);
  }
  const version = await execute(process.execPath, [config.codexLauncher, '--version'], options);
  const binaryVersion = await execute(config.codexBinary, ['--version'], options);
  if (version.stdout.trim() !== 'codex-cli 0.145.0' || binaryVersion.stdout.trim() !== 'codex-cli 0.145.0') throw new Error('Both Codex routes require official CLI 0.145.0');
  const result = await execute(process.execPath, [config.recursBundle, 'account', 'list', '--json'], options);
  const accounts = JSON.parse(result.stdout).accounts;
  assertRoutes(accounts, config.connections);
  assertInvocationSupported(accounts, config.connections);
  return {
    codexLauncher: await sha(config.codexLauncher), codexBinary: await sha(config.codexBinary), recursBundle: await sha(config.recursBundle),
    nodeVersion: process.version, codexVersion: version.stdout.trim(),
    harness: Object.fromEntries(await Promise.all(['run.mjs', 'suite.mjs', 'fixtures.mjs', 'grade.mjs'].map(async (name) => [name, await sha(new URL(name, import.meta.url))]))),
    routes: Object.fromEntries(Object.entries(config.connections).map(([role, id]) => {
      const account = accounts.find((entry) => entry.id === id);
      return [role, { model: account.modelId, effort: account.reasoningEffort, adapter: account.adapterId }];
    })),
  };
}

// Foreground only: cap wall time and output, terminate the entire child group.
// Raw traces are private artifacts; never feed them directly into public charts.
export async function runProcess(args, { cwd, input, timeoutMs, signal, env = process.env }) {
  if (signal.aborted) return { status: 'cancelled', exitCode: null, wallMs: 0, stdout: '', stderr: '' };
  const started = performance.now();
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const buffers = { stdout: [], stderr: [] };
    let size = 0;
    let status = null;
    function kill(reason) {
      status ??= reason;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
    }
    const abort = () => kill('cancelled');
    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    for (const name of ['stdout', 'stderr']) child[name].on('data', (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) kill('output_limit');
      else buffers[name].push(chunk);
    });
    child.stdin.on('error', () => {}); // A child may exit before consuming its prompt.
    child.stdin.end(input);
    child.once('error', (error) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort); reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      const outcome = status ?? (code === 0 ? 'completed' : 'execution_failed');
      kill('cleanup');
      resolve({ status: outcome, exitCode: code, wallMs: Math.round(performance.now() - started),
        stdout: Buffer.concat(buffers.stdout).toString('utf8'), stderr: Buffer.concat(buffers.stderr).toString('utf8') });
    });
  });
}

async function main(args) {
  const [command, configFile, destination] = args;
  if (!['preflight', 'run'].includes(command) || args.length !== 3) throw new Error('Usage: run.mjs preflight|run <private-config.json> <new-artifact-directory>');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const provenance = await preflight(config);
  if (command === 'preflight') {
    process.stdout.write(JSON.stringify({ status: 'ready_not_run', plan: plan(), provenance }, null, 2) + '\n');
    return;
  }
  const root = path.resolve(destination);
  await mkdir(root, { mode: 0o700 }); // Existing directories are never resumed or overwritten.
  const inventory = plan();
  await writeFile(path.join(root, 'plan.json'), JSON.stringify({ ...inventory, provenance, configSha256: digest(config) }, null, 2) + '\n', { mode: 0o600 });
  const controller = new globalThis.AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const started = performance.now();
  const results = [];
  try {
    for (const slot of inventory.slots) {
      if (controller.signal.aborted || performance.now() - started >= inventory.limits.campaignWallSeconds * 1000) break;
      const current = await preflight(config);
      if (digest(current) !== digest(provenance)) throw new Error('Executable or model routes changed during the campaign');
      const directory = path.join(root, slot.id);
      const workspace = path.join(directory, 'workspace');
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      const task = getTask(slot.taskId);
      await writeFiles(workspace, task.fixture);
      await execute('git', ['init', '--quiet'], { ...options, cwd: workspace });
      await execute('git', ['add', '.'], { ...options, cwd: workspace });
      await execute('git', ['-c', 'user.name=Benchmark', '-c', 'user.email=benchmark@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'Fixture'], { ...options, cwd: workspace });
      const record = { ...slot, status: 'started', grade: null, tokens: null, costUsd: null };
      results.push(record);
      const save = () => writeFile(path.join(root, 'results.private.json'), JSON.stringify({ planned: inventory.slots.length, results }, null, 2) + '\n', { mode: 0o600 });
      await save(); // Reserve before a model starts; crashes remain visible.
      const remainingMs = inventory.limits.campaignWallSeconds * 1000 - (performance.now() - started);
      if (remainingMs <= 0 || controller.signal.aborted) {
        record.status = controller.signal.aborted ? 'not_started_cancelled' : 'not_started_time_limit';
        await save();
        break;
      }
      process.stdout.write(`${slot.id}: started\n`);
      const result = await runProcess(slotArguments(slot, config, workspace), {
        cwd: workspace, input: task.prompt,
        timeoutMs: Math.min(inventory.limits.trialWallSeconds * 1000, remainingMs),
        signal: controller.signal,
        env: { ...process.env, RECURS_CODEX_PATH: config.codexBinary },
      });
      await writeFile(path.join(directory, 'stdout.private.jsonl'), result.stdout, { mode: 0o600 });
      await writeFile(path.join(directory, 'stderr.private.txt'), result.stderr, { mode: 0o600 });
      record.status = result.status; record.exitCode = result.exitCode; record.wallMs = result.wallMs;
      if (slot.arm === 'recurs' && hasConfigurationFailure(result.stdout)) record.status = 'invalid_configuration_preflight';
      try { record.grade = await grade(task.id, await readCandidate(workspace)); }
      catch { record.grade = { passed: false, reason: 'candidate_invalid_or_grader_error', manualAuditRequired: true }; }
      try {
        if (digest(await preflight(config)) !== digest(provenance)) record.status = 'invalid_configuration_changed';
      } catch { record.status = 'invalid_configuration_unverifiable'; }
      await save();
      process.stdout.write(`${slot.id}: ${record.status}; checks ${record.grade.passed ? 'passed' : 'failed'}\n`);
      if (record.status.startsWith('invalid_configuration')) break;
    }
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  const complete = results.length === inventory.slots.length && results.every((item) => item.status === 'completed' && item.grade?.passed);
  process.exitCode = complete ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
}
