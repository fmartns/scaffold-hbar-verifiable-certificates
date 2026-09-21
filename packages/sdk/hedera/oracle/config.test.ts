import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_AGE_SECONDS,
  DEFAULT_PROVIDER,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VALIDITY_SECONDS,
  ORACLE_ENV,
  loadOracleAdapterConfig,
} from "./config";
import { OracleError } from "./errors";

describe("loadOracleAdapterConfig", () => {
  it("defaults to the mock provider and documented timeouts/windows", () => {
    expect(loadOracleAdapterConfig({})).toEqual({
      provider: DEFAULT_PROVIDER,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
      validitySeconds: DEFAULT_VALIDITY_SECONDS,
      baseUrl: undefined,
      apiKey: undefined,
    });
  });

  it("reads every variable from the environment, nothing hardcoded", () => {
    const config = loadOracleAdapterConfig({
      [ORACLE_ENV.PROVIDER]: "some-real-provider",
      [ORACLE_ENV.TIMEOUT_MS]: "5000",
      [ORACLE_ENV.MAX_AGE_SECONDS]: "120",
      [ORACLE_ENV.VALIDITY_SECONDS]: "600",
      [ORACLE_ENV.BASE_URL]: "https://example.test",
      [ORACLE_ENV.API_KEY]: "secret-key",
    });
    expect(config).toEqual({
      provider: "some-real-provider",
      timeoutMs: 5000,
      maxAgeSeconds: 120,
      validitySeconds: 600,
      baseUrl: "https://example.test",
      apiKey: "secret-key",
    });
  });

  it.each([ORACLE_ENV.TIMEOUT_MS, ORACLE_ENV.MAX_AGE_SECONDS, ORACLE_ENV.VALIDITY_SECONDS])(
    "rejects a non-positive or non-integer %s",
    variable => {
      for (const bad of ["0", "-1", "1.5", "abc", ""]) {
        if (bad === "") continue; // empty means "use the default", tested separately
        const error = (() => {
          try {
            loadOracleAdapterConfig({ [variable]: bad });
            return null;
          } catch (e) {
            return e as OracleError;
          }
        })();
        expect(error, `${variable}=${bad}`).toBeInstanceOf(OracleError);
        expect(error?.code).toBe("CONFIG_INVALID");
        expect(error?.failure.message).toContain(variable);
      }
    },
  );

  it("never echoes the API key in an error message", () => {
    let error: OracleError | null = null;
    try {
      loadOracleAdapterConfig({ [ORACLE_ENV.API_KEY]: "top-secret-abc", [ORACLE_ENV.TIMEOUT_MS]: "-1" });
    } catch (e) {
      error = e as OracleError;
    }
    expect(JSON.stringify(error?.failure)).not.toContain("top-secret-abc");
  });
});
