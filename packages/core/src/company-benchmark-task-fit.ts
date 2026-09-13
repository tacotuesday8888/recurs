/** Predeclared existing-code workloads. Hidden checks never enter model workspaces. */
export interface TaskFitSpec {
  readonly id: string;
  readonly objective: string;
  readonly sources: Readonly<Record<string, string>>;
  readonly visibleTests: string;
  readonly hiddenChecks: string;
  readonly checkIds: readonly string[];
  readonly parallelScopes?: readonly string[];
}

const configSource = `export function resolveOptions(defaults, project = {}, cli = {}) {
  const result = {};
  for (const key of Object.keys(defaults)) {
    result[key] = cli[key] || project[key] || defaults[key];
  }
  return result;
}
`;

const queueJob = `export function createJob(task, signal) {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { task, signal, promise, resolve, reject, state: 'queued' };
}
export function abortError() {
  const error = new Error('Job cancelled');
  error.name = 'AbortError';
  return error;
}
`;
const queueSource = `import { createJob, abortError } from './job.js';
export function createQueue(concurrency = 1) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency');
  const pending = [];
  let active = 0;
  function pump() {
    while (active < concurrency && pending.length) {
      const job = pending.shift();
      active++;
      job.state = 'running';
      Promise.resolve().then(() => job.task(job.signal)).then(value => {
        job.state = 'completed';
        job.resolve(value);
        active--;
        pump();
      }, error => { job.state = 'failed'; job.reject(error); });
    }
  }
  return {
    add(task, { signal } = {}) {
      const job = createJob(task, signal);
      if (signal?.aborted) job.reject(abortError());
      pending.push(job);
      pump();
      return job.promise;
    },
    stats() { return { active, queued: pending.length }; },
  };
}
`;

