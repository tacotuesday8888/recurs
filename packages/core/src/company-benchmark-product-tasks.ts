import type { TaskFitSpec } from "./company-benchmark-task-fit.js";

/** Fresh authored exercises, not production workloads or evidence of a team advantage.
 * Hidden checks stay in the verifier process, never in the candidate workspace.
 * Reference solutions belong exclusively in offline test files.
 */
export interface ProductTaskSpec extends TaskFitSpec {
  readonly readme: string;
  readonly allowedChangedPaths: readonly string[];
  readonly limitations: string;
}

const testHeader = `import assert from 'node:assert/strict';
import test from 'node:test';
`;

const shipmentReadme = `# Parcel shop: implement shipment quotes

The storefront has a quote API skeleton. Implement its cart, pricing and delivery
modules, then finish their integration in src/quote.js. Use synchronous exports,
Node built-ins only, and do not mutate any input. Change only src/cart.js,
src/pricing.js, src/delivery.js and src/quote.js. Public tests are immutable.
Run npm test. No network, persistence, clock, or external service is required.

Acceptance requirements:
- normalizeCart(items, catalog) takes an array of at most 100 {sku, quantity}
  records. sku is a nonempty string and must be an OWN key of catalog; quantity
  is an integer from 1 to 1000. Catalog entries used by the cart have integer
  unitCents in [0,1000000], grams in [1,100000], and stock in [0,1000000].
  Throw TypeError for invalid input, missing SKUs, or invalid used entries.
  Empty arrays are valid. Catalog is a non-null non-array object; unused entries
  are ignored. Merge duplicate SKUs in first-appearance order. If the merged
  quantity exceeds stock, throw RangeError. Return new records containing
  exactly {sku, quantity, unitCents, grams}; no catalog references escape.
- priceCart(lines, discountBps = 0) accepts normalized lines. discountBps must be
  an integer in [0,10000], otherwise TypeError. Compute subtotalCents as the sum
  of quantity * unitCents. Apply ONE discount to the whole subtotal, rounding
  DOWN: discountCents = floor(subtotalCents * discountBps / 10000). Return exactly
  {subtotalCents, discountCents, merchandiseCents}. Free items are allowed.
- deliveryCost(totalGrams, merchandiseCents, zone) takes integer totalGrams in
  [0,10000000000], integer merchandiseCents in [0,100000000000], and zone equal
  to local or remote. Invalid arguments throw TypeError, including unknown
  zones on empty orders. Zero grams costs zero. Otherwise charge per STARTED
  kilogram: local = 500 + 200 * ceil(totalGrams/1000); remote = 900 + 350 *
  ceil(totalGrams/1000). Local delivery is free when merchandiseCents >= 5000
  AFTER the discount. Remote delivery is never free for nonempty orders.
- quote(items, catalog, {zone = 'local', discountBps = 0} = {}) composes those
  modules. Return exactly {lines, subtotalCents, discountCents, merchandiseCents,
  deliveryCents, totalCents}, where totalCents includes delivery and shipment
  weight includes every unit. Propagate validation failures, including invalid
  zone/discount on an empty cart. Preserve the exported function names.

Scope: a small deterministic pricing exercise, not checkout, payments, taxes,
inventory reservation, or a full commerce application. Modules have distinct
responsibilities, but the quote integration depends on their shared contracts.
`;

