import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { runProcess } from "@recurs/tools";

import {
  COMPANY_BENCHMARK_SCENARIOS,
  getCompanyBenchmarkScenario,
  initializeCompanyBenchmarkWorkspace,
  materializeCompanyBenchmarkScenario,
  verifyCompanyBenchmarkWorkspace,
} from "../src/company-benchmark-scenario.js";

const roots: string[] = [];
let sandboxAvailable: boolean | undefined;

async function runWithAvailableSandbox(
  command: string,
  args: readonly string[],
  options: Parameters<typeof runProcess>[2],
) {
  if (sandboxAvailable === undefined) {
    try {
      await runProcess("/usr/bin/true", [], {
        cwd: options.cwd,
        sandbox: { mode: "workspace", network: "deny" },
      });
      sandboxAvailable = true;
    } catch {
      // Nested macOS/Linux test sandboxes can reject a second sandbox layer.
      sandboxAvailable = false;
    }
  }
  return runProcess(command, args, {
    ...options,
    ...(sandboxAvailable ? {} : { sandbox: undefined }),
  });
}

const containedTestRunner: typeof runProcess = (command, args, options) => {
  expect(options.sandbox).toMatchObject({
    mode: "workspace",
    network: "deny",
  });
  return runWithAvailableSandbox(command, args, options);
};

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "recurs-benchmark-scenario-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("built-in company benchmark scenarios", () => {
  it("publishes three versioned fixtures with stable digests", () => {
    expect(COMPANY_BENCHMARK_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "alias_registry",
      "layered_config",
      "retry_after",
    ]);
    const scenario = getCompanyBenchmarkScenario("alias_registry", 1);

    expect(scenario).toMatchObject({
      id: "alias_registry",
      version: 1,
      taskClass: "general_coding",
      difficulty: "medium",
      verifierId: "alias_registry_hidden_v2",
    });
    expect(COMPANY_BENCHMARK_SCENARIOS.map((candidate) => [
      candidate.id,
      candidate.fixtureSha256,
    ])).toEqual([
      [
        "alias_registry",
        "442e5e5a476297693640606191b58eca98772d3eb85e6f9b7a0c7e1d6b5c4e2d",
      ],
      [
        "layered_config",
        "9afc323c32671ee372d1fdbd046ae37772d81433dcac32966a2da12ac48edbb4",
      ],
      [
        "retry_after",
        "ba99fc64c07892d54e15115bf04eb31ec5091755961d1d059ed794265ed5a22e",
      ],
    ]);
    for (const candidate of COMPANY_BENCHMARK_SCENARIOS) {
      expect(candidate.hiddenCheckIds).toHaveLength(3);
      expect(getCompanyBenchmarkScenario(candidate.id, 1)).toBe(candidate);
    }
    expect(getCompanyBenchmarkScenario("alias_registry", 1)).toBe(scenario);
    expect(() => getCompanyBenchmarkScenario("missing", 1)).toThrow(
      "Unknown company benchmark scenario",
    );
  });

  it("passes the cross-file and review-sensitive hidden verifiers with reference implementations", async () => {
    for (const [scenarioId, install] of [
      ["layered_config", installLayeredConfigReferenceImplementation],
      ["retry_after", installRetryAfterReferenceImplementation],
    ] as const) {
      const root = await workspace();
      const scenario = getCompanyBenchmarkScenario(scenarioId, 1);
      const prepared = await initializeCompanyBenchmarkWorkspace({
        scenario,
        workspaceRoot: root,
        processRunner: containedTestRunner,
      });
      await install(root);

      const result = await verifyCompanyBenchmarkWorkspace({
        scenario,
        workspaceRoot: root,
        baseRevision: prepared.baseRevision,
        processRunner: containedTestRunner,
      });

      expect(result.status, `${scenarioId}: ${JSON.stringify(result)}`)
        .toBe("passed");
      expect(result.checks.slice(-3).map((check) => check.id))
        .toEqual(scenario.hiddenCheckIds);
    }
  });

  it("rejects expected-shaped hidden results without run provenance", async () => {
    const root = await workspace();
    const scenario = getCompanyBenchmarkScenario("layered_config", 1);
    const prepared = await initializeCompanyBenchmarkWorkspace({
      scenario,
      workspaceRoot: root,
      processRunner: containedTestRunner,
    });
    await installLayeredConfigReferenceImplementation(root);
    const runner: typeof runProcess = async (command, args, options) => {
      if (args.some((argument) => argument.endsWith("verifier.mjs"))) {
        return {
          stdout: JSON.stringify({
            version: 1,
            checks: scenario.hiddenCheckIds.map((id) => ({
              id,
              status: "passed",
            })),
          }),
          stderr: "",
          exitCode: 0,
        };
      }
      return await containedTestRunner(command, args, options);
    };

    const result = await verifyCompanyBenchmarkWorkspace({
      scenario,
      workspaceRoot: root,
      baseRevision: prepared.baseRevision,
      processRunner: runner,
    });

    expect(result.checks.slice(-3)).toEqual(
      scenario.hiddenCheckIds.map((id) => ({ id, status: "failed" })),
    );
  });

  it("rejects altered and replayed authenticated hidden results", async () => {
    const root = await workspace();
    const scenario = getCompanyBenchmarkScenario("retry_after", 1);
    const prepared = await initializeCompanyBenchmarkWorkspace({
      scenario,
      workspaceRoot: root,
      processRunner: containedTestRunner,
    });
    await installRetryAfterReferenceImplementation(root);
    let authenticOutput: string | null = null;
    const capture: typeof runProcess = async (command, args, options) => {
      const result = await containedTestRunner(command, args, options);
      if (args.some((argument) => argument.endsWith("verifier.mjs"))) {
        authenticOutput = result.stdout;
      }
      return result;
    };
    const first = await verifyCompanyBenchmarkWorkspace({
      scenario,
      workspaceRoot: root,
      baseRevision: prepared.baseRevision,
      processRunner: capture,
    });
    expect(first.status).toBe("passed");
    expect(authenticOutput).not.toBeNull();

    const altered: typeof runProcess = async (command, args, options) => {
      if (!args.some((argument) => argument.endsWith("verifier.mjs"))) {
        return await containedTestRunner(command, args, options);
      }
      const current = await containedTestRunner(command, args, options);
      const parsed = JSON.parse(current.stdout) as {
        version: number;
        checks: { id: string; status: "passed" | "failed" }[];
        authenticator: string;
      };
      parsed.checks[0] = { ...parsed.checks[0]!, status: "failed" };
      return { ...current, stdout: JSON.stringify(parsed) };
    };
    const alteredResult = await verifyCompanyBenchmarkWorkspace({
      scenario,
      workspaceRoot: root,
      baseRevision: prepared.baseRevision,
      processRunner: altered,
    });
    expect(alteredResult.checks.slice(-3).every((check) =>
      check.status === "failed"
    )).toBe(true);

    const replay: typeof runProcess = async (command, args, options) => {
      if (args.some((argument) => argument.endsWith("verifier.mjs"))) {
        return { stdout: authenticOutput!, stderr: "", exitCode: 0 };
      }
      return await containedTestRunner(command, args, options);
    };
    const replayed = await verifyCompanyBenchmarkWorkspace({
      scenario,
      workspaceRoot: root,
      baseRevision: prepared.baseRevision,
      processRunner: replay,
    });
    expect(replayed.checks.slice(-3).every((check) =>
      check.status === "failed"
    )).toBe(true);
  });

  it("materializes byte-identical files without overwriting existing state", async () => {
    const root = await workspace();
    const scenario = getCompanyBenchmarkScenario("alias_registry", 1);

    await materializeCompanyBenchmarkScenario(scenario, root);

    for (const file of scenario.files) {
      expect(await readFile(path.join(root, file.path), "utf8")).toBe(file.content);
      expect((await lstat(path.join(root, file.path))).mode & 0o777).toBe(file.mode);
    }
    await expect(materializeCompanyBenchmarkScenario(scenario, root))
      .rejects.toThrow("must be empty");
  });

  it("accepts a correct implementation using only approved source paths", async () => {
    const root = await workspace();
    const scenario = getCompanyBenchmarkScenario("alias_registry", 1);
    const prepared = await initializeCompanyBenchmarkWorkspace({
      scenario,
      workspaceRoot: root,
      processRunner: containedTestRunner,
    });
    await installReferenceImplementation(root);

    const result = await verifyCompanyBenchmarkWorkspace({
      scenario,
      workspaceRoot: root,
      baseRevision: prepared.baseRevision,
      processRunner: containedTestRunner,
    });

    expect(result.status, JSON.stringify(result)).toBe("passed");
    expect(result.checks).toEqual([
      { id: "workspace_inventory", status: "passed" },
      { id: "git_state", status: "passed" },
      { id: "allowed_changes", status: "passed" },
      { id: "visible_tests", status: "passed" },
      { id: "hidden_alias_normalization", status: "passed" },
      { id: "hidden_registry_boundaries", status: "passed" },
      { id: "hidden_traversal_rejection", status: "passed" },
    ]);
  });

  it("fails closed on unsafe inventory, unapproved changes, and hidden edge cases", async () => {
    const root = await workspace();
    const scenario = getCompanyBenchmarkScenario("alias_registry", 1);
    const prepared = await initializeCompanyBenchmarkWorkspace({
      scenario,
      workspaceRoot: root,
      processRunner: containedTestRunner,
    });
    await writeFile(
      path.join(root, "src/alias-path.js"),
      "export const normalizeAliasPath = value => value;\n",
      "utf8",
    );
    await chmod(path.join(root, "src/alias-path.js"), 0o644);
    await symlink("/tmp", path.join(root, "src/unsafe-link"));

    const result = await verifyCompanyBenchmarkWorkspace({
      scenario,
      workspaceRoot: root,
      baseRevision: prepared.baseRevision,
      processRunner: containedTestRunner,
    });

    expect(result.status).toBe("failed");
    expect(result.checks).toContainEqual({
      id: "workspace_inventory",
      status: "failed",
    });
    expect(result.checks).toContainEqual({
      id: "allowed_changes",
      status: "failed",
    });
    expect(result.checks.some((check) =>
      check.id.startsWith("hidden_") && check.status === "failed"
    )).toBe(true);
    expect(JSON.stringify(result)).not.toContain("/tmp");
  });

  it("keeps hidden cases outside argv and verifies in a read-only workspace", async () => {
    const root = await workspace();
    const scenario = getCompanyBenchmarkScenario("alias_registry", 1);
    const observed: {
      readonly args: readonly string[];
      readonly access: string | undefined;
      readonly stdinLength: number;
    }[] = [];
    const runner: typeof runProcess = (command, args, options) => {
      observed.push({
        args,
        access: options.sandbox?.workspaceAccess,
        stdinLength: options.stdin?.length ?? 0,
      });
      return runWithAvailableSandbox(command, args, options);
    };
    const prepared = await initializeCompanyBenchmarkWorkspace({
      scenario,
      workspaceRoot: root,
      processRunner: runner,
    });
    await installReferenceImplementation(root);

    const result = await verifyCompanyBenchmarkWorkspace({
      scenario,
      workspaceRoot: root,
      baseRevision: prepared.baseRevision,
      processRunner: runner,
    });

    expect(result.status).toBe("passed");
    expect(observed.some((call) => call.access === "read_only")).toBe(true);
    expect(observed.flatMap((call) => call.args)).not.toContain("--eval");
    expect(observed.some((call) =>
      call.args.includes("--no-replace-objects")
    )).toBe(true);
    expect(JSON.stringify(observed)).not.toContain("alias traversal");
    const verifier = observed.find((call) =>
      call.args.some((arg) => arg.endsWith("verifier.mjs"))
    );
    expect(verifier?.args.some((arg) => arg.startsWith(root))).toBe(false);
    expect(verifier?.stdinLength).toBe(64);
  });

  it.each([
    ["replacement refs", ".git/refs/replace", "directory"],
    ["grafts", ".git/info/grafts", "file"],
    ["object alternates", ".git/objects/info/alternates", "file"],
  ] as const)(
    "rejects Git %s before trusting repository state",
    async (_label, relative, kind) => {
      const root = await workspace();
      const scenario = getCompanyBenchmarkScenario("alias_registry", 1);
      const prepared = await initializeCompanyBenchmarkWorkspace({
        scenario,
        workspaceRoot: root,
        processRunner: containedTestRunner,
      });
      await installReferenceImplementation(root);
      const controlPath = path.join(root, relative);
      if (kind === "directory") {
        await mkdir(controlPath, { recursive: true });
      } else {
        await mkdir(path.dirname(controlPath), { recursive: true });
        await writeFile(controlPath, "untrusted-control-metadata\n", "utf8");
      }

      const result = await verifyCompanyBenchmarkWorkspace({
        scenario,
        workspaceRoot: root,
        baseRevision: prepared.baseRevision,
        processRunner: containedTestRunner,
      });

      expect(result.checks).toContainEqual({
        id: "git_state",
        status: "failed",
      });
    },
  );

  it("bounds inventory traversal and honors cancellation before inspection", async () => {
    const root = await workspace();
    const scenario = getCompanyBenchmarkScenario("alias_registry", 1);
    const prepared = await initializeCompanyBenchmarkWorkspace({
      scenario,
      workspaceRoot: root,
      processRunner: containedTestRunner,
    });
    await installReferenceImplementation(root);
    await Promise.all(Array.from({ length: 300 }, (_, index) =>
      writeFile(path.join(root, `unexpected-${index}.txt`), "", "utf8")
    ));

    const result = await verifyCompanyBenchmarkWorkspace({
      scenario,
      workspaceRoot: root,
      baseRevision: prepared.baseRevision,
      processRunner: containedTestRunner,
    });
    expect(result.checks[0]).toEqual({
      id: "workspace_inventory",
      status: "failed",
    });

    const controller = new AbortController();
    controller.abort();
    await expect(verifyCompanyBenchmarkWorkspace({
      scenario,
      workspaceRoot: root,
      baseRevision: prepared.baseRevision,
      processRunner: containedTestRunner,
      signal: controller.signal,
    })).rejects.toThrow("aborted");
  });
});

