import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { PRODUCT_TASK_SPECS, type ProductTaskSpec } from "../src/company-benchmark-product-tasks.js";
import { PRODUCT_TASK_REFERENCES } from "./company-benchmark-product-reference.js";

const execute = promisify(execFile);
type Patches = Readonly<Record<string, string>>;
type Result = { id: string; status: "passed" | "failed" };

function spec(id: string): ProductTaskSpec {
  const value = PRODUCT_TASK_SPECS.find(task => task.id === id);
  if (!value) throw new Error(`Missing spec ${id}`);
  return value;
}

function reference(id: string): Patches {
  const value = PRODUCT_TASK_REFERENCES[id];
  if (!value) throw new Error(`Missing reference ${id}`);
  return value;
}

function fixture(task: ProductTaskSpec): Record<string, string> {
  return {
    "package.json": JSON.stringify({ private: true, type: "module", scripts: { test: "node --test test/*.test.js" } }),
    "README.md": task.readme,
    ...task.sources,
    "test/visible.test.js": task.visibleTests,
  };
}

/** Executes only these repository-authored offline controls. Live candidates must
 * use the production verifier's inventory checks, sandbox, timeout and signature.
 * Hidden source is passed to the child, never written into the fixture directory.
 */
async function evaluate(task: ProductTaskSpec, patches: Patches = {}, visible = false) {
  const root = await mkdtemp(path.join(tmpdir(), "recurs-product-task-"));
  try {
    for (const filePath of Object.keys(patches)) expect(task.allowedChangedPaths).toContain(filePath);
    for (const [filePath, content] of Object.entries({ ...fixture(task), ...patches })) {
      const destination = path.join(root, filePath);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
    const program = `
      import assert from 'node:assert/strict';
      import {pathToFileURL} from 'node:url';
      import path from 'node:path';
      const equal = assert.equal.bind(assert), deepEqual = assert.deepEqual.bind(assert), throws = assert.throws.bind(assert);
      const load = relative => import(pathToFileURL(path.join(process.cwd(),relative)).href);
      const results = [];
      for (const [id,check] of [${task.hiddenChecks}]) {
        try { await check(); results.push({id,status:'passed'}); }
        catch { results.push({id,status:'failed'}); }
      }
      process.stdout.write(JSON.stringify(results));
    `;
    const { stdout } = await execute(process.execPath, ["--input-type=module", "--eval", program], {
      cwd: root, timeout: 3000, maxBuffer: 128 * 1024,
    });
    const checks = JSON.parse(stdout) as Result[];
    expect(checks.map(check => check.id)).toEqual(task.checkIds);
    if (visible) await execute(process.execPath, ["--test", "test/visible.test.js"], {
      cwd: root, timeout: 3000, maxBuffer: 128 * 1024,
    });
    return checks;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function failed(checks: Result[]): string[] {
  return checks.filter(check => check.status === "failed").map(check => check.id);
}

describe("fresh product task fixtures and hidden checks", () => {
  it("keeps complete acceptance text and all hidden/reference code outside bounded fixtures", () => {
    expect(PRODUCT_TASK_SPECS.map(task => task.id)).toEqual([
      "shipment_quote", "incremental_build_repair", "release_window_regressions",
    ]);
    const allCheckIds = PRODUCT_TASK_SPECS.flatMap(task => task.checkIds);
    expect(new Set(allCheckIds).size).toBe(allCheckIds.length);
    for (const task of PRODUCT_TASK_SPECS) {
      const files = fixture(task);
      expect(Object.keys(files).length).toBeLessThanOrEqual(32);
      for (const content of Object.values(files)) {
        expect(Buffer.byteLength(content)).toBeLessThanOrEqual(64 * 1024);
        for (const id of task.checkIds) expect(content).not.toContain(id);
        expect(content).not.toContain("PRODUCT_TASK_REFERENCES");
      }
      expect(task.readme).toContain("npm test");
      expect(task.limitations.length).toBeGreaterThan(80);
      expect(new Set(task.allowedChangedPaths).size).toBe(task.allowedChangedPaths.length);
      expect(Object.keys(reference(task.id)).sort()).toEqual([...task.allowedChangedPaths].sort());
      for (const filePath of task.allowedChangedPaths) expect(files).toHaveProperty(filePath);
    }
  });

  for (const task of PRODUCT_TASK_SPECS) {
    it(`${task.id}: unfinished fixture fails overall grading`, async () => {
      expect(failed(await evaluate(task)).length).toBeGreaterThan(0);
    });
    it(`${task.id}: useful reference passes visible tests and every hidden check`, async () => {
      expect(failed(await evaluate(task, reference(task.id), true))).toEqual([]);
    });
  }

  const shipmentMutations = [
    ["merged inventory bypass", "src/cart.js", "if (quantity > product.stock)", "if (item.quantity > product.stock)", "hidden_shipment_validation"],
    ["inherited SKU acceptance", "src/cart.js", "!Object.hasOwn(catalog,item.sku)", "!(item.sku in catalog)", "hidden_shipment_validation"],
    ["rounded instead of floored discount", "src/pricing.js", "Math.floor", "Math.round", "hidden_shipment_rates"],
    ["per-line discount rounding", "src/pricing.js", "Math.floor(subtotalCents * discountBps / 10000)", "lines.reduce((sum,line) => sum + Math.floor(line.quantity * line.unitCents * discountBps / 10000),0)", "hidden_shipment_rates"],
    ["truncated parcel units", "src/delivery.js", "Math.ceil", "Math.floor", "hidden_shipment_rates"],
    ["free remote delivery", "src/delivery.js", "zone === 'local' && merchandiseCents >= 5000", "merchandiseCents >= 5000", "hidden_shipment_rates"],
    ["weight omits quantity", "src/quote.js", "line.quantity * line.grams", "line.grams", "hidden_shipment_integration"],
    ["free delivery uses pre-discount total", "src/quote.js", "deliveryCost(grams,price.merchandiseCents,zone)", "deliveryCost(grams,price.subtotalCents,zone)", "hidden_shipment_integration"],
  ] as const;
  for (const [name, filePath, before, after, expectedFailure] of shipmentMutations) {
    it(`rejects plausible shipment mistake: ${name}`, async () => {
      const good = reference("shipment_quote");
      expect(good[filePath]).toContain(before);
      const bad = { ...good, [filePath]: good[filePath]!.replace(before, after) };
      expect(failed(await evaluate(spec("shipment_quote"), bad))).toContain(expectedFailure);
    });
  }

  const buildMutations = [
    ["missed removals", "src/changes.js", "[...oldKeys].filter(name => !newKeys.has(name)).sort()", "[]", "hidden_build_snapshots"],
    ["truthy hash comparison", "src/changes.js", "previous[name] !== current[name]", "!previous[name]", "hidden_build_snapshots"],
    ["omitted removal seeds", "src/plan.js", "[...delta.changed,...delta.removed]", "delta.changed", "hidden_build_integration"],
    ["deleted modules remain buildable", "src/plan.js", ".filter(name => present.has(name))", "", "hidden_build_integration"],
  ] as const;
  for (const [name, filePath, before, after, expectedFailure] of buildMutations) {
    it(`rejects plausible build mistake: ${name}`, async () => {
      const good = reference("incremental_build_repair");
      expect(good[filePath]).toContain(before);
      const bad = { ...good, [filePath]: good[filePath]!.replace(before, after) };
      expect(failed(await evaluate(spec("incremental_build_repair"), bad))).toContain(expectedFailure);
    });
  }

  it("rejects a direct-import-only traversal even when comparison and composition are repaired", async () => {
    const task = spec("incremental_build_repair");
    const bad = { ...reference(task.id), "src/dependents.js": task.sources["src/dependents.js"]! };
    expect(failed(await evaluate(task, bad))).toEqual(expect.arrayContaining(["hidden_build_transitive", "hidden_build_cycles", "hidden_build_integration"]));
  });

  for (const [name, code] of [
    ["always throwing", "throw new Error('all implementations fail');"],
    ["labels only", "return ['boundary','paused','priority'];"],
    ["source inspection heuristic", "if (api.selectRelease.toString().includes('mode ===')) throw new Error('mutation');"],
  ]) {
    it(`does not award a completed checker for ${name}`, async () => {
      const checks = await evaluate(spec("release_window_regressions"), {
        "checks/release-contract.js": `export async function checkReleaseWindow(api) { ${code} }`,
      });
      expect(failed(checks)).toEqual(expect.arrayContaining(["hidden_release_boundaries", "hidden_release_paused", "hidden_release_priority"]));
      if (name === "always throwing") expect(failed(checks)).toHaveLength(4);
    });
  }

  const incompleteChecker = `import assert from 'node:assert/strict';
export async function checkReleaseWindow(api) {
  const a = {id:'a',startMs:10,endMs:20,paused:false,priority:1};
  assert.equal(api.selectRelease([],15),null);
  assert.equal(api.selectRelease([a],15).id,'a');
  CHECK
}
`;
  for (const [assertion, caught, missed] of [
    ["assert.equal(api.selectRelease([a],20),null);", "hidden_release_boundaries", "hidden_release_paused"],
    ["assert.equal(api.selectRelease([{...a,paused:true}],15),null);", "hidden_release_paused", "hidden_release_priority"],
    ["assert.equal(api.selectRelease([a,{...a,id:'b',priority:2}],15).id,'b');", "hidden_release_priority", "hidden_release_boundaries"],
  ]) {
    it(`distinguishes a useful but incomplete checker detecting ${caught}`, async () => {
      const checks = await evaluate(spec("release_window_regressions"), {
        "checks/release-contract.js": incompleteChecker.replace("CHECK", assertion!),
      }, true);
      expect(failed(checks)).not.toContain("hidden_release_reference");
      expect(failed(checks)).not.toContain(caught);
      expect(failed(checks)).toContain(missed);
    });
  }
});
