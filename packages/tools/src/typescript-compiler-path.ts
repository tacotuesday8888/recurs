import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let installedCompiler: string | undefined;
try {
  const candidate = realpathSync(require.resolve("typescript/lib/tsc.js"));
  installedCompiler = statSync(candidate).isFile() ? candidate : undefined;
} catch {
  installedCompiler = undefined;
}

export function resolveTypeScriptCompilerPath(): string | undefined {
  return installedCompiler;
}
