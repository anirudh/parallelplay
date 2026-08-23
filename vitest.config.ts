import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 60_000,
    coverage: {
      provider: "v8"
    },
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    testTimeout: 15_000
  }
});
