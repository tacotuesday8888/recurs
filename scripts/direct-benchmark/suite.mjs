import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { tasks, getTask } from './fixtures.mjs';
import { grade, readCandidate, writeFiles } from './grade.mjs';

export function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function plan() {
  return {
    version: 1,
    name: 'Issue Desk: authored coding tasks',
    status: 'prepared_not_run',
    source: 'Recurs-authored fixtures; not a public benchmark or full-project sample',
    tasks: tasks.map(({ id, label, prompt, fixture }) => ({ id, label, prompt, fixtureSha256: digest(fixture) })),
    slots: tasks.flatMap((task) => [1, 2].flatMap((repetition) =>
      (repetition === 1 ? ['codex', 'recurs'] : ['recurs', 'codex']).map((arm) => ({
        id: `${task.id}-${repetition}-${arm}`, taskId: task.id, repetition, arm,
      })))),
    limits: { repetitions: 2, slots: 12, trialWallSeconds: 300, campaignWallSeconds: 3600 },
    metrics: ['tasks_finished', 'seeded_bugs_caught', 'wall_seconds', 'reported_input_tokens', 'reported_cached_input_tokens', 'reported_output_tokens', 'reported_cost_usd'],
    unknownCost: null,
    reviewRequired: 'Inspect candidate diffs and regression tests before publishing any outcome. No automatic superiority claim.',
  };
}

async function main(args) {
  const [command, taskId, destination] = args;
  if (command === 'plan' && args.length === 2) {
    // Exclusive creation keeps the predeclared inventory immutable by accident.
    await writeFile(path.resolve(taskId), JSON.stringify(plan(), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return;
  }
  if (command === 'prepare' && args.length === 3) {
    const task = getTask(taskId);
    await mkdir(path.resolve(destination), { recursive: false, mode: 0o700 });
    await writeFiles(path.resolve(destination), task.fixture);
    process.stdout.write(task.prompt + '\n');
    return;
  }
  if (command === 'grade' && args.length === 3) {
    const result = await grade(taskId, await readCandidate(path.resolve(destination)));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.passed ? 0 : 1;
    return;
  }
  if (command === 'check-plan' && args.length === 2) {
    const saved = JSON.parse(await readFile(taskId, 'utf8'));
    if (digest(saved) !== digest(plan())) throw new Error('Plan differs from current task inventory');
    process.stdout.write('Plan matches the complete fixed inventory. No model requests made.\n');
    return;
  }
  throw new Error('Usage: suite.mjs plan <new-file> | check-plan <file> | prepare <task-id> <new-directory> | grade <task-id> <directory>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
