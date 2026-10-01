import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// Hermetic: a developer's shell (or CI) configuration must never reach a test. Tests stub what they need.
beforeEach(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith("HEDERA_")) vi.stubEnv(name, "");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
