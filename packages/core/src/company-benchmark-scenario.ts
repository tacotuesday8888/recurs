import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runProcess, ToolError } from "@recurs/tools";

const FILE_MODE = 0o644;
const DIRECTORY_MODE = 0o755;
const MAX_FILES = 32;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_INVENTORY_ENTRIES = 256;
const MAX_INVENTORY_DEPTH = 16;
const MAX_GIT_METADATA_ENTRIES = 4_096;

export interface CompanyBenchmarkFixtureFile {
  readonly path: string;
  readonly content: string;
  readonly mode: 0o644;
}

export interface CompanyBenchmarkScenario {
  readonly id: string;
  readonly version: 1;
  readonly taskClass: "general_coding";
  readonly difficulty: "medium";
  readonly verifierId: string;
  readonly fixtureSha256: string;
  readonly objectiveRevision: string;
  readonly objective: string;
  readonly files: readonly CompanyBenchmarkFixtureFile[];
  readonly allowedChangedPaths: readonly string[];
  readonly hiddenCheckIds: readonly CompanyBenchmarkHiddenCheckId[];
}

export type CompanyBenchmarkHiddenCheckId =
  | "hidden_alias_normalization"
  | "hidden_registry_boundaries"
  | "hidden_traversal_rejection"
  | "hidden_config_key_boundaries"
  | "hidden_layer_precedence"
  | "hidden_config_snapshot"
  | "hidden_retry_after_syntax"
  | "hidden_retry_after_boundaries"
  | "hidden_retry_after_dates";

export interface CompanyBenchmarkCheck {
  readonly id:
    | "workspace_inventory"
    | "git_state"
    | "allowed_changes"
    | "visible_tests"
    | CompanyBenchmarkHiddenCheckId;
  readonly status: "passed" | "failed";
}

export interface CompanyBenchmarkWorkspaceVerification {
  readonly status: "passed" | "failed";
  readonly checks: readonly CompanyBenchmarkCheck[];
}

type ProcessRunner = typeof runProcess;

const aliasPathSource = `
export function normalizeAliasPath(_value) {
  throw new Error("normalizeAliasPath is not implemented");
}
`.trimStart();

const aliasRegistrySource = `
import { normalizeAliasPath } from "./alias-path.js";

export function createAliasRegistry(_entries) {
  void normalizeAliasPath;
  throw new Error("createAliasRegistry is not implemented");
}
`.trimStart();

const visibleTests = `
import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAliasPath } from "../src/alias-path.js";
import { createAliasRegistry } from "../src/alias-registry.js";

test("normalizes aliases without escaping their root", () => {
  assert.equal(normalizeAliasPath("@docs/guide/../api"), "@docs/api");
  assert.throws(() => normalizeAliasPath("@docs/../secrets"), TypeError);
});

test("resolves aliases only at segment boundaries", () => {
  const registry = createAliasRegistry([
    { alias: "@app", target: "src" },
    { alias: "@app/ui", target: "src/components" },
  ]);
  assert.equal(registry.resolve("@app/ui/button"), "src/components/button");
  assert.equal(registry.resolve("@app/utils"), "src/utils");
  assert.equal(registry.resolve("@application/file"), null);
});
`.trimStart();

const readme = `
# Alias registry benchmark

Implement the two functions in \`src/\` without dependencies or changes to the
public tests.

- Alias inputs use \`@name[/segments]\`, where names are lowercase ASCII
  identifiers up to 32 characters.
- Empty and \`.\` path segments collapse. \`..\` may remove a segment but must
  never escape the alias root. Backslashes, NUL bytes, absolute inputs, and
  invalid names are rejected with \`TypeError\`.
- Registry entries are \`{ alias, target }\`. Targets are safe relative POSIX
  paths. Canonically duplicate aliases and unsafe targets are rejected.
- Resolution chooses the longest alias at a complete segment boundary and
  returns a relative POSIX path, or \`null\` when no alias matches.
`.trimStart();

function digestFixture(files: readonly CompanyBenchmarkFixtureFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(file.mode));
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

const aliasRegistryFiles = Object.freeze([
  Object.freeze({
    path: "README.md",
    content: readme,
    mode: FILE_MODE,
  }),
  Object.freeze({
    path: "package.json",
    content: `${JSON.stringify({
      name: "recurs-benchmark-alias-registry",
      private: true,
      type: "module",
      scripts: { test: "node --test" },
    }, null, 2)}\n`,
    mode: FILE_MODE,
  }),
  Object.freeze({
    path: "src/alias-path.js",
    content: aliasPathSource,
    mode: FILE_MODE,
  }),
  Object.freeze({
    path: "src/alias-registry.js",
    content: aliasRegistrySource,
    mode: FILE_MODE,
  }),
  Object.freeze({
    path: "test/alias-registry.test.js",
    content: visibleTests,
    mode: FILE_MODE,
  }),
] satisfies readonly CompanyBenchmarkFixtureFile[]);

