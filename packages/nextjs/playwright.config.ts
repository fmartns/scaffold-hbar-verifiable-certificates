import { defineConfig, devices } from "@playwright/test";

/**
 * Browser-level smoke and lifecycle coverage for the developer console (issue #15). Scope is deliberately narrow:
 * routes render and the public verifier's read path works end to end against a mocked `CredentialRegistry` /
 * Mirror Node response — no real Hedera network, no credentials, same spirit as the Vitest suite
 * (`createVerifierBackend`'s HTTP boundary is intercepted, never the SDK). CI wiring is a separate decision,
 * documented in `docs/scaffold-compat.md`.
 */
const PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `next dev --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
