// Render terminal walkthrough SVG frames (smoke-terminal --record-gif-frames)
// into a sharp GIF at 2x. Chrome rasterizes each SVG; this file quantizes to
// one 256-colour palette and LZW-encodes only the region that changed.
// Usage: node scripts/render-workflow-gif.mjs <frames-directory> <out.gif> [scale]
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import console from "node:console";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

const [framesDirectory, output, scaleText = "2"] = process.argv.slice(2);
if (!framesDirectory || !output) throw new Error("Usage: render-workflow-gif.mjs <frames-directory> <out.gif> [scale]");
const scale = Number(scaleText);
const names = (await readdir(framesDirectory)).filter((name) => name.endsWith(".svg")).sort();
const { frameDurationMs } = JSON.parse(await readFile(path.join(framesDirectory, "timing.json"), "utf8"));
const chromePath = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Rasterize with headless Chrome through the DevTools protocol.
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(chromePath, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${await mkdtemp(path.join(tmpdir(), "gif-chrome-"))}`, "about:blank"], { stdio: "ignore" });
let target;
for (let attempt = 0; attempt < 100 && target === undefined; attempt += 1) {
  try { target = (await (await globalThis.fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === "page"); } catch { /* Starting. */ }
  await delay(100);
}
const socket = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 1 << 30 });
await new Promise((resolve) => socket.once("open", resolve));
let nextId = 0;
const pending = new Map();
socket.on("message", (data) => { const message = JSON.parse(data); pending.get(message.id)?.(message); });
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, (message) => message.error ? reject(new Error(message.error.message)) : resolve(message.result));
  socket.send(JSON.stringify({ id, method, params }));
});
async function rasterize(svg) {
  const expression = `(async () => {
    const image = new Image();
    image.src = "data:image/svg+xml;base64," + ${JSON.stringify(Buffer.from(svg).toString("base64"))};
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.naturalWidth * ${scale}); canvas.height = Math.round(image.naturalHeight * ${scale});
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let binary = ""; for (let index = 0; index < pixels.length; index += 32768) binary += String.fromCharCode(...pixels.subarray(index, index + 32768));
    return JSON.stringify({ width: canvas.width, height: canvas.height, data: btoa(binary) });
  })()`;
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  const { width, height, data } = JSON.parse(result.result.value);
  return { width, height, rgba: Buffer.from(data, "base64") };
}

const frames = [];
for (const name of names) frames.push(await rasterize(await readFile(path.join(framesDirectory, name), "utf8")));
socket.close(); chrome.kill();
const { width, height } = frames[0];

// One global palette: the 255 most frequent colours (5 bits per channel,
// each the true average of its bucket); index 255 is transparent.
const TRANSPARENT = 255;
const key = (data, index) => ((data[index] >> 3) << 10) | ((data[index + 1] >> 3) << 5) | (data[index + 2] >> 3);
const buckets = new Map();
for (const frame of frames.filter((_, index) => index % 3 === 0)) {
  for (let index = 0; index < frame.rgba.length; index += 4) {
    if (frame.rgba[index + 3] < 128) continue;
    const bucket = buckets.get(key(frame.rgba, index)) ?? [0, 0, 0, 0];
    bucket[0] += 1; bucket[1] += frame.rgba[index]; bucket[2] += frame.rgba[index + 1]; bucket[3] += frame.rgba[index + 2];
    buckets.set(key(frame.rgba, index), bucket);
  }
}
const palette = [...buckets.values()].sort((left, right) => right[0] - left[0]).slice(0, 255).map(([count, r, g, b]) => [Math.round(r / count), Math.round(g / count), Math.round(b / count)]);
while (palette.length < 256) palette.push([0, 0, 0]);
const nearest = new Map();
const indexFor = (data, offset) => {
  if (data[offset + 3] < 128) return TRANSPARENT;
  const bucket = key(data, offset);
  let found = nearest.get(bucket);
  if (found === undefined) {
    let best = Infinity;
    const [r, g, b] = [((bucket >> 10) & 31) << 3 | 4, ((bucket >> 5) & 31) << 3 | 4, (bucket & 31) << 3 | 4];
    palette.slice(0, TRANSPARENT).forEach(([pr, pg, pb], index) => { const distance = (pr - r) ** 2 * 2 + (pg - g) ** 2 * 4 + (pb - b) ** 2 * 3; if (distance < best) { best = distance; found = index; } });
    nearest.set(bucket, found);
  }
  return found;
};
const indexed = frames.map((frame) => { const pixels = new Uint8Array(width * height); for (let pixel = 0; pixel < pixels.length; pixel += 1) pixels[pixel] = indexFor(frame.rgba, pixel * 4); return pixels; });

// GIF LZW for 8-bit indices.
function lzw(pixels) {
  const minimum = 8, clear = 256, end = 257;
  const bytes = [];
  let bits = 0, bitCount = 0, codeSize = minimum + 1;
  const write = (code) => { bits |= code << bitCount; bitCount += codeSize; while (bitCount >= 8) { bytes.push(bits & 255); bits >>= 8; bitCount -= 8; } };
  let table = new Map(), next = end + 1;
  write(clear);
  let prefix = pixels[0];
  for (let index = 1; index < pixels.length; index += 1) {
    const pixel = pixels[index];
    const joined = prefix * 256 + pixel;
    const code = table.get(joined);
    if (code !== undefined) { prefix = code; continue; }
    write(prefix);
    if (next < 4096) { table.set(joined, next); next += 1; if (next > (1 << codeSize) && codeSize < 12) codeSize += 1; }
    else { write(clear); table = new Map(); next = end + 1; codeSize = minimum + 1; }
    prefix = pixel;
  }
  write(prefix); write(end);
  if (bitCount > 0) bytes.push(bits & 255);
  const blocks = [minimum];
  for (let index = 0; index < bytes.length; index += 255) { const chunk = bytes.slice(index, index + 255); blocks.push(chunk.length, ...chunk); }
  blocks.push(0);
  return Buffer.from(blocks);
}

const parts = [];
const word = (value) => [value & 255, value >> 8];
parts.push(Buffer.from("GIF89a"), Buffer.from([...word(width), ...word(height), 0xf7, 0, 0]), Buffer.from(palette.flat()));
parts.push(Buffer.from([0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0]));
// Each emitted frame stays on screen until the next frame that differs.
const changed = indexed.map((pixels, index) => index === 0 || pixels.some((value, offset) => value !== indexed[index - 1][offset]));
const emitted = changed.flatMap((isChange, index) => isChange ? [index] : []);
for (const [position, frameIndex] of emitted.entries()) {
  const pixels = indexed[frameIndex];
  const previous = position === 0 ? null : indexed[emitted[position - 1]];
  let [left, top, right, bottom] = [0, 0, width - 1, height - 1];
  if (previous !== null) {
    [left, top, right, bottom] = [width, height, -1, -1];
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const offset = y * width + x;
      if (pixels[offset] !== previous[offset]) { if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y; }
    }
  }
  const regionWidth = right - left + 1, regionHeight = bottom - top + 1;
  const region = new Uint8Array(regionWidth * regionHeight);
  for (let y = 0; y < regionHeight; y += 1) region.set(pixels.subarray((top + y) * width + left, (top + y) * width + left + regionWidth), y * regionWidth);
  const nextChange = emitted[position + 1] ?? indexed.length;
  const centiseconds = Math.round((nextChange - frameIndex) * frameDurationMs / 10);
  parts.push(Buffer.from([0x21, 0xf9, 4, 0x05, ...word(centiseconds), TRANSPARENT, 0]));
  parts.push(Buffer.from([0x2c, ...word(left), ...word(top), ...word(regionWidth), ...word(regionHeight), 0]), lzw(region));
}
parts.push(Buffer.from([0x3b]));
const gif = Buffer.concat(parts);
await writeFile(output, gif);
console.log(JSON.stringify({ frames: frames.length, width, height, bytes: gif.length }));