const aliasRegistryScenario = Object.freeze({
  id: "alias_registry",
  version: 1,
  taskClass: "general_coding",
  difficulty: "medium",
  verifierId: "alias_registry_hidden_v1",
  fixtureSha256: digestFixture(aliasRegistryFiles),
  objectiveRevision: "alias_registry_objective_v1",
  objective: [
    "Implement the alias path normalizer and longest-boundary alias registry",
    "described in README.md. Keep the change dependency-free and confined to",
    "src/alias-path.js and src/alias-registry.js. Run the visible tests.",
  ].join(" "),
  files: aliasRegistryFiles,
  allowedChangedPaths: Object.freeze([
    "src/alias-path.js",
    "src/alias-registry.js",
  ]),
  hiddenCheckIds: Object.freeze([
    "hidden_alias_normalization",
    "hidden_registry_boundaries",
    "hidden_traversal_rejection",
  ]),
} satisfies CompanyBenchmarkScenario);

const configKeySource = `
export function normalizeConfigKey(_value) {
  throw new Error("normalizeConfigKey is not implemented");
}
`.trimStart();

const layeredConfigSource = `
import { normalizeConfigKey } from "./config-key.js";

export function createLayeredConfig(_layers) {
  void normalizeConfigKey;
  throw new Error("createLayeredConfig is not implemented");
}
`.trimStart();

const layeredConfigVisibleTests = `
import assert from "node:assert/strict";
import test from "node:test";

import { normalizeConfigKey } from "../src/config-key.js";
import { createLayeredConfig } from "../src/layered-config.js";

test("normalizes safe dotted keys", () => {
  assert.equal(normalizeConfigKey("editor.tab-size"), "editor.tab-size");
  assert.throws(() => normalizeConfigKey("Editor.tab-size"), TypeError);
});

test("applies later layers and explicit deletion", () => {
  const config = createLayeredConfig([
    [
      { key: "editor.theme", value: "dark" },
      { key: "editor.tab-size", value: 2 },
    ],
    [
      { key: "editor.tab-size", value: 4 },
      { key: "editor.theme", value: null },
    ],
  ]);
  assert.equal(config.get("editor.tab-size"), 4);
  assert.equal(config.get("editor.theme"), null);
  assert.deepEqual(config.keys(), ["editor.tab-size"]);
});
`.trimStart();

const layeredConfigReadme = `
# Layered configuration benchmark

Implement the two functions in \`src/\` without dependencies or changes to the
public tests.

- Configuration keys are one or more lowercase ASCII identifier segments
  separated by dots. Each segment starts with a letter, contains at most 32
  letters, digits, underscores, or hyphens, and may not be \`__proto__\`,
  \`prototype\`, or \`constructor\`.
- \`createLayeredConfig(layers)\` accepts an array of layers. Each layer is an
  array of \`{ key, value }\` entries. Values are strings, finite numbers,
  booleans, or \`null\`; \`null\` deletes a value from earlier layers.
- Canonically duplicate keys inside one layer are rejected. Later layers
  override earlier layers. Inputs are never mutated.
- The returned frozen registry exposes \`get(key)\`, returning a value or
  \`null\`, and \`keys()\`, returning a new sorted array of canonical keys.
`.trimStart();

const layeredConfigFiles = Object.freeze([
  Object.freeze({
    path: "README.md",
    content: layeredConfigReadme,
    mode: FILE_MODE,
  }),
  Object.freeze({
    path: "package.json",
    content: `${JSON.stringify({
      name: "recurs-benchmark-layered-config",
      private: true,
      type: "module",
      scripts: { test: "node --test" },
    }, null, 2)}\n`,
    mode: FILE_MODE,
  }),
  Object.freeze({
    path: "src/config-key.js",
    content: configKeySource,
    mode: FILE_MODE,
  }),
  Object.freeze({
    path: "src/layered-config.js",
    content: layeredConfigSource,
    mode: FILE_MODE,
  }),
  Object.freeze({
    path: "test/layered-config.test.js",
    content: layeredConfigVisibleTests,
    mode: FILE_MODE,
  }),
] satisfies readonly CompanyBenchmarkFixtureFile[]);

const layeredConfigScenario = Object.freeze({
  id: "layered_config",
  version: 1,
  taskClass: "general_coding",
  difficulty: "medium",
  verifierId: "layered_config_hidden_v1",
  fixtureSha256: digestFixture(layeredConfigFiles),
  objectiveRevision: "layered_config_objective_v1",
  objective: [
    "Implement the safe dotted-key normalizer and immutable layered",
    "configuration registry described in README.md. Keep the change",
    "dependency-free and confined to src/config-key.js and",
    "src/layered-config.js. Run the visible tests.",
  ].join(" "),
  files: layeredConfigFiles,
  allowedChangedPaths: Object.freeze([
    "src/config-key.js",
    "src/layered-config.js",
  ]),
  hiddenCheckIds: Object.freeze([
    "hidden_config_key_boundaries",
    "hidden_layer_precedence",
    "hidden_config_snapshot",
  ]),
} satisfies CompanyBenchmarkScenario);

