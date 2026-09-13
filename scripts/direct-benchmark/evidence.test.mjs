import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { URL } from 'node:url';
import { getTask } from './fixtures.mjs';
import { grade } from './grade.mjs';
import { plan } from './suite.mjs';

const root = new URL('../../benchmarks/direct-comparison/', import.meta.url);
const evidence = JSON.parse(await readFile(new URL('stopped-campaign.json', root), 'utf8'));

test('stopped comparison preserves every slot without promoting failures or missing usage', () => {
  assert.deepEqual(evidence.slots.map(({ id, taskId, repetition, arm }) => ({ id, taskId, repetition, arm })), plan().slots);
  assert.equal(evidence.planned, 12);
  assert.equal(evidence.attempted, 4);
  assert.equal(evidence.validPairs, 0);
  assert.equal(evidence.comparisonEligible, false);
  assert.deepEqual(evidence.slots.map((slot) => slot.classification), [
    'completed', 'setup_blocked', 'setup_blocked', 'cancelled', ...Array(8).fill('not_attempted'),
  ]);
  for (const [index, slot] of evidence.slots.entries()) {
    assert.equal(slot.comparisonEligible, false);
    assert.equal(slot.costUsd, null);
    if (index !== 0) assert.equal(slot.reportedUsage, null);
    if (index >= 4) {
      assert.equal(slot.wallMs, null);
      assert.equal(slot.grade, null);
    }
  }
  assert.equal(evidence.slots[3].audit.turnCompleted, false);
  assert.equal(evidence.slots[3].grade.passed, true);
  assert.equal(evidence.slots[3].executionStatus, 'cancelled');
});

test('public candidate hashes and independent grader replays match all attempted slots', async () => {
  for (const slot of evidence.slots.slice(0, 4)) {
    const candidate = { ...getTask(slot.taskId).fixture };
    for (const artifact of slot.artifacts) {
      const content = await readFile(new URL(artifact.path, root), 'utf8');
      assert.equal(createHash('sha256').update(content).digest('hex'), artifact.sha256);
      candidate[artifact.candidatePath] = content;
    }
    assert.deepEqual(await grade(slot.taskId, candidate), slot.grade);
  }
});
