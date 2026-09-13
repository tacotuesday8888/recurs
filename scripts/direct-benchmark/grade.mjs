import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, readdir, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { files, getTask, mutate, mutations } from "./fixtures.mjs";

const execute = promisify(execFile);
const checks = `import assert from 'node:assert/strict';
import test from 'node:test';
import { createService } from './src/service.mjs';
const seed = [
  { id: 'c', tenant: 'red', title: 'Third', status: 'open', secret: 'c-private' },
  { id: 'b', tenant: 'blue', title: 'Other', status: 'open', secret: 'b-private' },
  { id: 'a', tenant: 'red', title: 'First', status: 'open', secret: 'a-private' },
  { id: 'e', tenant: 'red', title: 'Last', status: 'closed', secret: 'e-private' },
];
const keys = (row) => assert.deepEqual(Object.keys(row).sort(), ['id', 'status', 'title']);
test('foreign and absent mutations are rejected without changes', () => {
  const s = createService(seed);
  for (const id of ['b', 'missing']) assert.throws(() => s.close('red', id), { code: 'NOT_FOUND' });
  assert.equal(s.get('blue', 'b').status, 'open');
  assert.equal(s.get('red', 'b'), null);
  assert.equal(s.get('red', 'missing'), null);
});
test('cursor is exclusive, filtered, sorted and terminates', () => {
  const s = createService(seed);
  const first = s.list('red', { limit: 1 });
  assert.deepEqual(first.items.map((row) => row.id), ['a']);
  assert.equal(first.nextCursor, 'a');
  const second = s.list('red', { after: first.nextCursor, limit: 1 });
  assert.deepEqual(second.items.map((row) => row.id), ['c']);
  assert.equal(second.nextCursor, 'c');
  const last = s.list('red', { after: second.nextCursor, limit: 1 });
  assert.deepEqual(last.items.map((row) => row.id), ['e']);
  assert.equal(last.nextCursor, null);
  assert.deepEqual(s.list('red', { after: 'z' }), { items: [], nextCursor: null });
  assert.deepEqual(s.list('missing'), { items: [], nextCursor: null });
});
test('all response paths redact private fields and detach records', () => {
  const s = createService(seed);
  const outputs = [s.get('red', 'a'), s.close('red', 'c'), ...s.list('red').items];
  for (const row of outputs) { keys(row); row.title = 'corrupted'; }
  assert.equal(s.get('red', 'a').title, 'First');
  assert.equal(s.get('red', 'c').title, 'Third');
  assert.equal(seed[0].status, 'open');
});
test('page-size validation and boundary sizes', () => {
  const s = createService(seed);
  for (const limit of [0, -1, 101, 1.5, '2', null, NaN, Infinity]) {
    assert.throws(() => s.list('red', { limit }), { code: 'INVALID_LIMIT' });
  }
  assert.equal(s.list('red', { limit: 100 }).items.length, 3);
  assert.equal(s.list('red').items.length, 3);
});
`;

const featureChecks = `
test('bulk close preserves order, redacts and detaches', () => {
  const s = createService(seed);
  const result = s.closeMany('red', ['e', 'a', 'c']);
  assert.deepEqual(result.map((row) => row.id), ['e', 'a', 'c']);
  for (const row of result) { keys(row); assert.equal(row.status, 'closed'); row.title = 'corrupted'; }
  assert.equal(s.get('red', 'a').title, 'First');
  assert.equal(s.get('red', 'a').status, 'closed');
});
test('bulk close validates the complete batch before writing', () => {
  for (const bad of ['missing', 'b']) {
    const s = createService(seed);
    assert.throws(() => s.closeMany('red', ['a', bad, 'c']), { code: 'NOT_FOUND' });
    assert.equal(s.get('red', 'a').status, 'open');
    assert.equal(s.get('red', 'c').status, 'open');
    assert.equal(s.get('blue', 'b').status, 'open');
  }
});
test('bulk close rejects malformed batches without writing', () => {
  for (const ids of [undefined, null, 'a', {}, [], ['a', 'a'], [''], ['a', 3], Array(101).fill('a')]) {
    const s = createService(seed);
    assert.throws(() => s.closeMany('red', ids), { code: 'INVALID_IDS' });
    assert.equal(s.get('red', 'a').status, 'open');
  }
});
test('bulk close accepts both size boundaries', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: String(i), tenant: 'red', title: 'Issue', status: 'open', secret: 'private' }));
  const s = createService(rows);
  assert.equal(s.closeMany('red', ['0']).length, 1);
  assert.equal(s.closeMany('red', rows.map((row) => row.id)).length, 100);
});
`;

