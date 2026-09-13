/* global process, URL */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
await import("./build.mjs");

const routes = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/404.html", ["404.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/evidence.js", ["evidence.js", "text/javascript; charset=utf-8"]],
  ["/charts.js", ["charts.js", "text/javascript; charset=utf-8"]],
  ["/task-fit-protocol.md", ["task-fit-protocol.md", "text/plain; charset=utf-8"]],
  ["/summary.json", ["summary.json", "application/json"]],
  ["/results.json", ["results.json", "application/json"]],
  ["/current-results.json", ["current-results.json", "application/json"]],
  ["/assets/recurs-mark.svg", ["assets/recurs-mark.svg", "image/svg+xml"]],
  ["/.nojekyll", [".nojekyll", "text/plain; charset=utf-8"]],
]);
for (const name of ["task-fit-results.json", "queue-verifier-audit.json"]) routes.set(`/${name}`, [name, "application/json"]);
for (const name of ["task-fit-correction.md", "task-fit-results.md"]) routes.set(`/${name}`, [name, "text/plain; charset=utf-8"]);
for (const name of ["recurs-wordmark.svg", "terminal-patch.svg", "terminal-v19-working.svg", "terminal-diff.svg", "terminal-permission.svg"]) {
  routes.set(`/assets/${name}`, [`assets/${name}`, "image/svg+xml"]);
}

routes.set("/assets/terminal-workflow.mp4", ["assets/terminal-workflow.mp4", "video/mp4"]);
routes.set("/assets/terminal-workflow.json", ["assets/terminal-workflow.json", "application/json"]);

async function serve(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const [file, contentType] = routes.get(pathname) ?? ["404.html", "text/html; charset=utf-8"];
  const status = routes.has(pathname) ? 200 : 404;
  const body = await readFile(join(root, ".build", file));
  if (status === 200 && request.headers.range !== undefined) {
    const match = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range);
    const start = match ? Number(match[1]) : NaN;
    const requestedEnd = match?.[2] ? Number(match[2]) : body.byteLength - 1;
    const end = Math.min(requestedEnd, body.byteLength - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start > end) {
      response.writeHead(416, { "Content-Range": `bytes */${body.byteLength}` }).end();
      return;
    }
    response.writeHead(206, { "Content-Type": contentType, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${body.byteLength}`, "Accept-Ranges": "bytes" });
    response.end(request.method === "HEAD" ? undefined : body.subarray(start, end + 1));
    return;
  }
  response.writeHead(status, { "Content-Type": contentType, "Content-Length": body.byteLength, "Accept-Ranges": "bytes" });
  response.end(request.method === "HEAD" ? undefined : body);
}

const server = createServer((request, response) => {
  void serve(request, response).catch(() => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Internal server error");
  });
});
server.once("error", (error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Recurs website preview failed: ${message}\n`);
  process.exitCode = 1;
});

server.listen(4174, "127.0.0.1", () => {
  process.stdout.write("Recurs website: http://127.0.0.1:4174\n");
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
