import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { rolldown } from "rolldown";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "packages/cli/src/main.ts");
const outputDirectory = path.join(root, "dist/cli");
const outputFile = path.join(outputDirectory, "main.js");
const temporaryFile = path.join(
  outputDirectory,
  `.main.js.${process.pid}.${randomUUID()}.tmp`,
);
const externalPackages = new Set([
  "@agentclientprotocol/codex-acp",
  "@agentclientprotocol/sdk",
  "@lydell/node-pty",
  "@openai/codex",
  "yaml",
  "zod",
]);

function isExternalPackage(specifier) {
  if (specifier.startsWith("node:")) {
    return true;
  }
  for (const packageName of externalPackages) {
    if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
      return true;
    }
  }
  return false;
}

await mkdir(outputDirectory, { recursive: true });

let bundle;
try {
  bundle = await rolldown({
    input: entry,
    platform: "node",
    external: isExternalPackage,
    plugins: [{
      name: "recurs-workspace-source",
      resolveId(specifier) {
        const match = /^@recurs\/([a-z0-9-]+)$/u.exec(specifier);
        return match === null
          ? null
          : path.join(root, "packages", match[1], "src/index.ts");
      },
    }],
  });
  const generated = await bundle.generate({
    codeSplitting: false,
    comments: {
      annotation: true,
      jsdoc: false,
      legal: true,
    },
    format: "esm",
    minify: false,
    sourcemap: false,
  });
  if (
    generated.output.length !== 1 ||
    generated.output[0]?.type !== "chunk"
  ) {
    throw new Error("CLI packaging must produce exactly one JavaScript chunk.");
  }
  const chunk = generated.output[0];
  for (const specifier of [...chunk.imports, ...chunk.dynamicImports]) {
    if (specifier === chunk.fileName || specifier.startsWith(".")) {
      continue;
    }
    if (!isExternalPackage(specifier)) {
      throw new Error(`CLI packaging found an unreviewed external import: ${specifier}`);
    }
  }
  await bundle.close();
  bundle = undefined;

  const handle = await open(temporaryFile, "wx", 0o700);
  try {
    const code = chunk.code.replaceAll(
      /^\/\/#(?:end)?region(?: .*?)?\n/gmu,
      "",
    );
    await handle.writeFile(code, "utf8");
    await handle.chmod(0o755);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryFile, outputFile);
} catch (error) {
  await unlink(temporaryFile).catch(() => {});
  throw error;
} finally {
  await bundle?.close();
}