const retryAfterSource = `
export function parseRetryAfter(_value, _nowMs, _maximumDelayMs) {
  throw new Error("parseRetryAfter is not implemented");
}
`.trimStart();

const retryAfterVisibleTests = `
import assert from "node:assert/strict";
import test from "node:test";

import { parseRetryAfter } from "../src/retry-after.js";

test("parses delta seconds and clamps the delay", () => {
  assert.equal(parseRetryAfter("3", 0, 10_000), 3_000);
  assert.equal(parseRetryAfter("30", 0, 5_000), 5_000);
});

test("parses an IMF-fixdate relative to the supplied clock", () => {
  const now = Date.parse("Sun, 06 Nov 1994 08:49:35 GMT");
  assert.equal(
    parseRetryAfter("Sun, 06 Nov 1994 08:49:37 GMT", now, 10_000),
    2_000,
  );
  assert.equal(parseRetryAfter("not a date", now, 10_000), null);
});
`.trimStart();

const retryAfterReadme = `
# Retry-After benchmark

Implement \`parseRetryAfter(value, nowMs, maximumDelayMs)\` in \`src/\` without
dependencies or changes to the public tests.

- Return a whole-millisecond delay, or \`null\` for invalid input.
- \`value\` must be either non-negative ASCII decimal seconds with no sign,
  whitespace, or fraction, or an exact IMF-fixdate ending in \`GMT\`.
- \`nowMs\` and \`maximumDelayMs\` must be non-negative finite safe integers.
- Past dates return zero. Valid delays are clamped to \`maximumDelayMs\`.
- Reject overflows, impossible dates, alternate date formats, and invalid
  argument types. Do not read the system clock.
`.trimStart();

const retryAfterFiles = Object.freeze([
  Object.freeze({
    path: "README.md",
    content: retryAfterReadme,
    mode: FILE_MODE,
  }),
  Object.freeze({
    path: "package.json",
    content: `${JSON.stringify({
      name: "recurs-benchmark-retry-after",
      private: true,
      type: "module",
      scripts: { test: "node --test" },
    }, null, 2)}\n`,
    mode: FILE_MODE,
  }),
  Object.freeze({
    path: "src/retry-after.js",
    content: retryAfterSource,
    mode: FILE_MODE,
  }),
  Object.freeze({
    path: "test/retry-after.test.js",
    content: retryAfterVisibleTests,
    mode: FILE_MODE,
  }),
] satisfies readonly CompanyBenchmarkFixtureFile[]);

const retryAfterScenario = Object.freeze({
  id: "retry_after",
  version: 1,
  taskClass: "general_coding",
  difficulty: "medium",
  verifierId: "retry_after_hidden_v1",
  fixtureSha256: digestFixture(retryAfterFiles),
  objectiveRevision: "retry_after_objective_v1",
  objective: [
    "Implement the strict bounded Retry-After parser described in README.md.",
    "Keep the change dependency-free and confined to src/retry-after.js.",
    "Run the visible tests.",
  ].join(" "),
  files: retryAfterFiles,
  allowedChangedPaths: Object.freeze(["src/retry-after.js"]),
  hiddenCheckIds: Object.freeze([
    "hidden_retry_after_syntax",
    "hidden_retry_after_boundaries",
    "hidden_retry_after_dates",
  ]),
} satisfies CompanyBenchmarkScenario);

export const COMPANY_BENCHMARK_SCENARIOS = Object.freeze([
  aliasRegistryScenario,
  layeredConfigScenario,
  retryAfterScenario,
] as const);

export function getCompanyBenchmarkScenario(
  id: string,
  version: number,
): CompanyBenchmarkScenario {
  const scenario = COMPANY_BENCHMARK_SCENARIOS.find((candidate) =>
    candidate.id === id && candidate.version === version
  );
  if (scenario === undefined) {
    throw new TypeError(`Unknown company benchmark scenario: ${id} v${version}`);
  }
  return scenario;
}

function safeRelativePath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > 4_096 ||
    path.isAbsolute(candidate) || candidate.includes("\\") ||
    candidate.includes("\0")) {
    return false;
  }
  return candidate.split("/").every((part) =>
    part.length > 0 && part !== "." && part !== ".."
  );
}

async function requireCanonicalDirectory(root: string): Promise<string> {
  const resolved = path.resolve(root);
  const details = await lstat(resolved);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new TypeError("Company benchmark workspace must be a canonical directory");
  }
  const canonical = await realpath(resolved);
  const canonicalDetails = await lstat(canonical);
  if (!canonicalDetails.isDirectory() || canonicalDetails.isSymbolicLink()) {
    throw new TypeError("Company benchmark workspace must be a canonical directory");
  }
  return canonical;
}

