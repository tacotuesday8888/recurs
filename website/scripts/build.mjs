/* global console, process */
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const repository = dirname(root);
const source = join(root, "src");
const output = join(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(join(output, "assets"), { recursive: true });
const compiler = spawn(process.execPath, [join(repository, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.json"), "--pretty", "false"], { stdio: "inherit" });
const compilerResult = await new Promise((resolve) => {
  compiler.once("error", () => resolve({ kind: "error" }));
  compiler.once("exit", (code) => resolve({ kind: "exit", code }));
});
if (compilerResult.kind === "error") {
  console.error("Website build failed: TypeScript compiler could not start.");
  process.exit(1);
}
if (compilerResult.code !== 0) process.exit(compilerResult.code ?? 1);

for (const file of ["index.html", "styles.css"]) {
  await cp(join(source, file), join(output, file));
}
await cp(join(repository, "docs/assets/recurs-mark.svg"), join(output, "assets/recurs-mark.svg"));

const html = await readFile(join(output, "index.html"), "utf8");
await writeFile(join(output, "404.html"), html);
await writeFile(join(output, ".nojekyll"), "");
console.log(`Built ${output}`);
