/**
 * Configuration of the oracle adapter, read from the environment. Selection between the mock and a real provider is by
 * configuration (`ORACLE_PROVIDER`), never a conditional scattered in consumer code — see `./factory`.
 */
import { OracleError } from "./errors";

export const ORACLE_ENV = {
  /** Which `OracleProvider` to use. `mock` (default) or a name a real provider registers in #23. */
  PROVIDER: "ORACLE_PROVIDER",
  /** Generic HTTP config for a real provider (#23 decides how to use them; not read by the mock). */
  BASE_URL: "ORACLE_BASE_URL",
  API_KEY: "ORACLE_API_KEY",
  /** Deadline of one `fetch` call. */
  TIMEOUT_MS: "ORACLE_TIMEOUT_MS",
  /** Adapter-side freshness precheck before signing (ADR §8 "#8"): reject an observation older than this. */
  MAX_AGE_SECONDS: "ORACLE_MAX_AGE_SECONDS",
  /** Attestation lifetime from `observedAt`, used as `NormalizeContext.validitySeconds` when the caller omits one. */
  VALIDITY_SECONDS: "ORACLE_VALIDITY_SECONDS",
} as const;

export const DEFAULT_PROVIDER = "mock";
export const DEFAULT_TIMEOUT_MS = 10_000;
/** ADR §6.2 `maxAge` starting point. */
export const DEFAULT_MAX_AGE_SECONDS = 300;
/** ADR §6.2 `maxValidity` starting point. */
export const DEFAULT_VALIDITY_SECONDS = 900;

export interface OracleAdapterConfig {
  provider: string;
  timeoutMs: number;
  maxAgeSeconds: number;
  validitySeconds: number;
  baseUrl?: string;
  apiKey?: string;
}

function positiveInt(raw: string | undefined, variable: string, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value <= 0) {
    throw new OracleError({
      code: "CONFIG_INVALID",
      message: `${variable} must be a positive integer.`,
      remediation: `Unset it to use the default (${fallback}), or fix the value.`,
      retryable: false,
    });
  }
  return value;
}

export function loadOracleAdapterConfig(env: Record<string, string | undefined>): OracleAdapterConfig {
  return {
    provider: env[ORACLE_ENV.PROVIDER]?.trim() || DEFAULT_PROVIDER,
    timeoutMs: positiveInt(env[ORACLE_ENV.TIMEOUT_MS], ORACLE_ENV.TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxAgeSeconds: positiveInt(env[ORACLE_ENV.MAX_AGE_SECONDS], ORACLE_ENV.MAX_AGE_SECONDS, DEFAULT_MAX_AGE_SECONDS),
    validitySeconds: positiveInt(
      env[ORACLE_ENV.VALIDITY_SECONDS],
      ORACLE_ENV.VALIDITY_SECONDS,
      DEFAULT_VALIDITY_SECONDS,
    ),
    baseUrl: env[ORACLE_ENV.BASE_URL]?.trim() || undefined,
    apiKey: env[ORACLE_ENV.API_KEY]?.trim() || undefined,
  };
}
