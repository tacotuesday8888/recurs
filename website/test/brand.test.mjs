/* global URL */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { RECURS_BRAND } from "../../scripts/recurs-brand.mjs";
import { RECURS_PALETTE } from "../../packages/cli/dist/generated/recurs-brand.js";

const css = await readFile(new URL("../.build/styles.css", import.meta.url), "utf8");
const variables = new Map([...css.matchAll(/(--[\w-]+):\s*([^;{}]+);/gu)].map(match => [match[1], match[2]]));
function resolve(name) {
  const value = variables.get(name);
  return value?.startsWith("var(") ? resolve(value.slice(4, -1)) : value;
}
function luminance(hex) {
  const channels = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}

test("built website and generated terminal colors share the canonical brand palette", () => {
  assert.deepEqual(RECURS_PALETTE, RECURS_BRAND.palette);
  for (const [name, value] of Object.entries(RECURS_BRAND.palette)) assert.equal(resolve(`--recurs-${name}`), value);
  for (const [role, name] of Object.entries({ canvas: "background", ink: "foreground", muted: "muted", accent: "orange" })) {
    assert.equal(resolve(`--${role}`), RECURS_BRAND.palette[name]);
  }
  assert.match(css, /::selection \{ color: var\(--canvas\); background: var\(--accent\); \}/u);
  for (const [level, role] of ["muted", "accent", "ink"].entries()) {
    assert.ok(css.includes(`.brand-spin .r-light-${level} { fill: var(--${role}); }`));
  }
});

test("primary website text and selection retain at least 4.5:1 contrast", () => {
  for (const background of [resolve("--canvas"), resolve("--paper")]) {
    for (const role of ["ink", "muted", "accent"]) {
      const ratio = (luminance(resolve(`--${role}`)) + .05) / (luminance(background) + .05);
      assert.ok(ratio >= 4.5, `${role} on ${background}: ${ratio}`);
    }
  }
});
