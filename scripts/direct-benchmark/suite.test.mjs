import assert from 'node:assert/strict';
import test from 'node:test';
import { tasks, files, mutate, mutations } from './fixtures.mjs';
import { grade, referenceTests, readCandidate } from './grade.mjs';
import { plan } from './suite.mjs';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

function completed(task) {
  return { ...task.reference, 'test/regression.test.mjs': referenceTests.replace("'./src/service.mjs'", "'../src/service.mjs'"),
    'README.md': task.reference['README.md'] + '\ncloseMany(tenant, ids) closes a validated batch atomically.\n' };
}

test('inventory counterbalances both real product arms without selecting winners', () => {
  const value = plan();
  assert.equal(value.status, 'prepared_not_run');
  assert.equal(value.slots.length, 12);
  assert.equal(new Set(value.slots.map((slot) => slot.id)).size, 12);
  for (const task of tasks) {
    assert.deepEqual(value.slots.filter((slot) => slot.taskId === task.id).map((slot) => slot.arm), ['codex', 'recurs', 'recurs', 'codex']);
  }
});

test('untouched implementations fail and complete references pass', async () => {
  for (const task of tasks.slice(0, 2)) {
    assert.equal((await grade(task.id, task.fixture)).passed, false, task.id);
    assert.equal((await grade(task.id, completed(task))).passed, true, task.id);
  }
});

test('each seeded bug is caught independently by the implementation grader', async () => {
  const task = tasks[0];
  for (const id of Object.keys(mutations)) {
    const candidate = mutate(completed(task), [id]);
    assert.equal((await grade(task.id, candidate)).behaviorPassed, false, id);
  }
});

test('bulk-close grader rejects a partial write before validation', async () => {
  const task = tasks[1];
  const candidate = completed(task);
  candidate['src/service.mjs'] = candidate['src/service.mjs'].replace(
    "ids.forEach((id) => requireIssue(tenant, id));",
    "ids.forEach((id) => { requireIssue(tenant, id); store.update(id, { status: 'closed' }); });",
  );
  assert.equal((await grade(task.id, candidate)).behaviorPassed, false);
});

test('tests and documentation are part of feature completion', async () => {
  const task = tasks[1];
  const candidate = completed(task);
  delete candidate['README.md'];
  assert.equal((await grade(task.id, candidate)).passed, false);
  candidate['README.md'] = task.fixture['README.md'];
  delete candidate['test/regression.test.mjs'];
  assert.equal((await grade(task.id, candidate)).passed, false);
});

test('review credit requires accepting correct code and rejecting individual bugs', async () => {
  const task = tasks[2];
  const valid = await grade(task.id, { ...task.fixture, 'review.test.mjs': referenceTests });
  assert.equal(valid.passed, true);
  assert.equal(valid.bugsCaught, 3);
  assert.equal(valid.manualAuditRequired, true);
  for (const source of ["throw new Error('always fails');", "import test from 'node:test'; test('empty', () => {});"]) {
    const result = await grade(task.id, { ...task.fixture, 'review.test.mjs': source });
    assert.equal(result.passed, false);
    assert.equal(result.bugsCaught, 0);
  }
  assert.equal((await grade(task.id, { ...files, 'review.test.mjs': referenceTests })).passed, false, 'candidate may not repair review target');
});

test('candidate ingestion rejects links and oversized data', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'recurs-direct-test-'));
  try {
    await writeFile(path.join(root, 'large'), 'x'.repeat(1_048_577));
    await assert.rejects(readCandidate(root), /size limit/);
    await rm(path.join(root, 'large'));
    await symlink('missing', path.join(root, 'link'));
    await assert.rejects(readCandidate(root), /symbolic link/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
