import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["hedera/**/*.ts", "cli/**/*.ts", "index.ts"],
      exclude: ["**/*.test.ts", "**/test-fixtures.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
