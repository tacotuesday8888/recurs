/** Offline controls only. Never include these candidates in model fixtures. */
export const PRODUCT_TASK_REFERENCES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  shipment_quote: {
    "src/cart.js": `export function normalizeCart(items, catalog) {
  if (!Array.isArray(items) || items.length > 100 || !catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new TypeError('cart');
  const lines = new Map();
  for (const item of items) {
    if (!item || typeof item.sku !== 'string' || !item.sku || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000 || !Object.hasOwn(catalog,item.sku)) throw new TypeError('item');
    const product = catalog[item.sku];
    if (!product || !Number.isInteger(product.unitCents) || product.unitCents < 0 || product.unitCents > 1000000 || !Number.isInteger(product.grams) || product.grams < 1 || product.grams > 100000 || !Number.isInteger(product.stock) || product.stock < 0 || product.stock > 1000000) throw new TypeError('product');
    const quantity = (lines.get(item.sku)?.quantity ?? 0) + item.quantity;
    if (quantity > product.stock) throw new RangeError('stock');
    lines.set(item.sku,{sku:item.sku,quantity,unitCents:product.unitCents,grams:product.grams});
  }
  return [...lines.values()];
}
`,
    "src/pricing.js": `export function priceCart(lines, discountBps = 0) {
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > 10000) throw new TypeError('discount');
  const subtotalCents = lines.reduce((sum,line) => sum + line.quantity * line.unitCents,0);
  const discountCents = Math.floor(subtotalCents * discountBps / 10000);
  return {subtotalCents,discountCents,merchandiseCents:subtotalCents-discountCents};
}
`,
    "src/delivery.js": `export function deliveryCost(totalGrams, merchandiseCents, zone) {
  if (!Number.isInteger(totalGrams) || totalGrams < 0 || totalGrams > 10000000000 || !Number.isInteger(merchandiseCents) || merchandiseCents < 0 || merchandiseCents > 100000000000 || !['local','remote'].includes(zone)) throw new TypeError('delivery');
  if (totalGrams === 0 || (zone === 'local' && merchandiseCents >= 5000)) return 0;
  const kilograms = Math.ceil(totalGrams / 1000);
  return zone === 'local' ? 500 + 200 * kilograms : 900 + 350 * kilograms;
}
`,
    "src/quote.js": `import { normalizeCart } from './cart.js';
import { priceCart } from './pricing.js';
import { deliveryCost } from './delivery.js';
export function quote(items, catalog, {zone = 'local',discountBps = 0} = {}) {
  const lines = normalizeCart(items,catalog);
  const price = priceCart(lines,discountBps);
  const grams = lines.reduce((sum,line) => sum + line.quantity * line.grams,0);
  const deliveryCents = deliveryCost(grams,price.merchandiseCents,zone);
  return {lines,...price,deliveryCents,totalCents:price.merchandiseCents+deliveryCents};
}
`,
  },
  incremental_build_repair: {
    "src/changes.js": `export function diffSnapshots(previous, current) {
  const oldKeys = new Set(Object.keys(previous)), newKeys = new Set(Object.keys(current));
  return {changed:[...newKeys].filter(name => !oldKeys.has(name) || previous[name] !== current[name]).sort(),removed:[...oldKeys].filter(name => !newKeys.has(name)).sort()};
}
`,
    "src/dependents.js": `export function affectedModules(graph, changed) {
  const names = new Set(Object.keys(graph));
  const reverse = new Map([...names].map(name => [name,[]]));
  for (const name of names) for (const dependency of graph[name]) reverse.get(dependency).push(name);
  const result = new Set(changed.filter(name => names.has(name)));
  const pending = [...result];
  for (let i=0;i<pending.length;i++) for (const importer of reverse.get(pending[i])) {
    if (!result.has(importer)) { result.add(importer); pending.push(importer); }
  }
  return [...result].sort();
}
`,
    "src/plan.js": `import { diffSnapshots } from './changes.js';
import { affectedModules } from './dependents.js';
export function planBuild(graph, previous, current) {
  const delta = diffSnapshots(previous,current);
  const present = new Set(Object.keys(current));
  return {...delta,build:affectedModules(graph,[...delta.changed,...delta.removed]).filter(name => present.has(name))};
}
`,
  },
  release_window_regressions: {
    "checks/release-contract.js": `import assert from 'node:assert/strict';
export async function checkReleaseWindow(api) {
  const window = (id, overrides = {}) => ({id,startMs:10,endMs:20,paused:false,priority:1,...overrides});
  const result = w => ({id:w.id,startMs:w.startMs,endMs:w.endMs,priority:w.priority});
  assert.equal(api.selectRelease([],15),null);
  const a = window('a');
  assert.equal(api.selectRelease([a],9),null);
  assert.deepEqual(api.selectRelease([a],10),result(a));
  assert.deepEqual(api.selectRelease([a],19),result(a));
  assert.equal(api.selectRelease([a],20),null);
  assert.equal(api.selectRelease([window('paused',{paused:true})],15),null);
  const low = window('low',{priority:-1}), high = window('high',{priority:3});
  assert.deepEqual(api.selectRelease([low,high],15),result(high));
  assert.deepEqual(api.selectRelease([high,low],15),result(high));
  assert.deepEqual(api.selectRelease([window('z'),a],15),result(a));
  const input = [window('z'),window('a')], before = JSON.stringify(input);
  const selected = api.selectRelease(input,15);
  assert.equal(JSON.stringify(input),before);
  assert.notEqual(selected,input[1]);
  selected.id = 'changed';
  assert.equal(input[1].id,'a');
}
`,
  },
};
