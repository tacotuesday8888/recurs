import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { rolldown } from "rolldown";

const [outputFile] = process.argv.slice(2);
if (
  process.argv.length !== 3 ||
  outputFile === undefined ||
  !path.isAbsolute(outputFile) ||
  path.basename(outputFile) !== "main.js"
) {
  throw new Error("Usage: build-native-engine-bundle.mjs /absolute/path/main.js");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "packages/native-engine/src/main.ts");
const sealedRuntimes = path.join(
  root,
  "packages/native-engine/src/sealed-runtimes.ts",
);
const outputDirectory = path.dirname(outputFile);
const temporaryFile = path.join(
  outputDirectory,
  `.main.js.${process.pid}.${randomUUID()}.tmp`,
);

await mkdir(outputDirectory, { recursive: true });

let bundle;
try {
  bundle = await rolldown({
    input: entry,
    platform: "node",
    external: (specifier) => specifier.startsWith("node:"),
    plugins: [{
      name: "recurs-workspace-source",
      resolveId(specifier) {
        if (specifier === "yaml") {
          return path.join(root, "node_modules/yaml/browser/index.js");
        }
        if (specifier === "@recurs/runtimes") {
          return sealedRuntimes;
        }
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
    throw new Error("Native engine bundling must produce exactly one JavaScript chunk.");
  }
  await bundle.close();
  bundle = undefined;

  const handle = await open(temporaryFile, "wx", 0o600);
  try {
    const code = generated.output[0].code.replaceAll(
      /^\/\/#(?:end)?region(?: .*?)?\n/gmu,
      "",
    );
    await handle.writeFile(code, "utf8");
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