const visibleHeader = `import assert from 'node:assert/strict';\nimport test from 'node:test';\n`;
export const TASK_FIT_SPECS: readonly TaskFitSpec[] = Object.freeze([
  {
    id: 'options_precedence',
    objective: 'Fix resolveOptions in src/options.js: for each own enumerable default key, choose the highest-priority own property whose value is not undefined (cli, then project, then defaults). Preserve false, 0, empty string and null. Ignore inherited overrides and unknown keys, preserve own __proto__ keys as data, and never mutate inputs. Keep the synchronous API and dependency-free implementation. Change only src/options.js and run npm test.',
    sources: { 'src/options.js': configSource },
    visibleTests: visibleHeader + `import { resolveOptions } from '../src/options.js';
test('CLI values and project fallback', () => {
  assert.deepEqual(resolveOptions({ color: true, retries: 3 }, { retries: 2 }, { color: false }), { color: false, retries: 2 });
});
`,
    checkIds: ['hidden_options_values', 'hidden_options_ownership', 'hidden_options_immutability'],
    hiddenChecks: `
    ['hidden_options_values', async () => {
      const { resolveOptions: r } = await load('src/options.js');
      for (const value of [false, 0, '', null, 7, 'yes']) {
        deepEqual(r({ a: 1 }, { a: 2 }, { a: value }), { a: value });
        deepEqual(r({ a: 1 }, { a: value }, { a: undefined }), { a: value });
      }
      deepEqual(r({ a: 1 }, { a: undefined }), { a: 1 });
    }],
    ['hidden_options_ownership', async () => {
      const { resolveOptions: r } = await load('src/options.js');
      deepEqual(r({ a: 1 }, Object.create({ a: 2 }), { extra: 4 }), { a: 1 });
      const defaults = JSON.parse('{"__proto__":3,"constructor":4}');
      const result = r(defaults, {}, JSON.parse('{"__proto__":false}'));
      equal(Object.hasOwn(result, '__proto__'), true);
      equal(result.__proto__, false);
      equal(result.constructor, 4);
    }],
    ['hidden_options_immutability', async () => {
      const { resolveOptions: r } = await load('src/options.js');
      const defaults = Object.freeze({ a: 1 });
      const project = Object.freeze({ a: 0 });
      const cli = Object.freeze({ a: undefined });
      deepEqual(r(defaults, project, cli), { a: 0 });
      deepEqual(defaults, { a: 1 });
      deepEqual(r({}), {});
    }],`,
  },
  {
    id: 'queue_cancellation',
    objective: 'Repair the existing async queue across src/queue.js and src/job.js. FIFO start order and concurrency limits must survive task rejection and synchronous throws. A job aborted before it starts must promptly reject with name AbortError, never execute, and immediately disappear from queued stats; pre-aborted jobs never enter the queue. Running tasks remain cooperative: pass their original signal, wait for actual settlement, and keep the slot occupied even after abort. Every started task releases exactly one slot on fulfillment or rejection. Remove abort listeners when no longer needed. Preserve the public add(task,{signal}) Promise and stats() APIs and concurrency validation. Centralize queued-job cancellation/listener lifecycle in job.js and scheduling in queue.js. Change only these two files, remain dependency-free, and run npm test.',
    sources: { 'src/job.js': queueJob, 'src/queue.js': queueSource },
    visibleTests: visibleHeader + `import { createQueue } from '../src/queue.js';
test('successful work drains in FIFO order', async () => {
  const q = createQueue(1), order = [];
  assert.deepEqual(await Promise.all([1,2,3].map(n => q.add(() => { order.push(n); return n * 2; }))), [2,4,6]);
  assert.deepEqual(order, [1,2,3]);
  assert.deepEqual(q.stats(), { active: 0, queued: 0 });
});
`,
    checkIds: ['hidden_queue_failures', 'hidden_queue_cancellation', 'hidden_queue_running'],
    hiddenChecks: `
    ['hidden_queue_failures', async () => {
      const { createQueue } = await load('src/queue.js');
      const q = createQueue(1), seen = [];
      const results = await Promise.allSettled([
        q.add(() => { throw new Error('sync'); }),
        q.add(() => Promise.reject(new Error('async'))),
        q.add(() => { seen.push(3); return 3; }),
      ]);
      deepEqual(results.map(r => r.status), ['rejected','rejected','fulfilled']);
      deepEqual(seen, [3]);
      deepEqual(q.stats(), { active: 0, queued: 0 });
      throws(() => createQueue(0), RangeError);
      throws(() => createQueue(1.5), RangeError);
    }],
    ['hidden_queue_cancellation', async () => {
      const { createQueue } = await load('src/queue.js');
      const q = createQueue(1), controller = new AbortController();
      let release, called = false;
      const first = q.add(() => new Promise(resolve => { release = resolve; }));
      await Promise.resolve();
      const cancelled = q.add(() => { called = true; }, { signal: controller.signal }).catch(e => e.name);
      controller.abort();
      deepEqual(q.stats(), { active: 1, queued: 0 });
      equal(await cancelled, 'AbortError');
      equal(called, false);
      release('done');
      equal(await first, 'done');
      equal(await q.add(() => { called = true; }, { signal: controller.signal }).catch(e => e.name), 'AbortError');
      equal(called, false);
      deepEqual(q.stats(), { active: 0, queued: 0 });
    }],
    ['hidden_queue_running', async () => {
      const { createQueue } = await load('src/queue.js');
      const q = createQueue(2), controller = new AbortController();
      let releaseA, releaseB, startedC = false, additions = 0, removals = 0;
      const signal = controller.signal;
      const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
      signal.addEventListener = (...args) => { additions++; return add(...args); };
      signal.removeEventListener = (...args) => { removals++; return remove(...args); };
      const a = q.add(s => { equal(s, signal); return new Promise(r => { releaseA = r; }); }, { signal });
      const b = q.add(() => new Promise(r => { releaseB = r; }));
      const c = q.add(() => { startedC = true; return 3; });
      await Promise.resolve();
      controller.abort();
      deepEqual(q.stats(), { active: 2, queued: 1 });
      equal(startedC, false);
      releaseA(1);
      equal(await a, 1);
      equal(await c, 3);
      releaseB(2);
      equal(await b, 2);
      deepEqual(q.stats(), { active: 0, queued: 0 });
      equal(additions, removals);
    }],`,
  },
  {
    id: 'workspace_maintenance',
    objective: 'Fix three independent existing workspace utility modules; each can be handled separately. src/paths.js: selectPaths returns sorted unique relative POSIX paths, converts backslashes, removes dot/empty segments, resolves internal dot-dot, rejects root escapes, absolute Unix/Windows/UNC paths and NUL, and skips any path with an excluded complete segment (default node_modules and .git). src/env.js: parseEnv handles LF/CRLF, blank lines and full-line comments, optional export prefix, valid [A-Za-z_][A-Za-z0-9_]* names, splits on the first =, trims outer whitespace, removes matching outer single/double quotes without escape expansion, keeps # and = inside values, last duplicate wins, ignores malformed lines, and keeps __proto__ as an own data key. src/redact.js: redact recursively clones JSON-like arrays/objects, replacing values for case-insensitive exact keys password/token/secret/api_key with [REDACTED], including non-string values; other keys and primitives remain unchanged and inputs never mutate. Preserve all exports, stay dependency-free, change only these three modules and run npm test. The immutable src/report.js combines them; its API must continue working.',
    sources: {
      'src/paths.js': `export function selectPaths(paths, excluded = ['node_modules', '.git']) {\n  return paths.filter(p => !excluded.some(part => p.includes(part))).sort();\n}\n`,
      'src/env.js': `export function parseEnv(text) {\n  return Object.fromEntries(text.split('\\n').filter(Boolean).map(line => line.split('=')));\n}\n`,
      'src/redact.js': `export function redact(value) {\n  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'password' ? '[REDACTED]' : item]));\n  return value;\n}\n`,
      'src/report.js': `import { selectPaths } from './paths.js';\nimport { parseEnv } from './env.js';\nimport { redact } from './redact.js';\nexport function report(paths, env) { return { files: selectPaths(paths), environment: redact(parseEnv(env)) }; }\n`,
    },
    parallelScopes: ['src/paths.js', 'src/env.js', 'src/redact.js'],
    visibleTests: visibleHeader + `import { report } from '../src/report.js';
test('report selects files and hides credentials', () => {
  assert.deepEqual(report(['src/a.js', 'node_modules/a.js'], 'USER=dev\\npassword=private'), { files: ['src/a.js'], environment: { USER: 'dev', password: '[REDACTED]' } });
});
`,
    checkIds: ['hidden_maintenance_paths', 'hidden_maintenance_env', 'hidden_maintenance_redact'],
    hiddenChecks: `
    ['hidden_maintenance_paths', async () => {
      const { selectPaths: s } = await load('src/paths.js');
      deepEqual(s(['src/a.js','./src//a.js','src/b/../c.js','src/node_modules/a','src/my_node_modules/a','../a','/a','C:\\\\a','\\\\\\\\server\\\\a','bad\\0x','.git/config','src\\\\z.js']), ['src/a.js','src/c.js','src/my_node_modules/a','src/z.js']);
      const input = Object.freeze(['b','a','b']);
      deepEqual(s(input), ['a','b']);
      deepEqual(s(['a/tmp/b','a/attempt/b'], ['tmp']), ['a/attempt/b']);
    }],
    ['hidden_maintenance_env', async () => {
      const { parseEnv: p } = await load('src/env.js');
      const result = p(' # comment\\r\\nexport A = "x=y#z"\\r\\nB=\\' hi \\'\\nA=last\\nBAD-NAME=no\\nmissing\\nEMPTY=\\n__proto__=safe');
      equal(result.A, 'last'); equal(result.B, ' hi '); equal(result.EMPTY, '');
      equal(Object.hasOwn(result, '__proto__'), true); equal(result.__proto__, 'safe');
      equal(Object.keys(result).length, 4);
      equal(p('A=x=y#z').A, 'x=y#z');
    }],
    ['hidden_maintenance_redact', async () => {
      const { redact: r } = await load('src/redact.js');
      const input = { list: [{ TOKEN: 'x', tokenCount: 2 }, null, 3], nested: { api_KEY: { x: 1 }, Secret: false }, password: 0 };
      const before = JSON.stringify(input), result = r(input);
      deepEqual(result, { list: [{ TOKEN: '[REDACTED]', tokenCount: 2 }, null, 3], nested: { api_KEY: '[REDACTED]', Secret: '[REDACTED]' }, password: '[REDACTED]' });
      equal(JSON.stringify(input), before); equal(result === input, false);
      const { report } = await load('src/report.js');
      deepEqual(report(['./a','a'], 'TOKEN=private'), { files: ['a'], environment: { TOKEN: '[REDACTED]' } });
    }],`,
  },
]);
