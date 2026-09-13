import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout } from 'node:timers/promises';
import { assertRoutes, assertInvocationSupported, hasConfigurationFailure, runProcess, slotArguments } from './run.mjs';

test('ready model routes cannot authorize a scripted subscription invocation', () => {
  const connections = { parent: 'luna', review: 'luna', implement: 'terra', repair: 'terra' };
  const accounts = [
    { id: 'luna', kind: 'delegated_agent', modelId: 'gpt-5.6-luna', reasoningEffort: 'medium', adapterId: 'codex-app-server', agentRoles: ['review'] },
    { id: 'terra', kind: 'delegated_agent', modelId: 'gpt-5.6-terra', reasoningEffort: 'medium', adapterId: 'codex-app-server', agentRoles: ['implement', 'repair'] },
  ];
  assert.doesNotThrow(() => assertRoutes(accounts, connections));
  assert.throws(() => assertInvocationSupported(accounts, connections), /recurs run is scripted/);
});

test('preflight and run reject the pinned protocol before any model or workspace starts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'direct-preflight-'));
  try {
    const fake = path.join(root, 'fake.mjs');
    const accounts = [
      { id: 'luna', modelId: 'gpt-5.6-luna', reasoningEffort: 'medium', adapterId: 'codex-app-server', agentRoles: ['review'] },
      { id: 'terra', modelId: 'gpt-5.6-terra', reasoningEffort: 'medium', adapterId: 'codex-app-server', agentRoles: ['implement', 'repair'] },
    ];
    await writeFile(fake, `#!${process.execPath}\nif (process.argv[2] === '--version') console.log('codex-cli 0.145.0');\nelse if (process.argv[2] === 'account') console.log(${JSON.stringify(JSON.stringify({ accounts }))});\nelse { console.error('MODEL_LAUNCHED'); process.exitCode = 99; }\n`, { mode: 0o700 });
    const config = path.join(root, 'config.json');
    await writeFile(config, JSON.stringify({ codexLauncher: fake, codexBinary: fake, recursBundle: fake,
      connections: { parent: 'luna', review: 'luna', implement: 'terra', repair: 'terra' } }));
    for (const command of ['preflight', 'run']) {
      await assert.rejects(promisify(execFile)(process.execPath, ['scripts/direct-benchmark/run.mjs', command, config, path.join(root, command)], { timeout: 5000 }), (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr, /recurs run is scripted/);
        assert.doesNotMatch(error.stdout + error.stderr, /MODEL_LAUNCHED|ready_not_run/);
        return true;
      });
      await assert.rejects(access(path.join(root, command)), { code: 'ENOENT' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runtime configuration errors stop the comparison instead of spending the next slot', () => {
  assert.equal(hasConfigurationFailure('{"type":"configuration_error","error":{"code":"policy_blocked"}}\n'), true);
  assert.equal(hasConfigurationFailure('noise\n{"type":"configuration_error"}\n'), true);
  assert.equal(hasConfigurationFailure('{"type":"turn.completed"}\n'), false);
  assert.equal(hasConfigurationFailure('not json\n'), false);
});

test('commands use the actual Codex CLI and actual Recurs run interface', () => {
  const config = { codexLauncher: '/tool/codex.js', recursBundle: '/tool/recurs.mjs', connections: { parent: 'parent' } };
  const codex = slotArguments({ arm: 'codex' }, config, '/fixture');
  const recurs = slotArguments({ arm: 'recurs' }, config, '/fixture');
  assert.deepEqual(codex.slice(0, 3), ['/tool/codex.js', 'exec', '--json']);
  assert.deepEqual(recurs.slice(0, 3), ['/tool/recurs.mjs', 'run', '-']);
  assert.ok(codex.includes('workspace-write'));
  assert.equal(codex.some((value) => value.includes('dangerously')), false);
  assert.ok(recurs.includes('approved'));
});

test('model-route drift fails preflight', () => {
  const connections = { parent: 'luna', review: 'luna', implement: 'terra', repair: 'terra' };
  const accounts = [
    { id: 'luna', modelId: 'gpt-5.6-luna', reasoningEffort: 'medium', adapterId: 'codex-app-server', agentRoles: ['review'] },
    { id: 'terra', modelId: 'gpt-5.6-terra', reasoningEffort: 'medium', adapterId: 'codex-app-server', agentRoles: ['implement', 'repair'] },
  ];
  assert.doesNotThrow(() => assertRoutes(accounts, connections));
  accounts[1].reasoningEffort = 'high';
  assert.throws(() => assertRoutes(accounts, connections), /Unexpected implement route/);
});

test('foreground runner captures successful and failed local processes', async () => {
  for (const code of [0, 1]) {
    const result = await runProcess(['-e', `process.stdout.write('local-only'); process.exitCode = ${code};`], {
      cwd: tmpdir(), input: '', timeoutMs: 2000, signal: new globalThis.AbortController().signal,
    });
    assert.equal(result.status, code === 0 ? 'completed' : 'execution_failed');
    assert.equal(result.stdout, 'local-only');
    assert.equal(result.exitCode, code);
  }
});

test('foreground runner enforces timeout and cancellation without model requests', async () => {
  const timed = await runProcess(['-e', 'setInterval(() => {}, 1000)'], {
    cwd: tmpdir(), input: '', timeoutMs: 100, signal: new globalThis.AbortController().signal,
  });
  assert.equal(timed.status, 'timeout');
  const controller = new globalThis.AbortController();
  const pending = runProcess(['-e', 'setInterval(() => {}, 1000)'], { cwd: tmpdir(), input: '', timeoutMs: 2000, signal: controller.signal });
  await setTimeout(100);
  controller.abort();
  assert.equal((await pending).status, 'cancelled');
  assert.equal((await runProcess(['-e', "throw new Error('must not launch')"], { cwd: tmpdir(), input: '', timeoutMs: 1000, signal: controller.signal })).status, 'cancelled');
});

test('foreground runner bounds captured output', async () => {
  const result = await runProcess(['-e', "const fs = require('node:fs'); const data = Buffer.alloc(65536, 120); for (let i = 0; i < 300; i++) fs.writeSync(1, data);"], {
    cwd: tmpdir(), input: '', timeoutMs: 3000, signal: new globalThis.AbortController().signal,
  });
  assert.equal(result.status, 'output_limit');
  assert.ok(result.stdout.length <= 16 * 1024 * 1024);
});
