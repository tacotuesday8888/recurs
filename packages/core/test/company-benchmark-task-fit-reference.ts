/** Test-only reference patches. Never materialized in model workspaces. */
export const TASK_FIT_REFERENCES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  options_precedence: {
    'src/options.js': `export function resolveOptions(defaults, project = {}, cli = {}) {
  return Object.fromEntries(Object.keys(defaults).map(key => {
    const source = [cli, project, defaults].find(layer => Object.hasOwn(layer, key) && layer[key] !== undefined);
    return [key, source?.[key]];
  }));
}
`,
  },
  queue_cancellation: {
    'src/job.js': `export function abortError() { const error = new Error('Job cancelled'); error.name = 'AbortError'; return error; }
export function createJob(task, signal, onCancel) {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  const job = { task, signal, promise, resolve, reject, state: 'queued', cleanup };
  function cleanup() { if (signal) signal.removeEventListener('abort', cancel); }
  function cancel() {
    if (job.state !== 'queued') return;
    job.state = 'cancelled';
    cleanup();
    onCancel(job);
    reject(abortError());
  }
  if (signal?.aborted) { job.state = 'cancelled'; reject(abortError()); }
  else if (signal) signal.addEventListener('abort', cancel);
  return job;
}
`,
    'src/queue.js': `import { createJob } from './job.js';
export function createQueue(concurrency = 1) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency');
  const pending = []; let active = 0;
  function remove(job) { const index = pending.indexOf(job); if (index >= 0) pending.splice(index, 1); }
  function pump() {
    while (active < concurrency && pending.length) {
      const job = pending.shift(); active++; job.state = 'running'; job.cleanup();
      const finish = (state, value) => {
        job.state = state; active--; pump();
        if (state === 'completed') job.resolve(value); else job.reject(value);
      };
      Promise.resolve().then(() => job.task(job.signal)).then(v => finish('completed', v), e => finish('failed', e));
    }
  }
  return {
    add(task, { signal } = {}) { const job = createJob(task, signal, remove); if (job.state === 'queued') { pending.push(job); pump(); } return job.promise; },
    stats() { return { active, queued: pending.length }; },
  };
}
`,
  },
  workspace_maintenance: {
    'src/paths.js': String.raw`export function selectPaths(paths, excluded = ['node_modules', '.git']) {
  const result = new Set();
  for (const original of paths) {
    const input = original.replace(/\\/g, '/');
    if (input.startsWith('/') || /^[A-Za-z]:/.test(input) || input.includes('\0')) continue;
    const parts = []; let valid = true;
    for (const part of input.split('/')) {
      if (!part || part === '.') continue;
      if (excluded.includes(part)) { valid = false; break; }
      if (part === '..') { if (!parts.length) { valid = false; break; } parts.pop(); }
      else parts.push(part);
    }
    if (valid && parts.length) result.add(parts.join('/'));
  }
  return [...result].sort();
}
`,
    'src/env.js': String.raw`export function parseEnv(text) {
  const entries = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim().replace(/^export\s+/, '');
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    entries.push([match[1], value]);
  }
  return Object.fromEntries(entries);
}
`,
    'src/redact.js': `export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, ['password','token','secret','api_key'].includes(key.toLowerCase()) ? '[REDACTED]' : redact(item)]));
  return value;
}
`,
  },
};