export async function materializeCompanyBenchmarkScenario(
  scenario: CompanyBenchmarkScenario,
  workspaceRoot: string,
): Promise<void> {
  const root = await requireCanonicalDirectory(workspaceRoot);
  if ((await readdir(root)).length !== 0) {
    throw new TypeError("Company benchmark workspace must be empty");
  }
  if (scenario.files.length === 0 || scenario.files.length > MAX_FILES ||
    scenario.fixtureSha256 !== digestFixture(scenario.files)) {
    throw new TypeError("Company benchmark fixture is invalid");
  }
  const directories = new Set<string>();
  for (const file of scenario.files) {
    if (!safeRelativePath(file.path) ||
      Buffer.byteLength(file.content, "utf8") > MAX_FILE_BYTES ||
      file.mode !== FILE_MODE) {
      throw new TypeError("Company benchmark fixture file is invalid");
    }
    let parent = path.posix.dirname(file.path);
    while (parent !== ".") {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  for (const directory of [...directories].sort((left, right) =>
    left.split("/").length - right.split("/").length ||
    left.localeCompare(right)
  )) {
    await mkdir(path.join(root, directory), { mode: DIRECTORY_MODE });
  }
  for (const file of scenario.files) {
    const handle = await open(path.join(root, file.path), "wx", file.mode);
    try {
      await handle.writeFile(file.content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

async function containedProcess(
  runner: ProcessRunner,
  command: string,
  args: readonly string[],
  root: string,
  signal?: AbortSignal,
  options: {
    readonly workspaceAccess?: "read_write" | "read_only";
    readonly readOnlyPaths?: readonly string[];
    readonly stdin?: string;
    readonly acceptableExitCodes?: readonly number[];
  } = {},
) {
  signal?.throwIfAborted();
  return await runner(command, args, {
    cwd: root,
    ...(signal === undefined ? {} : { signal }),
    timeoutMs: 15_000,
    maxOutputBytes: 16 * 1024,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.acceptableExitCodes === undefined
      ? {}
      : { acceptableExitCodes: options.acceptableExitCodes }),
    sandbox: {
      mode: "workspace",
      network: "deny",
      workspaceAccess: options.workspaceAccess ?? "read_write",
      ...(options.readOnlyPaths === undefined
        ? {}
        : { readOnlyPaths: options.readOnlyPaths }),
    },
  });
}

export async function initializeCompanyBenchmarkWorkspace(input: {
  readonly scenario: CompanyBenchmarkScenario;
  readonly workspaceRoot: string;
  readonly signal?: AbortSignal;
  readonly processRunner?: ProcessRunner;
}): Promise<{ readonly baseRevision: string }> {
  await materializeCompanyBenchmarkScenario(
    input.scenario,
    input.workspaceRoot,
  );
  const root = await requireCanonicalDirectory(input.workspaceRoot);
  const runner = input.processRunner ?? runProcess;
  await containedProcess(
    runner,
    "git",
    ["init", "--quiet", "--initial-branch=main"],
    root,
    input.signal,
  );
  await containedProcess(
    runner,
    "git",
    ["add", "--all"],
    root,
    input.signal,
  );
  await containedProcess(
    runner,
    "git",
    [
      "-c", "user.name=Recurs Benchmark",
      "-c", "user.email=benchmark@recurs.local",
      "-c", "commit.gpgSign=false",
      "commit", "--quiet", "--message=benchmark fixture",
    ],
    root,
    input.signal,
  );
  const revision = (
    await containedProcess(
      runner,
      "git",
      ["rev-parse", "--verify", "HEAD"],
      root,
      input.signal,
    )
  ).stdout.trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(revision)) {
    throw new TypeError("Company benchmark Git base revision is invalid");
  }
  return Object.freeze({ baseRevision: revision });
}

async function inventoryIsSafe(
  scenario: CompanyBenchmarkScenario,
  root: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const expected = new Map(scenario.files.map((file) => [file.path, file] as const));
  const discovered: string[] = [];
  let visitedEntries = 0;
  const visit = async (
    directory: string,
    prefix: string,
    depth: number,
  ): Promise<boolean> => {
    signal?.throwIfAborted();
    if (depth > MAX_INVENTORY_DEPTH) return false;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      signal?.throwIfAborted();
      visitedEntries += 1;
      if (visitedEntries > MAX_INVENTORY_ENTRIES) return false;
      if (prefix === "" && entry.name === ".git") {
        const gitDetails = await lstat(path.join(directory, entry.name));
        if (!gitDetails.isDirectory() || gitDetails.isSymbolicLink() ||
          (gitDetails.mode & 0o022) !== 0) return false;
        continue;
      }
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      const details = await lstat(absolute);
      if (details.isSymbolicLink()) return false;
      if (details.isDirectory()) {
        if ((details.mode & 0o022) !== 0 ||
          !await visit(absolute, relative, depth + 1)) return false;
      } else if (details.isFile()) {
        if ((details.mode & 0o777) !== FILE_MODE ||
          details.size > MAX_FILE_BYTES) return false;
        discovered.push(relative);
      } else {
        return false;
      }
    }
    return true;
  };
  if (!await visit(root, "", 0)) return false;
  if (discovered.length !== expected.size ||
    discovered.some((file) => !expected.has(file))) return false;
  for (const [filePath, file] of expected) {
    if (scenario.allowedChangedPaths.includes(filePath)) continue;
    if (await readFile(path.join(root, filePath), "utf8") !== file.content) {
      return false;
    }
  }
  return true;
}

function hiddenVerifierProgram(checks: string): string {
  return `
  import assert from "node:assert/strict";
  import { createHmac } from "node:crypto";
  import { readFileSync } from "node:fs";
  import path from "node:path";
  import { pathToFileURL } from "node:url";

  const key = readFileSync(0);
  const hmac = createHmac("sha256", key);
  key.fill(0);
  const equal = assert.equal.bind(assert);
  const deepEqual = assert.deepEqual.bind(assert);
  const throws = assert.throws.bind(assert);
  const safeApply = Reflect.apply;
  const safeStringify = JSON.stringify.bind(JSON);
  const safeWrite = process.stdout.write.bind(process.stdout);
  const prototype = Object.getPrototypeOf(hmac);
  const update = prototype.update;
  const digest = prototype.digest;
  const authenticate = (payload) => {
    safeApply(update, hmac, [payload, "utf8"]);
    return safeApply(digest, hmac, ["hex"]);
  };
  const load = (relative) =>
    import(pathToFileURL(path.join(process.cwd(), relative)).href);
  const checks = [
${checks}
  ];
  const results = new Array(checks.length);
  for (let index = 0; index < checks.length; index += 1) {
    const current = checks[index];
    const id = current[0];
    const check = current[1];
    try {
      await check();
      results[index] = { id, status: "passed" };
    } catch {
      results[index] = { id, status: "failed" };
    }
  }
  const payload = safeStringify({ version: 2, checks: results });
  safeWrite(safeStringify({
    version: 2,
    checks: results,
    authenticator: authenticate(payload),
  }));
`.trimStart();
}

const ALIAS_HIDDEN_VERIFIER_SOURCE = hiddenVerifierProgram(`
    ["hidden_alias_normalization", async () => {
      const { normalizeAliasPath: n } = await load("src/alias-path.js");
      equal(n("@docs//guide/./api"), "@docs/guide/api");
      equal(n("@a-b_2"), "@a-b_2");
      throws(() => n("@Docs/file"), TypeError);
      throws(() => n("@1docs/file"), TypeError);
      throws(() => n("@${"a".repeat(33)}/file"), TypeError);
    }],
    ["hidden_registry_boundaries", async () => {
      const { createAliasRegistry: create } =
        await load("src/alias-registry.js");
      const registry = create([
        { alias: "@pkg", target: "src/pkg" },
        { alias: "@pkg/ui/.", target: "./src/ui/" },
      ]);
      equal(registry.resolve("@pkg/ui/button"), "src/ui/button");
      equal(registry.resolve("@pkg/util"), "src/pkg/util");
      equal(registry.resolve("@pkg-extra/file"), null);
      equal(registry.resolve("@missing"), null);
      throws(() => create([
        { alias: "@pkg/ui", target: "a" },
        { alias: "@pkg/ui/.", target: "b" },
      ]), TypeError);
    }],
    ["hidden_traversal_rejection", async () => {
      const { normalizeAliasPath: n } = await load("src/alias-path.js");
      const { createAliasRegistry: create } =
        await load("src/alias-registry.js");
      for (const value of ["../x", "/x", "x\\\\y", "x\\0y"]) {
        throws(() => create([{ alias: "@x", target: value }]), TypeError);
      }
      for (const value of ["@x/../../y", "/@x/y", "@x\\\\y", "@x\\0y"]) {
        throws(() => n(value), TypeError);
      }
      const registry = create([{ alias: "@x", target: "src/x" }]);
      throws(() => registry.resolve("@x/../../secret"), TypeError);
    }],
`);

const LAYERED_CONFIG_HIDDEN_VERIFIER_SOURCE = hiddenVerifierProgram(`
    ["hidden_config_key_boundaries", async () => {
      const { normalizeConfigKey: normalize } =
        await load("src/config-key.js");
      equal(normalize("build.cache-dir"), "build.cache-dir");
      for (const value of [
        "", ".build", "build.", "build..cache", "Build.cache",
        "build.__proto__", "constructor", "build/prod", " build.prod",
      ]) {
        throws(() => normalize(value), TypeError);
      }
    }],
    ["hidden_layer_precedence", async () => {
      const { createLayeredConfig: create } =
        await load("src/layered-config.js");
      const config = create([
        [
          { key: "build.mode", value: "safe" },
          { key: "build.count", value: 1 },
        ],
        [
          { key: "build.count", value: 2 },
          { key: "build.enabled", value: true },
        ],
      ]);
      equal(config.get("build.mode"), "safe");
      equal(config.get("build.count"), 2);
      equal(config.get("build.enabled"), true);
      equal(config.get("build.missing"), null);
      throws(() => create([[
        { key: "build.mode", value: "a" },
        { key: "build.mode", value: "b" },
      ]]), TypeError);
    }],
    ["hidden_config_snapshot", async () => {
      const { createLayeredConfig: create } =
        await load("src/layered-config.js");
      const layers = [[{ key: "z.value", value: 1 }]];
      const config = create(layers);
      layers[0][0].value = 9;
      layers.push([{ key: "a.value", value: 2 }]);
      equal(config.get("z.value"), 1);
      deepEqual(config.keys(), ["z.value"]);
      const first = config.keys();
      first.push("mutated");
      deepEqual(config.keys(), ["z.value"]);
      equal(Object.isFrozen(config), true);
      for (const value of [NaN, Infinity, {}, [], undefined]) {
        throws(() => create([[
          { key: "build.value", value },
        ]]), TypeError);
      }
    }],
`);

const RETRY_AFTER_HIDDEN_VERIFIER_SOURCE = hiddenVerifierProgram(`
    ["hidden_retry_after_syntax", async () => {
      const { parseRetryAfter: parse } =
        await load("src/retry-after.js");
      for (const value of [" 1", "1 ", "+1", "-1", "1.5", "1e3", ""]) {
        equal(parse(value, 0, 10_000), null);
      }
      equal(parse(1, 0, 10_000), null);
      equal(parse("1", -1, 10_000), null);
      equal(parse("1", 0, Infinity), null);
    }],
    ["hidden_retry_after_boundaries", async () => {
      const { parseRetryAfter: parse } =
        await load("src/retry-after.js");
      equal(parse("0", 0, 10_000), 0);
      equal(parse("10", 0, 9_999), 9_999);
      equal(parse(String(Number.MAX_SAFE_INTEGER), 0, 10_000), null);
      equal(parse("999999999999999999999999", 0, 10_000), null);
      equal(parse("1", 0, 0), 0);
    }],
    ["hidden_retry_after_dates", async () => {
      const { parseRetryAfter: parse } =
        await load("src/retry-after.js");
      const now = Date.parse("Sun, 06 Nov 1994 08:49:37 GMT");
      equal(
        parse("Sun, 06 Nov 1994 08:49:37 GMT", now, 10_000),
        0,
      );
      equal(
        parse("Sun, 06 Nov 1994 08:49:36 GMT", now, 10_000),
        0,
      );
      equal(
        parse("Sunday, 06-Nov-94 08:49:37 GMT", now, 10_000),
        null,
      );
      equal(
        parse("Mon, 06 Nov 1994 08:49:37 GMT", now, 10_000),
        null,
      );
      equal(
        parse("Sun, 31 Feb 1994 08:49:37 GMT", now, 10_000),
        null,
      );
    }],
`);

function hiddenVerifierSource(
  scenario: CompanyBenchmarkScenario,
): string {
  if (scenario.id === "alias_registry") return ALIAS_HIDDEN_VERIFIER_SOURCE;
  if (scenario.id === "layered_config") {
    return LAYERED_CONFIG_HIDDEN_VERIFIER_SOURCE;
  }
  if (scenario.id === "retry_after") {
    return RETRY_AFTER_HIDDEN_VERIFIER_SOURCE;
  }
  throw new TypeError("Company benchmark verifier is unavailable");
}

async function processCheck(
  runner: ProcessRunner,
  root: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<"passed" | "failed"> {
  signal?.throwIfAborted();
  try {
    await containedProcess(
      runner,
      process.execPath,
      args,
      root,
      signal,
      { workspaceAccess: "read_only" },
    );
    return "passed";
  } catch (error) {
    if (signal?.aborted === true ||
      error instanceof ToolError && error.code === "cancelled") {
      throw new DOMException("Company benchmark verification was cancelled", "AbortError");
    }
    return "failed";
  }
}

function hiddenVerifierResult(
  value: unknown,
  expectedIds: readonly CompanyBenchmarkHiddenCheckId[],
  secret: string,
): CompanyBenchmarkCheck[] | null {
  if (typeof value !== "object" || value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "authenticator,checks,version" ||
    (value as { version?: unknown }).version !== 2) {
    return null;
  }
  const candidate = value as {
    checks?: unknown;
    authenticator?: unknown;
  };
  const rawChecks = candidate.checks;
  if (!Array.isArray(rawChecks) || rawChecks.length !== expectedIds.length) {
    return null;
  }
  const checks: CompanyBenchmarkCheck[] = [];
  for (const [index, raw] of rawChecks.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw) ||
      Object.keys(raw).sort().join(",") !== "id,status") {
      return null;
    }
    const check = raw as { id?: unknown; status?: unknown };
    const expectedId = expectedIds[index];
    if (expectedId === undefined || check.id !== expectedId ||
      check.status !== "passed" && check.status !== "failed") {
      return null;
    }
    checks.push({ id: expectedId, status: check.status });
  }
  if (typeof candidate.authenticator !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.authenticator)) {
    return null;
  }
  const expected = createHmac("sha256", secret)
    .update(JSON.stringify({ version: 2, checks }), "utf8")
    .digest();
  const received = Buffer.from(candidate.authenticator, "hex");
  if (received.length !== expected.length ||
    !timingSafeEqual(received, expected)) {
    return null;
  }
  return checks;
}

async function runHiddenVerifier(
  scenario: CompanyBenchmarkScenario,
  runner: ProcessRunner,
  root: string,
  signal?: AbortSignal,
): Promise<readonly CompanyBenchmarkCheck[]> {
  signal?.throwIfAborted();
  const verifierRoot = await mkdtemp(
    path.join(tmpdir(), "recurs-company-verifier-"),
  );
  const canonicalVerifierRoot = await realpath(verifierRoot);
  const verifierPath = path.join(canonicalVerifierRoot, "verifier.mjs");
  const secret = randomBytes(32).toString("hex");
  try {
    const handle = await open(verifierPath, "wx", 0o400);
    try {
      await handle.writeFile(hiddenVerifierSource(scenario), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(verifierPath, 0o400);
    const result = await containedProcess(
      runner,
      process.execPath,
      [
        "--permission",
        `--allow-fs-read=${root}`,
        `--allow-fs-read=${canonicalVerifierRoot}`,
        "--frozen-intrinsics",
        verifierPath,
      ],
      root,
      signal,
      {
        workspaceAccess: "read_only",
        readOnlyPaths: [canonicalVerifierRoot],
        stdin: secret,
        acceptableExitCodes: [0, 1],
      },
    );
    if (result.exitCode !== 0) {
      return scenario.hiddenCheckIds.map((id) => ({ id, status: "failed" }));
    }
    const parsed = hiddenVerifierResult(
      JSON.parse(result.stdout),
      scenario.hiddenCheckIds,
      secret,
    );
    if (parsed !== null) return Object.freeze(parsed);
  } catch (error) {
    if (signal?.aborted === true ||
      error instanceof ToolError && error.code === "cancelled") {
      throw new DOMException(
        "Company benchmark verification was cancelled",
        "AbortError",
      );
    }
  } finally {
    await chmod(canonicalVerifierRoot, 0o700).catch(() => {});
    await rm(verifierRoot, { recursive: true, force: true });
  }
  return scenario.hiddenCheckIds.map((id) => ({ id, status: "failed" }));
}

function nulPaths(serialized: string): readonly string[] | null {
  if (serialized.length === 0) return [];
  if (!serialized.endsWith("\0")) return null;
  const values = serialized.slice(0, -1).split("\0");
  return values.every(safeRelativePath) ? values : null;
}

const HARDENED_GIT_PREFIX = Object.freeze([
  "--no-replace-objects",
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", "submodule.recurse=false",
] as const);

function hardenedGitArgs(args: readonly string[]): readonly string[] {
  return [...HARDENED_GIT_PREFIX, ...args];
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : undefined;
}

async function gitControlStateIsSafe(
  runner: ProcessRunner,
  root: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const gitRoot = path.join(root, ".git");
  const gitDetails = await lstat(gitRoot);
  if (!gitDetails.isDirectory() || gitDetails.isSymbolicLink() ||
    await realpath(gitRoot) !== gitRoot) {
    return false;
  }
  let metadataEntries = 0;
  const inspectMetadata = async (
    directory: string,
    depth: number,
  ): Promise<boolean> => {
    signal?.throwIfAborted();
    if (depth > MAX_INVENTORY_DEPTH) return false;
    const entries = await opendir(directory);
    for await (const entry of entries) {
      signal?.throwIfAborted();
      metadataEntries += 1;
      if (metadataEntries > MAX_GIT_METADATA_ENTRIES) return false;
      const details = await lstat(path.join(directory, entry.name));
      if (details.isSymbolicLink()) return false;
      if (details.isDirectory()) {
        if ((details.mode & 0o022) !== 0 ||
          !await inspectMetadata(
            path.join(directory, entry.name),
            depth + 1,
          )) return false;
      } else if (!details.isFile()) {
        return false;
      }
    }
    return true;
  };
  if (!await inspectMetadata(gitRoot, 0)) return false;
  for (const relative of [
    "commondir",
    "shallow",
    "info/grafts",
    "objects/info/alternates",
    "objects/info/http-alternates",
    "refs/replace",
  ]) {
    try {
      await lstat(path.join(gitRoot, relative));
      return false;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  for (const relative of ["HEAD", "config", "objects", "refs"]) {
    const absolute = path.join(gitRoot, relative);
    const details = await lstat(absolute);
    if (details.isSymbolicLink() ||
      await realpath(absolute) !== absolute) return false;
  }
  const configNames = nulPaths((
    await containedProcess(
      runner,
      "git",
      hardenedGitArgs([
        "config", "--local", "--no-includes", "--name-only", "-z", "--list",
      ]),
      root,
      signal,
      { workspaceAccess: "read_only" },
    )
  ).stdout);
  const allowedConfig = new Set([
    "core.repositoryformatversion",
    "core.filemode",
    "core.bare",
    "core.logallrefupdates",
    "core.ignorecase",
    "core.precomposeunicode",
  ]);
  return configNames !== null &&
    new Set(configNames).size === configNames.length &&
    configNames.every((name) => allowedConfig.has(name));
}

async function inspectGitState(
  runner: ProcessRunner,
  root: string,
  baseRevision: string,
  signal?: AbortSignal,
): Promise<{
  readonly valid: boolean;
  readonly changedFiles: readonly string[];
}> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(baseRevision)) {
    return { valid: false, changedFiles: [] };
  }
  try {
    if (!await gitControlStateIsSafe(runner, root, signal)) {
      return { valid: false, changedFiles: [] };
    }
    const top = (
      await containedProcess(
        runner,
        "git",
        hardenedGitArgs(["rev-parse", "--show-toplevel"]),
        root,
        signal,
        { workspaceAccess: "read_only" },
      )
    ).stdout.trim();
    if (await realpath(top) !== root) return { valid: false, changedFiles: [] };
    await containedProcess(
        runner,
        "git",
        hardenedGitArgs(["cat-file", "-e", `${baseRevision}^{commit}`]),
        root,
        signal,
        { workspaceAccess: "read_only" },
      );
    await containedProcess(
        runner,
        "git",
        hardenedGitArgs([
          "merge-base", "--is-ancestor", baseRevision, "HEAD",
        ]),
        root,
        signal,
        { workspaceAccess: "read_only" },
      );
    const tracked = nulPaths((
      await containedProcess(
        runner,
        "git",
        hardenedGitArgs([
          "diff", "--name-only", "--no-renames", "-z", baseRevision, "--",
        ]),
        root,
        signal,
        { workspaceAccess: "read_only" },
      )
    ).stdout);
    const untracked = nulPaths((
      await containedProcess(
        runner,
        "git",
        hardenedGitArgs(["ls-files", "--others", "-z"]),
        root,
        signal,
        { workspaceAccess: "read_only" },
      )
    ).stdout);
    if (tracked === null || untracked === null) {
      return { valid: false, changedFiles: [] };
    }
    return {
      valid: true,
      changedFiles: Object.freeze(
        [...new Set([...tracked, ...untracked])].sort(),
      ),
    };
  } catch (error) {
    if (signal?.aborted === true ||
      error instanceof ToolError && error.code === "cancelled") {
      throw new DOMException("Company benchmark verification was cancelled", "AbortError");
    }
    return { valid: false, changedFiles: [] };
  }
}

export async function verifyCompanyBenchmarkWorkspace(input: {
  readonly scenario: CompanyBenchmarkScenario;
  readonly workspaceRoot: string;
  readonly baseRevision: string;
  readonly signal?: AbortSignal;
  readonly processRunner?: ProcessRunner;
}): Promise<CompanyBenchmarkWorkspaceVerification> {
  input.signal?.throwIfAborted();
  const root = await requireCanonicalDirectory(input.workspaceRoot);
  const checks: CompanyBenchmarkCheck[] = [];
  checks.push({
    id: "workspace_inventory",
    status: await inventoryIsSafe(input.scenario, root, input.signal)
      ? "passed"
      : "failed",
  });
  const runner = input.processRunner ?? runProcess;
  const git = await inspectGitState(
    runner,
    root,
    input.baseRevision,
    input.signal,
  );
  checks.push({
    id: "git_state",
    status: git.valid ? "passed" : "failed",
  });
  const changedFiles = [...git.changedFiles];
  const allowed = changedFiles.length > 0 &&
    new Set(changedFiles).size === changedFiles.length &&
    changedFiles.every((file) =>
      safeRelativePath(file) &&
      input.scenario.allowedChangedPaths.includes(file)
    );
  checks.push({
    id: "allowed_changes",
    status: allowed ? "passed" : "failed",
  });
  checks.push({
    id: "visible_tests",
    status: await processCheck(runner, root, ["--test"], input.signal),
  });
  checks.push(...await runHiddenVerifier(
    input.scenario,
    runner,
    root,
    input.signal,
  ));
  return Object.freeze({
    status: checks.every((check) => check.status === "passed")
      ? "passed"
      : "failed",
    checks: Object.freeze(checks.map((check) => Object.freeze(check))),
  });
}
