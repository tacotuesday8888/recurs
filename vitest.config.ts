import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@recurs/providers": fileURLToPath(
        new URL("./packages/providers/src/index.ts", import.meta.url),
      ),
      "@recurs/tools": fileURLToPath(
        new URL("./packages/tools/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "tests/e2e/**/*.test.ts"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
