// Render the terminal's exact ASCII R as a static SVG for the README, where
// the website's animated version cannot run. Colours come from the brand.
import console from "node:console";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import process from "node:process";
import ts from "typescript";
import { RECURS_BRAND } from "./recurs-brand.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "packages/cli/src/terminal-opening-art.ts"), "utf8");
const module = path.join(tmpdir(), `recurs-letter-${process.pid}.mjs`);
await writeFile(module, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText);
const { renderTerminalOpeningArt } = await import(pathToFileURL(module).href);
const colors = [RECURS_BRAND.palette.muted, RECURS_BRAND.palette.orange, RECURS_BRAND.palette.foreground];
const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
// Same crop and lighting thresholds as website/src/letter.ts.
const rows = renderTerminalOpeningArt(64, 20, 0).map((row, y) => {
  let output = "", run = "", start = 0, role = 0;
  const emit = () => { if (run.trim()) output += `<text x="${start * 6}" y="${y * 10 + 9}" fill="${colors[role]}" xml:space="preserve">${escape(run)}</text>`; };
  row.slice(17, 47).forEach(({ ch, light }, x) => {
    const next = light > 0.77 ? 2 : light > 0.36 ? 1 : 0;
    if (next !== role) { emit(); run = ""; start = x; role = next; }
    run += ch;
  });
  emit();
  return output;
}).join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-6 -6 192 212" width="192" height="212" role="img" aria-label="Recurs"><rect x="-6" y="-6" width="192" height="212" rx="14" fill="${RECURS_BRAND.palette.background}"/><g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="10">${rows}</g></svg>\n`;
await writeFile(path.join(root, "docs/assets/recurs-letter.svg"), svg);
console.log(`docs/assets/recurs-letter.svg: ${svg.length} bytes`);
