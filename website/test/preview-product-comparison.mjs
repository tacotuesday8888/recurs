/* global console, process, URL */
/** Explicit test-only browser surface. Does not write synthetic data to .build. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderProductComparison } from "../.build/product-comparison.js";
import { syntheticProductComparison } from "./product-comparison-fixtures.mjs";

const output = fileURLToPath(new URL("../.build/", import.meta.url));
const data = syntheticProductComparison();
data.attempts[0].executionStatus = "timed_out";
data.attempts[1].sourceReview = "failed";
data.attempts[2].validity = "invalid";
data.attempts[2].note = "SYNTHETIC-TEST-ONLY: setup mismatch retained for audit.";
const banner = '<aside style="position:fixed;bottom:0;left:0;right:0;z-index:100;padding:8px;text-align:center;border:2px solid var(--accent);color:var(--ink);background:var(--canvas);font-size:12px">Synthetic test preview — these are not benchmark results.</aside>';
const current = await readFile(path.join(output, "index.html"), "utf8");
if (current.includes('id="product-comparison"')) throw new Error("Do not mix the synthetic preview with a built real comparison");
const html = current.replace('<section class="evidence-section" id="evidence"', `${banner}${renderProductComparison(data)}<section class="evidence-section" id="evidence"`);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".mp4": "video/mp4" };
const server = createServer((request, response) => {
  void (async () => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html); return; }
    const target = path.resolve(output, `.${pathname}`);
    if (!target.startsWith(path.resolve(output) + path.sep)) { response.writeHead(404).end(); return; }
    try { const content = await readFile(target); response.writeHead(200, { "Content-Type": types[path.extname(target)] ?? "text/plain" }).end(content); }
    catch { response.writeHead(404).end(); }
  })().catch(() => response.destroy());
});
server.listen(0, "127.0.0.1", () => console.log(`Synthetic test preview only: http://127.0.0.1:${server.address().port}/#product-comparison`));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
