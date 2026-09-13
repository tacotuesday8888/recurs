/* global URL */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderTerminalOpeningArt as terminalArt } from "../../packages/cli/dist/terminal-opening-art.js";
import { renderTerminalOpeningArt as websiteArt } from "../.build/terminal-opening-art.js";
import { terminalLetterSvg } from "../.build/letter.js";

test("the website uses exact terminal R cells and keeps the rotating letter within its crop", () => {
  for (let frame = 0; frame <= 256; frame += 8) {
    const cells = websiteArt(64, 20, frame);
    assert.deepEqual(cells, terminalArt(64, 20, frame));
    assert.ok(cells.every(row => [...row.slice(0, 17), ...row.slice(47)].every(cell => cell.ch === " ")));
  }
  assert.notEqual(terminalLetterSvg(0), terminalLetterSvg(24));
});

test("the exact static R is present before JavaScript runs", async () => {
  const html = await readFile(new URL("../.build/index.html", import.meta.url), "utf8");
  assert.ok(html.includes(terminalLetterSvg(0)));
});
