// These fixtures are deliberately authored tasks, not sampled public projects.
// Keep the complete inventory fixed before collecting any model results.
export const files = {
  "package.json": JSON.stringify({ name: "issue-desk", private: true, type: "module", scripts: { test: "node --test test/*.test.mjs" } }, null, 2) + "\n",
  "README.md": `# Issue Desk\n\nA dependency-free issue service. Run npm test.\n\nIssues have id, tenant, title, status (open or closed), and secret.\nCall createService(seed) from src/service.mjs. Every operation receives a tenant.\nlist(tenant, { after, limit }) returns { items, nextCursor }.\nIDs are unique and sorted lexicographically. A cursor is an exclusive issue ID.\nDefault page size is 20; explicit sizes must be integers from 1 to 100.\nOnly visible issues count toward pagination. nextCursor is null on the last page.\nReturned records must never contain secret or tenant.\nget(tenant, id) returns the public issue, or null for missing/foreign IDs.\nclose(tenant, id) closes a visible issue and returns its public record.\nMissing/foreign IDs throw an error with code NOT_FOUND.\n\nAll returned objects are detached: caller mutation must not change stored data.\n`,
  "src/store.mjs": `export function createStore(seed) {
  const records = structuredClone(seed);
  return {
    all: () => structuredClone(records),
    get: (id) => structuredClone(records.find((row) => row.id === id) ?? null),
    update(id, patch) {
      const row = records.find((item) => item.id === id);
      if (!row) throw new Error('Missing issue');
      Object.assign(row, patch);
      return structuredClone(row);
    },
  };
}
`,
  "src/public-issue.mjs": `export function publicIssue(row) {
  const { id, title, status } = row;
  return { id, title, status };
}
`,
  "src/service.mjs": `import { createStore } from './store.mjs';
import { publicIssue } from './public-issue.mjs';

export function createService(seed) {
  const store = createStore(seed);
  const requireIssue = (tenant, id) => {
    const row = store.get(id);
    if (!row || row.tenant !== tenant) {
      throw Object.assign(new Error('Issue not found'), { code: 'NOT_FOUND' });
    }
    return row;
  };
  return {
    list(tenant, { after = '', limit = 20 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw Object.assign(new Error('Invalid page size'), { code: 'INVALID_LIMIT' });
      }
      const visible = store.all().filter((row) => row.tenant === tenant && row.id > after)
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const page = visible.slice(0, limit);
      return {
        items: page.map(publicIssue),
        nextCursor: visible.length > limit ? page.at(-1).id : null,
      };
    },
    get(tenant, id) {
      const row = store.get(id);
      return row?.tenant === tenant ? publicIssue(row) : null;
    },
    close(tenant, id) {
      requireIssue(tenant, id);
      return publicIssue(store.update(id, { status: 'closed' }));
    },
  };
}
`,
  "test/service.test.mjs": `import assert from 'node:assert/strict';
import test from 'node:test';
import { createService } from '../src/service.mjs';
test('lists and closes an issue', () => {
  const service = createService([{ id: 'a', tenant: 'red', title: 'First', status: 'open', secret: 'private' }]);
  assert.equal(service.list('red').items[0].title, 'First');
  assert.equal(service.close('red', 'a').status, 'closed');
});
`,
};

export const mutations = {
  tenant: { file: "src/service.mjs", from: "if (!row || row.tenant !== tenant)", to: "if (!row)" },
  cursor: { file: "src/service.mjs", from: "row.id > after", to: "row.id >= after" },
  secret: { file: "src/public-issue.mjs", from: "return { id, title, status };", to: "return { ...row, id, title, status };" },
};

export function mutate(source, ids) {
  const result = { ...source };
  for (const id of ids) {
    const { file, from, to } = mutations[id];
    if (!result[file].includes(from)) throw new Error(`Mutation ${id} no longer applies`);
    result[file] = result[file].replace(from, to);
  }
  return result;
}

export const featureImplementation = `    closeMany(tenant, ids) {
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 ||
          ids.some((id) => typeof id !== 'string' || id.length === 0) ||
          new Set(ids).size !== ids.length) {
        throw Object.assign(new Error('Invalid IDs'), { code: 'INVALID_IDS' });
      }
      ids.forEach((id) => requireIssue(tenant, id));
      return ids.map((id) => publicIssue(store.update(id, { status: 'closed' })));
    },
`;

const shared = "Work only in this fixture. Use no network or external packages. Preserve documented behavior. Do not edit package.json or existing tests. Put new implementation tests in new test/*.test.mjs files. Run tests before finishing. ";
export const tasks = [
  {
    id: "fix-issues", label: "Fix reported bugs",
    prompt: shared + "Customers report that closing an issue can affect another tenant, following a page cursor repeats an issue, and private fields appear in responses. Fix the service, add regression tests, and briefly explain the fixes. Do not change the public API.",
    fixture: mutate(files, Object.keys(mutations)),
    reference: files,
  },
  {
    id: "build-bulk-close", label: "Build a feature",
    prompt: shared + "Add closeMany(tenant, ids) to the issue service, with tests and README documentation. Accept 1–100 unique nonempty string IDs. Reject any other input with code INVALID_IDS. If any ID is absent or belongs to another tenant, throw NOT_FOUND and change nothing. Otherwise close every requested issue, returning detached public records in request order. Already-closed issues are allowed. Keep list, get and close working.",
    fixture: files,
    reference: { ...files, "src/service.mjs": files["src/service.mjs"].replace("    close(tenant, id) {", featureImplementation + "    close(tenant, id) {") },
  },
  {
    id: "catch-regressions", label: "Catch hidden bugs",
    prompt: shared + "Audit this service against its README and write behavioral regression tests in review.test.mjs at the project root. This is a test-writing task: do not change src, README or existing tests. Your tests must use node:test, import ./src/service.mjs, and exercise the public API; do not inspect source text, filenames, environment, or grader files. The tests will also run against repaired code: correct behavior must pass. Focus on tenant isolation, cursor pagination, and private-field redaction. Describe any bugs you find in your final response.",
    fixture: mutate(files, Object.keys(mutations)),
    reference: files,
  },
];

export function getTask(id) {
  const task = tasks.find((item) => item.id === id);
  if (!task) throw new Error(`Unknown task: ${id}`);
  return task;
}
