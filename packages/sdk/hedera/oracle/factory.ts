/**
 * Selects an `OracleAdapter` by configuration (`ORACLE_PROVIDER`), not by a conditional scattered through consumer code.
 *
 * Only `"mock"` is registered today. A real provider is issue #23's responsibility: it registers itself here (or in an
 * equivalent registry) under a new name, implementing only `OracleProvider` (see `../../../docs/oracle-adapter.md`).
 * Requesting any other name is a clear, actionable `CONFIG_INVALID` — never a silent fallback to the mock.
 */
import { createMockOracleAdapter } from "./mock";
import { OracleError } from "./errors";
import { loadOracleAdapterConfig } from "./config";
import type { OracleAdapterConfig } from "./config";
import type { OracleAdapter } from "./types";

export type OracleProviderFactory = (config: OracleAdapterConfig) => OracleAdapter;

/** Providers available by name. #23 adds its real provider here (or supplies its own registry to `createOracleAdapterFromEnv`). */
export const ORACLE_PROVIDERS: Readonly<Record<string, OracleProviderFactory>> = {
  mock: config =>
    createMockOracleAdapter({
      timeoutMs: config.timeoutMs,
      maxAgeSeconds: config.maxAgeSeconds,
      defaultValiditySeconds: config.validitySeconds,
    }),
};

export interface CreateOracleAdapterFromEnvOptions {
  /** Overrides the registry (tests, or a deployment that wires #23's provider without editing this file). */
  registry?: Readonly<Record<string, OracleProviderFactory>>;
}

/** Builds the configured `OracleAdapter`. Throws `OracleError` `CONFIG_INVALID` for an unknown or misconfigured provider. */
export function createOracleAdapterFromEnv(
  env: Record<string, string | undefined>,
  options: CreateOracleAdapterFromEnvOptions = {},
): OracleAdapter {
  const config = loadOracleAdapterConfig(env);
  const registry = options.registry ?? ORACLE_PROVIDERS;
  const factory = registry[config.provider];
  if (!factory) {
    throw new OracleError({
      code: "CONFIG_INVALID",
      message: `ORACLE_PROVIDER "${config.provider}" is not registered.`,
      remediation:
        config.provider === "mock"
          ? "This should not happen; the mock is always registered."
          : `Available: ${Object.keys(registry).join(", ") || "(none)"}. A real provider is selected and implemented in issue #23.`,
      retryable: false,
    });
  }
  return factory(config);
}