async function installReferenceImplementation(root: string): Promise<void> {
  await writeFile(path.join(root, "src/alias-path.js"), `
const NAME = /^[a-z][a-z0-9_]{0,31}$/u;

export function normalizeAliasPath(value) {
  if (typeof value !== "string" || value.includes("\\\\") ||
      value.includes("\\0") || !value.startsWith("@")) {
    throw new TypeError("invalid alias path");
  }
  const [rawName = "", ...rawParts] = value.slice(1).split("/");
  if (!NAME.test(rawName)) throw new TypeError("invalid alias name");
  const parts = [];
  for (const part of rawParts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new TypeError("alias traversal");
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return \`@\${rawName}\${parts.length === 0 ? "" : \`/\${parts.join("/")}\`}\`;
}

`.trimStart(), { mode: 0o644 });
  await writeFile(path.join(root, "src/alias-registry.js"), `
import { normalizeAliasPath } from "./alias-path.js";

function targetPath(value) {
  if (typeof value !== "string" || value.startsWith("/") ||
      value.includes("\\\\") || value.includes("\\0")) {
    throw new TypeError("invalid target");
  }
  const parts = [];
  for (const part of value.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new TypeError("target traversal");
    parts.push(part);
  }
  if (parts.length === 0) throw new TypeError("empty target");
  return parts.join("/");
}

export function createAliasRegistry(entries) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  const routes = entries.map(({ alias, target }) => ({
    alias: normalizeAliasPath(alias),
    target: targetPath(target),
  }));
  if (new Set(routes.map(({ alias }) => alias)).size !== routes.length) {
    throw new TypeError("duplicate alias");
  }
  routes.sort((left, right) => right.alias.length - left.alias.length);
  return Object.freeze({
    resolve(value) {
      const input = normalizeAliasPath(value);
      const route = routes.find(({ alias }) =>
        input === alias || input.startsWith(\`\${alias}/\`)
      );
      if (route === undefined) return null;
      const remainder = input.slice(route.alias.length).replace(/^\\//u, "");
      return remainder.length === 0 ? route.target : \`\${route.target}/\${remainder}\`;
    },
  });
}
`.trimStart(), { mode: 0o644 });
}

