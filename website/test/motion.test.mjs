/* global URL */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = (await readFile(new URL("../.build/motion.js", import.meta.url), "utf8"))
  .replace(/import[^\n]+\n/u, "const terminalLetterSvg = frame => String(frame);\n")
  .replace("export function", "function");
function harness({ reduced = false, savedPause = false, hash = "" } = {}) {
  const events = new Map(), observers = [], raf = new Map(), intervals = new Map();
  let now = 0, id = 0, animations = 0;
  const counter = { dataset: { countTo: "8" }, textContent: "8" };
  const zero = { dataset: { countTo: "0" }, textContent: "0" };
  const letter = { dataset: {}, innerHTML: "0" };
  const group = { querySelectorAll: () => [counter, zero], animate: () => { animations++; return { cancel() {}, finished: Promise.resolve() }; } };
  const ornament = { querySelector: () => letter };
  const toggle = { addEventListener: (type, cb) => events.set(`toggle:${type}`, cb), setAttribute() {} };
  const preference = { matches: reduced, addEventListener: (type, cb) => events.set(`preference:${type}`, cb) };
  const document = { hidden: false, querySelector: selector => selector === "#motion-toggle" ? toggle : ornament, querySelectorAll: () => [group], addEventListener: (type, cb) => events.set(type, cb) };
  const context = { document, getComputedStyle: () => ({ getPropertyValue: () => "cubic-bezier(0.23,1,0.32,1)" }), location: { hash }, matchMedia: () => preference, sessionStorage: { getItem: () => String(savedPause), setItem() {} }, performance: { now: () => now },
    requestAnimationFrame: cb => { raf.set(++id, cb); return id; }, cancelAnimationFrame: key => raf.delete(key), clearInterval: key => intervals.delete(key),
    window: { setInterval: cb => { intervals.set(++id, cb); return id; } },
    IntersectionObserver: class { constructor(cb) { this.cb = cb; this.elements = new Set(); observers.push(this); } observe(element) { this.elements.add(element); } unobserve(element) { this.elements.delete(element); } },
  };
  vm.runInNewContext(`${source}\ninstallPageMotion(() => {});`, context);
  const enter = () => { const observer = observers.find(item => item.elements.has(group)); observer?.cb([{ target: group, isIntersecting: true }]); };
  const step = time => { now = time; const callbacks = [...raf.values()]; raf.clear(); callbacks.forEach(cb => cb(time)); };
  return { counter, zero, letter, toggle, preference, document, events, enter, step, intervals, raf, animations: () => animations, brandVisible: visible => observers[0].cb([{ isIntersecting: visible }]) };
}

test("viewport entry counts once, preserves zero, and stops scheduling after final values", () => {
  const h = harness(); h.enter(); assert.equal(h.counter.textContent, "0");
  h.step(325); assert.equal(h.counter.textContent, "7"); assert.equal(h.zero.textContent, "0");
  h.step(650); assert.equal(h.counter.textContent, "8"); assert.equal(h.raf.size, 0);
  h.enter(); assert.equal(h.animations(), 1);
});

test("keyboard entry, deep links, reduced motion and saved pause keep final results", () => {
  for (const options of [{ reduced: true }, { savedPause: true }, { hash: "#evidence" }]) {
    const h = harness(options); h.enter(); assert.equal(h.counter.textContent, "8"); assert.equal(h.animations(), 0);
  }
  const h = harness(); h.events.get("keydown")(); h.enter(); assert.equal(h.counter.textContent, "8");
});

test("pause, live reduced motion, visibility loss and keyboard interruption settle counts", () => {
  for (const mode of ["pause", "reduce", "hidden", "keyboard"]) {
    const h = harness(); h.brandVisible(true); assert.equal(h.intervals.size, 1); h.enter(); h.step(100);
    if (mode === "pause") h.events.get("toggle:click")();
    if (mode === "reduce") { h.preference.matches = true; h.events.get("preference:change")(); }
    if (mode === "hidden") { h.document.hidden = true; h.events.get("visibilitychange")(); }
    if (mode === "keyboard") h.events.get("keydown")();
    assert.equal(h.counter.textContent, "8"); assert.equal(h.raf.size, 0);
    if (mode !== "keyboard") { assert.equal(h.intervals.size, 0); assert.equal(h.letter.dataset.frame, "0"); }
  }
});

test("the exact R timer stops outside the viewport and has no scroll-position dependency", () => {
  const h = harness(); h.brandVisible(true); [...h.intervals.values()][0](); assert.equal(h.letter.dataset.frame, "1");
  h.brandVisible(false); assert.equal(h.intervals.size, 0); assert.equal(h.events.has("scroll"), false);
});
