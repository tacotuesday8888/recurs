import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "tests/e2e/**/*.test.ts"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
