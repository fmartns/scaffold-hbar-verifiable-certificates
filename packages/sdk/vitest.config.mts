import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Credo needs seconds to create credential definitions and revocation registries.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // One module graph for Credo and the Hiero SDK, so the in-memory Hedera of `testing/hedera.ts` replaces the
    // transport the real registry uses (otherwise Vitest may load two copies and a test could reach the network).
    server: { deps: { inline: [/@credo-ts\//, /@hiero-did-sdk\//] } },
    coverage: {
      provider: "v8",
      include: ["hedera/**/*.ts", "certificates/**/*.ts", "cli/**/*.ts", "index.ts"],
      exclude: ["**/*.test.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: { lines: 90, branches: 85, functions: 90, statements: 90 },
    },
  },
});
