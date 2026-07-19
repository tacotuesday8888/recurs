import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@recurs/contracts": fileURLToPath(
        new URL("./packages/contracts/src/index.ts", import.meta.url),
      ),
      "@recurs/providers": fileURLToPath(
        new URL("./packages/providers/src/index.ts", import.meta.url),
      ),
      "@recurs/app": fileURLToPath(
        new URL("./packages/app/src/index.ts", import.meta.url),
      ),
      "@recurs/runtimes": fileURLToPath(
        new URL("./packages/runtimes/src/index.ts", import.meta.url),
      ),
      "@recurs/tools": fileURLToPath(
        new URL("./packages/tools/src/index.ts", import.meta.url),
      ),
      "@recurs/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
      "@recurs/cli": fileURLToPath(
        new URL("./packages/cli/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "tests/e2e/**/*.test.ts"],
    maxWorkers: 4,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
