import assert from "node:assert/strict";
import { URL, fileURLToPath } from "node:url";
import test from "node:test";
import { measureCliCommand } from "./measure-cli-resources.mjs";

const entry = fileURLToPath(new URL("../dist/cli/main.js", import.meta.url));

for (const command of ["--version", "--help"]) {
  test(`bundled ${command} does not load the TypeScript compiler`, async () => {
    const metrics = await measureCliCommand(entry, [command]);
    assert.equal(metrics.compilerLoaded, false);
    assert.ok(metrics.peakRssBytes > 0);
    assert.ok(metrics.exitRssBytes > 0);
    assert.ok(metrics.wallMs > 0);
  });
}