const buildReadme = `# Build watcher: repair incremental rebuild planning

Three existing modules miss changes in a build watcher's dependency graph.
Repair src/changes.js, src/dependents.js and src/plan.js. All exports are
synchronous, dependency-free, and must not mutate inputs. Change only those
three files; public tests are immutable. Run npm test.

Acceptance requirements:
- diffSnapshots(previous, current): each snapshot is an object mapping module
  names to opaque string content hashes. Use only own enumerable keys (including
  names like __proto__ and constructor); inherited properties are ignored.
  Return exactly {changed, removed}. changed contains added names or names whose
  hash changed, removed contains names absent from current. Both arrays are
  unique and sorted by JavaScript's default string sort, with no locale folding.
  Empty-string hashes are valid and must be compared by equality, not truthiness.
- affectedModules(graph, changed): graph maps every known module name to an
  array of names it directly imports. Return changed known modules AND every
  transitive importer, once each, sorted using default string sort. Ignore
  changed names that are not OWN enumerable keys of graph. Handle empty graphs,
  cycles, self imports, duplicate edges, and diamonds without hanging. The graph
  is an inventory spanning the before/after change: deleted modules can still
  appear as keys so their surviving importers can be invalidated. All dependency
  names are graph keys. No additional validation of these valid inputs is needed.
- planBuild(graph, previous, current) returns exactly {changed, removed, build}.
  changed and removed are diffSnapshots results. build is affectedModules seeded
  by BOTH lists, filtered to modules that are OWN enumerable keys of current.
  A changed module outside graph still appears in changed, but not build.
  Deleted modules are never built. Do not compare hashes as numeric values and
  do not infer a rename. Preserve function names and module responsibilities:
  snapshot comparison in changes.js, traversal in dependents.js, composition
  in plan.js. Consumers rely on deterministic output and untouched inputs.

Scope: rebuild selection only, not compilation, filesystem watching, topological
scheduling, or cache correctness across real toolchains. Transitive invalidation
is conservative; no timing or parallel execution advantage is built into grading.
`;

const releaseReadme = `# Release windows: write a reusable regression checker

Implement async checkReleaseWindow(api) in checks/release-contract.js. It should
exercise api.selectRelease(windows, nowMs), returning normally when the API obeys
the contract and throwing an Error (for example node:assert/strict assertions)
when observed behavior violates it. Do not repair the scheduler. Change only
checks/release-contract.js. Run npm test; tests and src/release.js are immutable.

Public API contract:
- windows is an array of records with unique nonempty string ids, finite safe
  integer startMs/endMs (startMs < endMs), boolean paused, and integer priority.
  nowMs is a finite safe integer. Only these valid inputs need testing.
- A window is eligible when startMs <= nowMs < endMs and paused is false.
- Select the eligible window with highest priority; if priorities tie, choose
  the id first in JavaScript string comparison order. Return null if none qualify.
- Otherwise return a fresh record with exactly {id, startMs, endMs, priority}.
  Do not mutate the windows array, its order, or any input record.
- Time is explicit; do not use system time or random inputs.

Checker contract:
- Test only the supplied api through documented behavior, with your own valid
  inputs. Do not import the fixture implementation as an oracle, inspect source,
  function names/descriptors, process/environment/filesystem, or grader metadata,
  and do not change globals or supplied functions. Use only Node assertion
  built-ins; no dependencies, network, subprocesses or additional files.
- The checker may be called repeatedly against different conforming or faulty
  APIs. Keep calls independent: do not rely on call order, persistent counters,
  implementation identity, or hidden case labels. All inputs are yours to create.
- Passing visible tests only proves acceptance of the working fixture. Evaluation
  separately checks acceptance of conforming APIs and rejection of behaviorally
  faulty APIs; a no-op checker, always-throwing checker or reported bug labels
  earn no completed-task credit. Every rejection must be an Error caused by an
  observed contract violation. Candidate checkers are also reviewed for these
  restrictions before results are used.

Scope: authored contract regression-check effectiveness, not general bug discovery
or a production test-suite benchmark. A finite hidden mutation set cannot prove
all contract properties. No team-only prompt or division of labor is prescribed.
`;

const releaseSource = `export function selectRelease(windows, nowMs) {
  let selected = null;
  for (const window of windows) {
    if (window.paused || nowMs < window.startMs || nowMs >= window.endMs) continue;
    if (!selected || window.priority > selected.priority || (window.priority === selected.priority && window.id < selected.id)) selected = window;
  }
  return selected ? {id:selected.id,startMs:selected.startMs,endMs:selected.endMs,priority:selected.priority} : null;
}
`;