async function installLayeredConfigReferenceImplementation(
  root: string,
): Promise<void> {
  await writeFile(path.join(root, "src/config-key.js"), `
const SEGMENT = /^[a-z][a-z0-9_-]{0,31}$/u;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

export function normalizeConfigKey(value) {
  if (typeof value !== "string") throw new TypeError("invalid config key");
  const segments = value.split(".");
  if (segments.length === 0 || segments.some((segment) =>
    !SEGMENT.test(segment) || FORBIDDEN.has(segment)
  )) {
    throw new TypeError("invalid config key");
  }
  return segments.join(".");
}
`.trimStart(), { mode: 0o644 });
  await writeFile(path.join(root, "src/layered-config.js"), `
import { normalizeConfigKey } from "./config-key.js";

function validValue(value) {
  return typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number" && Number.isFinite(value);
}

export function createLayeredConfig(layers) {
  if (!Array.isArray(layers)) throw new TypeError("invalid layers");
  const values = new Map();
  for (const layer of layers) {
    if (!Array.isArray(layer)) throw new TypeError("invalid layer");
    const seen = new Set();
    for (const entry of layer) {
      if (typeof entry !== "object" || entry === null ||
          Array.isArray(entry) ||
          Object.keys(entry).sort().join(",") !== "key,value") {
        throw new TypeError("invalid entry");
      }
      const key = normalizeConfigKey(entry.key);
      if (seen.has(key)) throw new TypeError("duplicate key");
      seen.add(key);
      if (entry.value === null) values.delete(key);
      else if (validValue(entry.value)) values.set(key, entry.value);
      else throw new TypeError("invalid value");
    }
  }
  return Object.freeze({
    get(key) {
      const normalized = normalizeConfigKey(key);
      return values.has(normalized) ? values.get(normalized) : null;
    },
    keys() {
      return [...values.keys()].sort();
    },
  });
}
`.trimStart(), { mode: 0o644 });
}

async function installRetryAfterReferenceImplementation(
  root: string,
): Promise<void> {
  await writeFile(path.join(root, "src/retry-after.js"), `
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12][0-9]|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} (?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9] GMT$/u;

export function parseRetryAfter(value, nowMs, maximumDelayMs) {
  if (typeof value !== "string" ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      !Number.isSafeInteger(maximumDelayMs) || maximumDelayMs < 0) {
    return null;
  }
  if (/^[0-9]+$/u.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds) ||
        seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) {
      return null;
    }
    return Math.min(seconds * 1000, maximumDelayMs);
  }
  if (!IMF_FIXDATE.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) ||
      new Date(parsed).toUTCString() !== value) return null;
  const delay = parsed - nowMs;
  if (delay <= 0) return 0;
  if (!Number.isSafeInteger(delay)) return null;
  return Math.min(delay, maximumDelayMs);
}
`.trimStart(), { mode: 0o644 });
}