export async function writeFiles(root, source) {
  for (const [name, contents] of Object.entries(source)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), contents, { mode: 0o600 });
  }
}

// Only bounded regular source/test files are imported into the disposable grader.
// Dependencies, Git metadata and arbitrary links are never copied.
export async function readCandidate(root) {
  const candidate = {};
  let bytes = 0;
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules', '.recurs'].includes(entry.name)) continue;
      const name = prefix + entry.name;
      const location = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Candidate contains a symbolic link');
      if (entry.isDirectory()) {
        if (name.split('/').length > 8) throw new Error('Candidate directory limit exceeded');
        await visit(location, name + '/');
      } else {
        const stat = await lstat(location);
        if (!stat.isFile()) throw new Error('Candidate contains a non-regular file');
        bytes += stat.size;
        if (bytes > 1_048_576 || Object.keys(candidate).length >= 100) throw new Error('Candidate size limit exceeded');
        candidate[name] = await readFile(location, 'utf8');
      }
    }
  }
  await visit(root);
  return candidate;
}

async function runTests(source, testFiles) {
  const directory = await mkdtemp(path.join(tmpdir(), 'recurs-direct-grade-'));
  try {
    await writeFiles(directory, source);
    const result = await execute(process.execPath, ['--test', ...testFiles], {
      cwd: directory, timeout: 5_000, killSignal: 'SIGKILL', maxBuffer: 512 * 1024,
      env: { PATH: process.env.PATH ?? '', HOME: directory, TMPDIR: directory },
    }).then(() => ({ passed: true, failure: null }), (error) => ({
      passed: false,
      failure: error.killed ? 'timeout' : error.code === 1 ? 'test_failure' : 'execution_failure',
    }));
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function grade(taskId, candidate) {
  const task = getTask(taskId);
  if (taskId === 'catch-regressions') {
    const unchanged = Object.entries(task.fixture).every(([name, contents]) => candidate[name] === contents);
    const source = candidate['review.test.mjs'];
    if (!unchanged || !source?.trim()) return { passed: false, correctCodeAccepted: false, bugsCaught: 0, bugsTotal: 3, manualAuditRequired: true };
    const clean = await runTests({ ...files, 'review.test.mjs': source }, ['review.test.mjs']);
    const caught = [];
    for (const id of Object.keys(mutations)) {
      const result = await runTests({ ...mutate(files, [id]), 'review.test.mjs': source }, ['review.test.mjs']);
      // Crashes, timeouts and source inspection are not evidence of a useful regression test.
      if (clean.passed && result.failure === 'test_failure') caught.push(id);
    }
    return { passed: clean.passed && caught.length === 3, correctCodeAccepted: clean.passed, bugsCaught: caught.length, bugsTotal: 3, caught, manualAuditRequired: true };
  }
  const existingTestsPreserved = Object.entries(task.fixture).filter(([name]) => name.startsWith('test/'))
    .every(([name, contents]) => candidate[name] === contents);
  const packagePreserved = candidate['package.json'] === task.fixture['package.json'];
  const hidden = await runTests({ ...candidate, 'package.json': files['package.json'], '.benchmark.test.mjs': checks + (taskId === 'build-bulk-close' ? featureChecks : '') }, ['.benchmark.test.mjs', 'test/service.test.mjs']);
  const testsAdded = Object.keys(candidate).some((name) => !Object.hasOwn(task.fixture, name) && /^test\/.*\.test\.mjs$/.test(name));
  const documentationUpdated = taskId !== 'build-bulk-close' || (typeof candidate['README.md'] === 'string' && candidate['README.md'].includes('closeMany') && candidate['README.md'] !== task.fixture['README.md']);
  const added = Object.keys(candidate).filter((name) => /^test\/.*\.test\.mjs$/.test(name));
  const candidateTests = added.length ? await runTests({ ...candidate, 'package.json': files['package.json'] }, added) : { passed: false };
  return { passed: hidden.passed && candidateTests.passed && existingTestsPreserved && packagePreserved && testsAdded && documentationUpdated,
    behaviorPassed: hidden.passed, candidateTestsPassed: candidateTests.passed,
    existingTestsPreserved, packagePreserved, testsAdded, documentationUpdated, manualAuditRequired: true };
}

export const referenceTests = checks;
