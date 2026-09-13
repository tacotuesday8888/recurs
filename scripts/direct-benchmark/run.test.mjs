import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { assertRoutes, runProcess, slotArguments } from './run.mjs';

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
