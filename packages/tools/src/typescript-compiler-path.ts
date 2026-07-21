import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let installedCompiler: string | undefined;
try {
  installedCompiler = require.resolve("typescript/lib/tsc.js");
} catch {
  installedCompiler = undefined;
}

export function resolveTypeScriptCompilerPath(): string | undefined {
  return installedCompiler;
}
