import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const html = await readFile(join(root, "src/index.html"), "utf8");
const css = await readFile(join(root, "src/styles.css"), "utf8");
const js = await readFile(join(root, "src/app.ts"), "utf8");
const dev = await readFile(join(root, "scripts/dev.mjs"), "utf8");

test("keeps all supported install choices above the product stage", () => {
  const stage = html.indexOf('class="product-stage"');
  for (const command of [
    "npm install --global recurs@alpha",
    "curl -fsSL https://github.com/tacotuesday8888/recurs/releases/download/v0.1.0-alpha.7/install.sh | sh",
    "brew install tacotuesday8888/recurs/recurs",
    "bun install --global recurs@alpha",
  ]) assert.ok(html.indexOf(command) > -1 && html.indexOf(command) < stage, `${command} must appear before the stage`);
  assert.match(html, /Bun installs the package\. Node\.js is the current runtime\./);
});

test("provides semantic interaction and non-JavaScript content", () => {
  assert.match(html, /<main id="main">/);
  assert.match(html, /<nav aria-label="Primary navigation">/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /data-reveal/);
  assert.match(html, /class="company-view"/);
  assert.doesNotMatch(css, /\.company-view\s*\{[^}]*display:\s*none/s);
  assert.doesNotMatch(css, /(^|,|\})\s*\[data-reveal\]\s*\{[^}]*opacity:\s*0/ms);
  assert.match(html, /data-enter-company/);
  assert.match(html, /data-back-to-map/);
});

test("respects reduced motion and avoids hidden selection boxes", () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /animation-duration: \.01ms !important/);
  assert.match(css, /\.js-enhanced \[data-reveal\].*opacity: 1; transform: none/s);
  assert.match(js, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches/);
  assert.match(js, /if \(!reduceMotion && "IntersectionObserver" in window\)/);
  assert.doesNotMatch(css, /\.agent\.is-selected\s*\{[^}]*border:/s);
});

test("implements copy fallback, company selection, and reversible transition", () => {
  assert.match(js, /navigator\.clipboard\.writeText/);
  assert.match(js, /copied = document\.execCommand\("copy"\)/);
  assert.match(js, /button\.textContent = copied \? "Copied" : "Copy failed"/);
  assert.match(js, /could not be copied\. Select the command manually\./);
  assert.match(js, /finally \{\s*field\?\.remove\(\);/s);
  assert.match(js, /setAttribute\("aria-pressed", String\(selected\)\)/);
  assert.match(js, /setCompanyView\("terminal"\)/);
  assert.match(js, /setCompanyView\("company"\)/);
  assert.match(html, /data-terminal-view role="region" aria-label="Recurs CLI conversation" tabindex="-1" hidden/);
  assert.match(js, /focus\(\{ preventScroll: true \}\)/);
});

test("uses truthful product claims", () => {
  assert.match(html, /open-source coding harness/);
  assert.match(html, /Turn coding models into a team\./);
  assert.match(html, /You control the team\./);
  assert.doesNotMatch(html, /The best coding model is a team\./);
  assert.match(html, /team size, routes, depth, communication, authority, and budgets/);
  assert.doesNotMatch(html.toLowerCase(), /self-improv|best benchmark|outperform/);
});

test("does not invent cost evidence or an ungoverned social card", () => {
  assert.match(html, /3 requests \/ 12 · reported cost unknown/);
  assert.doesNotMatch(html, /\$\d/);
  assert.doesNotMatch(html, /og:image|recurs-social/);
  assert.match(html, /<meta name="twitter:card" content="summary">/);
  assert.doesNotMatch(html, /summary_large_image/);
});

test("progressive reveal is observer-driven and remains optional", () => {
  assert.match(js, /new IntersectionObserver/);
  assert.match(js, /classList\.add\("js-enhanced"\)/);
  assert.match(js, /classList\.remove\("reveal-pending"\)/);
  assert.match(css, /\.js-enhanced \[data-reveal\]\.reveal-pending/);
});

test("preview uses the guaranteed Node runtime and an explicit static allowlist", () => {
  assert.match(dev, /createServer/);
  assert.match(dev, /request\.method !== "GET" && request\.method !== "HEAD"/);
  assert.match(dev, /routes\.get\(pathname\) \?\? \["404\.html"/);
  assert.match(dev, /server\.listen\(4173, "127\.0\.0\.1"/);
  assert.match(dev, /void serve\(request, response\)\.catch/);
  assert.match(dev, /response\.writeHead\(500/);
  assert.match(dev, /response\.destroy\(\)/);
  assert.match(dev, /server\.once\("error"/);
  assert.match(dev, /process\.exitCode = 1/);
  assert.doesNotMatch(dev, /python|spawn\(/i);
});

test("programmatic terminal focus keeps the global visible indicator", () => {
  assert.match(css, /:focus-visible \{ outline: 2px solid var\(--mint\)/);
  assert.doesNotMatch(css, /\.terminal-view:focus\s*\{[^}]*outline:\s*none/s);
});

test("tiny status text keeps accessible contrast and no-JS overlays cannot collide", () => {
  assert.match(css, /\.agent small \{ color: #74807c;/);
  assert.match(css, /\.terminal-meta \{[^}]*color: #74807c;/s);
  assert.doesNotMatch(html, /noscript-note/);
  assert.doesNotMatch(css, /\.noscript-note/);
});

test("install commands remain readable when copy controls have no JavaScript", () => {
  assert.match(css, /\.install-row code \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/s);
  assert.match(css, /\.has-js \.install-row code \{[^}]*overflow-x: auto;[^}]*white-space: nowrap;/s);
  assert.match(css, /\.copy-button \{ display: none;/);
  assert.match(css, /\.has-js \.copy-button \{ display: inline-block; \}/);
  assert.match(js, /document\.documentElement\.classList\.add\("has-js"\)/);
  assert.doesNotMatch(css, /(^|\})\s*\.install-row code \{[^}]*overflow(?:-x)?: hidden/s);
});
