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
  ["/assets/recurs-mark.svg", ["assets/recurs-mark.svg", "image/svg+xml"]],
  ["/.nojekyll", [".nojekyll", "text/plain; charset=utf-8"]],
]);

async function serve(request, response) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }

  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const [file, contentType] = routes.get(pathname) ?? ["404.html", "text/html; charset=utf-8"];
  const status = routes.has(pathname) ? 200 : 404;
  const body = await readFile(join(root, "dist", file));
  response.writeHead(status, { "Content-Type": contentType, "Content-Length": body.byteLength });
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

server.listen(4173, "127.0.0.1", () => {
  process.stdout.write("Recurs website: http://127.0.0.1:4173\n");
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
