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
  it("publishes one versioned fixture with a stable digest", () => {
    expect(COMPANY_BENCHMARK_SCENARIOS).toHaveLength(1);
    const scenario = getCompanyBenchmarkScenario("alias_registry", 1);

    expect(scenario).toMatchObject({
      id: "alias_registry",
      version: 1,
      taskClass: "general_coding",
      difficulty: "medium",
      verifierId: "alias_registry_hidden_v1",
    });
    expect(scenario.fixtureSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(getCompanyBenchmarkScenario("alias_registry", 1)).toBe(scenario);
    expect(() => getCompanyBenchmarkScenario("missing", 1)).toThrow(
      "Unknown company benchmark scenario",
    );
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
    }[] = [];
    const runner: typeof runProcess = (command, args, options) => {
      observed.push({
        args,
        access: options.sandbox?.workspaceAccess,
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
const NAME = /^[a-z][a-z0-9_-]{0,31}$/u;

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