// Every supplied function has the same name, source, descriptors and public shape.
// Behavioral mutations are closed over, not published as source in the fixture.
const releaseApiFactory = `
      function makeApi(mode) {
        const implementation = (windows, nowMs) => {
          const eligible = windows.filter(w => (mode === 2 || !w.paused) && w.startMs <= nowMs && (mode === 1 ? nowMs <= w.endMs : nowMs < w.endMs));
          eligible.sort((a,b) => (mode === 3 ? a.priority-b.priority : b.priority-a.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
          const w = eligible[0];
          return w ? {id:w.id,startMs:w.startMs,endMs:w.endMs,priority:w.priority} : null;
        };
        return Object.freeze({selectRelease:function selectRelease(windows, nowMs) { return implementation(windows, nowMs); }});
      }
`;

const releaseChecks = [
  ["hidden_release_reference", 0],
  ["hidden_release_boundaries", 1],
  ["hidden_release_paused", 2],
  ["hidden_release_priority", 3],
] as const;

export const PRODUCT_TASK_SPECS: readonly ProductTaskSpec[] = Object.freeze([
  {
    id: "shipment_quote",
    objective: "Implement the shipment quote feature described in README.md across the four existing src modules. Preserve their APIs, validate the documented boundaries, stay dependency-free, change only the allowed source files, and run npm test.",
    readme: shipmentReadme,
    limitations: "Small synchronous quote calculation; no payments, network, persistence, taxes, or inventory concurrency. Shared contracts require integration; no team-only instruction or guaranteed advantage.",
    allowedChangedPaths: ["src/cart.js", "src/pricing.js", "src/delivery.js", "src/quote.js"],
    sources: {
      "src/cart.js": `export function normalizeCart(_items, _catalog) { throw new Error('Cart normalization not implemented'); }\n`,
      "src/pricing.js": `export function priceCart(_lines, _discountBps = 0) { throw new Error('Pricing not implemented'); }\n`,
      "src/delivery.js": `export function deliveryCost(_totalGrams, _merchandiseCents, _zone) { throw new Error('Delivery rates not implemented'); }\n`,
      "src/quote.js": `import { normalizeCart } from './cart.js';
import { priceCart } from './pricing.js';
import { deliveryCost } from './delivery.js';
export function quote(items, catalog, { zone = 'local', discountBps = 0 } = {}) {
  const lines = normalizeCart(items, catalog);
  const price = priceCart(lines, discountBps);
  const deliveryCents = deliveryCost(0, price.merchandiseCents, zone);
  return { lines, ...price, deliveryCents, totalCents: price.merchandiseCents };
}
`,
    },
    visibleTests: testHeader + `import { quote } from '../src/quote.js';
test('two parcels produce an integrated shipment quote', () => {
  assert.deepEqual(quote([{sku:'book',quantity:2}], {book:{unitCents:1200,grams:600,stock:3}}), {
    lines:[{sku:'book',quantity:2,unitCents:1200,grams:600}],
    subtotalCents:2400,discountCents:0,merchandiseCents:2400,deliveryCents:900,totalCents:3300,
  });
});
test('empty quote has no charge', () => {
  assert.equal(quote([], {}).totalCents, 0);
});
`,
    checkIds: ["hidden_shipment_cart", "hidden_shipment_validation", "hidden_shipment_rates", "hidden_shipment_integration"],
    hiddenChecks: `
    ['hidden_shipment_cart', async () => {
      const { normalizeCart: n } = await load('src/cart.js');
      const catalog = Object.freeze({a:Object.freeze({unitCents:0,grams:1,stock:4}),b:Object.freeze({unitCents:37,grams:30,stock:9})});
      const items = Object.freeze([Object.freeze({sku:'b',quantity:2}),Object.freeze({sku:'a',quantity:1}),Object.freeze({sku:'b',quantity:3})]);
      const before = JSON.stringify([items,catalog]);
      const result = n(items,catalog);
      deepEqual(result,[{sku:'b',quantity:5,unitCents:37,grams:30},{sku:'a',quantity:1,unitCents:0,grams:1}]);
      equal(JSON.stringify([items,catalog]),before);
      result[0].quantity = 1; equal(items[0].quantity,2);
      deepEqual(n([],catalog),[]);
      const special = JSON.parse('{"__proto__":{"unitCents":2,"grams":1,"stock":2}}');
      equal(n([{sku:'__proto__',quantity:1}],special)[0].unitCents,2);
    }],
    ['hidden_shipment_validation', async () => {
      const { normalizeCart: n } = await load('src/cart.js');
      const valid = {a:{unitCents:1,grams:1,stock:3}};
      for (const quantity of [0,-1,1.5,1001,'1',NaN]) throws(() => n([{sku:'a',quantity}],valid),TypeError);
      for (const items of [null,{},[null],[{sku:'',quantity:1}],Array(101).fill({sku:'a',quantity:1})]) throws(() => n(items,valid),TypeError);
      for (const catalog of [null,[],Object.create(valid),{}]) throws(() => n([{sku:'a',quantity:1}],catalog),TypeError);
      for (const [field,values] of Object.entries({unitCents:[-1,1.5,1000001,'2'],grams:[0,1.5,100001],stock:[-1,0.5,1000001]})) {
        for (const value of values) throws(() => n([{sku:'a',quantity:1}],{a:{...valid.a,[field]:value}}),TypeError);
      }
      throws(() => n([{sku:'a',quantity:2},{sku:'a',quantity:2}],valid),RangeError);
      throws(() => n([{sku:'a',quantity:1}],{a:{...valid.a,stock:0}}),RangeError);
      equal(n([{sku:'a',quantity:1000}],{a:{unitCents:1000000,grams:100000,stock:1000}})[0].quantity,1000);
    }],
    ['hidden_shipment_rates', async () => {
      const { priceCart: p } = await load('src/pricing.js');
      const { deliveryCost: d } = await load('src/delivery.js');
      deepEqual(p([{quantity:1,unitCents:101},{quantity:1,unitCents:101}],100),{subtotalCents:202,discountCents:2,merchandiseCents:200});
      deepEqual(p([{quantity:1,unitCents:101},{quantity:1,unitCents:101}],5000),{subtotalCents:202,discountCents:101,merchandiseCents:101});
      deepEqual(p([{quantity:3,unitCents:333}],3333),{subtotalCents:999,discountCents:332,merchandiseCents:667});
      equal(p([{quantity:1,unitCents:9}],10000).merchandiseCents,0);
      for (const bps of [-1,10001,0.5,'100',NaN]) throws(() => p([],bps),TypeError);
      for (const grams of [1,999,1000,1001,2000,2001]) {
        equal(d(grams,4999,'local'),500+200*Math.ceil(grams/1000));
        equal(d(grams,5000,'local'),0);
        equal(d(grams,9000,'remote'),900+350*Math.ceil(grams/1000));
      }
      equal(d(0,0,'remote'),0);
      for (const args of [[0,0,'other'],[-1,0,'local'],[0.5,0,'local'],[1,-1,'local'],[1,0.5,'local'],[Infinity,0,'local'],[10000000001,0,'local'],[1,100000000001,'local']]) throws(() => d(...args),TypeError);
    }],
    ['hidden_shipment_integration', async () => {
      const { quote: q } = await load('src/quote.js');
      const catalog = {a:{unitCents:2600,grams:501,stock:4}};
      const result = q([{sku:'a',quantity:1},{sku:'a',quantity:1}],catalog,{discountBps:500});
      deepEqual(result,{lines:[{sku:'a',quantity:2,unitCents:2600,grams:501}],subtotalCents:5200,discountCents:260,merchandiseCents:4940,deliveryCents:900,totalCents:5840});
      equal(q([{sku:'a',quantity:2}],catalog).deliveryCents,0);
      equal(q([{sku:'a',quantity:2}],catalog,{zone:'remote'}).totalCents,6800);
      equal(q([{sku:'a',quantity:1}],catalog,{discountBps:10000}).totalCents,700);
      throws(() => q([],{}, {zone:'unknown'}),TypeError);
      throws(() => q([],{}, {discountBps:10001}),TypeError);
      throws(() => q([{sku:'a',quantity:5}],catalog),RangeError);
    }],`,
  },
  {
    id: "incremental_build_repair",
    objective: "Repair the incremental build watcher described in README.md across snapshot comparison, reverse dependency traversal and plan integration. Preserve the documented APIs and module responsibilities, keep inputs untouched, change only the three allowed source files, and run npm test.",
    readme: buildReadme,
    limitations: "Small in-memory invalidation planner; does not compile, watch files, measure throughput, or prove real build-cache correctness. Cycles use conservative closure, not execution scheduling.",
    allowedChangedPaths: ["src/changes.js", "src/dependents.js", "src/plan.js"],
    sources: {
      "src/changes.js": `export function diffSnapshots(previous, current) {
  return {changed:Object.keys(current).filter(name => !previous[name]),removed:[]};
}
`,
      "src/dependents.js": `export function affectedModules(graph, changed) {
  const result = [...changed];
  for (const name of Object.keys(graph)) if (graph[name].some(dep => changed.includes(dep))) result.push(name);
  return result.sort();
}
`,
      "src/plan.js": `import { diffSnapshots } from './changes.js';
import { affectedModules } from './dependents.js';
export function planBuild(graph, previous, current) {
  const delta = diffSnapshots(previous,current);
  return {...delta,build:affectedModules(graph,delta.changed)};
}
`,
    },
    visibleTests: testHeader + `import { planBuild } from '../src/plan.js';
test('changed library invalidates its application', () => {
  assert.deepEqual(planBuild({app:['lib'],lib:[]},{app:'a',lib:'old'},{app:'a',lib:'new'}),{changed:['lib'],removed:[],build:['app','lib']});
});
test('unchanged projects do no work', () => {
  assert.deepEqual(planBuild({app:[]},{app:'a'},{app:'a'}),{changed:[],removed:[],build:[]});
});
`,
    checkIds: ["hidden_build_snapshots", "hidden_build_transitive", "hidden_build_cycles", "hidden_build_integration"],
    hiddenChecks: `
    ['hidden_build_snapshots', async () => {
      const { diffSnapshots: d } = await load('src/changes.js');
      const previous = Object.freeze({z:'old',empty:'',removed:'r',same:'s'}), current = Object.freeze({z:'new',empty:'',added:'',same:'s'});
      deepEqual(d(previous,current),{changed:['added','z'],removed:['removed']});
      deepEqual(d({a:'01'},{a:'1'}),{changed:['a'],removed:[]});
      const before = JSON.parse('{"__proto__":"old","constructor":"c"}');
      const after = JSON.parse('{"__proto__":"new","constructor":"c"}');
      deepEqual(d(before,after),{changed:['__proto__'],removed:[]});
      deepEqual(d(Object.assign(Object.create({x:'old'}),{a:'1'}),Object.assign(Object.create({y:'2'}),{x:'new'})),{changed:['x'],removed:['a']});
      deepEqual(d({Z:'1',a:'2'},{}),{changed:[],removed:['Z','a']});
    }],
    ['hidden_build_transitive', async () => {
      const { affectedModules: a } = await load('src/dependents.js');
      const graph = Object.freeze({app:Object.freeze(['ui','cli']),ui:Object.freeze(['core']),cli:Object.freeze(['core','core']),core:Object.freeze([]),other:Object.freeze([])});
      const changed = Object.freeze(['core','missing','core']);
      deepEqual(a(graph,changed),['app','cli','core','ui']);
      deepEqual(a(graph,['app']),['app']);
      deepEqual(a({},['unknown']),[]);
      deepEqual(a(Object.assign(Object.create({ghost:[]}),{real:[]}),['ghost']),[]);
      const special = JSON.parse('{"__proto__":[],"constructor":["__proto__"],"page":["constructor"]}');
      deepEqual(a(special,['__proto__']),['__proto__','constructor','page']);
    }],
    ['hidden_build_cycles', async () => {
      const { affectedModules: a } = await load('src/dependents.js');
      deepEqual(a({a:['b'],b:['c'],c:['a'],d:['c'],alone:['alone']},['b']),['a','b','c','d']);
      deepEqual(a({a:['a','a']},['a','a']),['a']);
      const graph = Object.fromEntries(Array.from({length:40},(_,i) => ['n'+i,i ? ['n'+(i-1)] : []]));
      deepEqual(a(graph,['n0']),Object.keys(graph).sort());
    }],
    ['hidden_build_integration', async () => {
      const { planBuild: p } = await load('src/plan.js');
      const graph = Object.freeze({app:Object.freeze(['view']),view:Object.freeze(['removed']),removed:Object.freeze([]),new:Object.freeze([]),untouched:Object.freeze([])});
      const previous = Object.freeze({app:'a',view:'v',removed:'r',untouched:'u'}), current = Object.freeze({app:'a',view:'v',new:'n',untouched:'u',outside:'x'});
      const before = JSON.stringify([graph,previous,current]);
      deepEqual(p(graph,previous,current),{changed:['new','outside'],removed:['removed'],build:['app','new','view']});
      equal(JSON.stringify([graph,previous,current]),before);
      deepEqual(p({a:[]},{a:'x'},Object.create({a:'x'})),{changed:[],removed:['a'],build:[]});
      deepEqual(p({a:[]},{a:''},{a:''}),{changed:[],removed:[],build:[]});
      deepEqual(p({a:[]},{a:'1'},{}),{changed:[],removed:['a'],build:[]});
    }],`,
  },
  {
    id: "release_window_regressions",
    objective: "Write the reusable checkReleaseWindow(api) regression checker described in README.md. Exercise the supplied API through public behavior, accept conforming implementations and reject violations with assertions. Change only checks/release-contract.js, keep each invocation independent, and run npm test.",
    readme: releaseReadme,
    limitations: "Authored contract-check effectiveness on three fixed behavioral mutants, not general bug discovery. Manual source review for introspection, stateful grading tricks and input-contract violations is required before reporting results; this verifier is not proof against adversarial candidate code.",
    allowedChangedPaths: ["checks/release-contract.js"],
    sources: {
      "src/release.js": releaseSource,
      "checks/release-contract.js": `export async function checkReleaseWindow(_api) {\n  // Add reusable behavioral assertions against the supplied API.\n}\n`,
    },
    visibleTests: testHeader + `import { selectRelease } from '../src/release.js';
import { checkReleaseWindow } from '../checks/release-contract.js';
test('checker accepts the working release scheduler on repeated invocations', async () => {
  await checkReleaseWindow(Object.freeze({selectRelease}));
  await checkReleaseWindow(Object.freeze({selectRelease}));
});
`,
    checkIds: releaseChecks.map(([id]) => id),
    hiddenChecks: releaseChecks.map(([id, mode]) => `
    ['${id}', async () => {
      const { checkReleaseWindow: check } = await load('checks/release-contract.js');
      equal(typeof check, 'function');
      ${releaseApiFactory}
      await check(makeApi(0));
      await check(makeApi(0));
      ${mode === 0 ? "" : `let rejected = false;
      try { await check(makeApi(${mode})); } catch (error) { rejected = error instanceof Error; }
      equal(rejected, true);`}
      await check(makeApi(0));
    }],`).join("\n"),
  },
]);
