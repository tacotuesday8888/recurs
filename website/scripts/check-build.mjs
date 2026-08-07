/* global console */
import { access, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const html = await readFile(join(dist, "index.html"), "utf8");
const localLinks = [...html.matchAll(/(?:href|src)="(?!https?:|#)([^"]+)"/g)].map((match) => match[1]);
for (const link of localLinks) await access(join(dist, link));

const requiredExternal = [
  "https://github.com/tacotuesday8888/recurs",
  "https://www.npmjs.com/package/recurs",
];
for (const link of requiredExternal) {
  if (!html.includes(link)) throw new Error(`Missing external link: ${link}`);
}

const assets = ["index.html", "styles.css", "app.js", "assets/recurs-mark.svg"];
let bytes = 0;
for (const asset of assets) bytes += (await stat(join(dist, asset))).size;
if (bytes > 150_000) throw new Error(`Static asset budget exceeded: ${bytes} bytes`);
console.log(`Validated ${localLinks.length} local links and ${bytes} bytes of core assets.`);
