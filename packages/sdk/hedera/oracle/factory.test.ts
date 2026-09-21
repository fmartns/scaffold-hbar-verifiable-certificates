import { describe, expect, it } from "vitest";
import { ORACLE_PROVIDERS, createOracleAdapterFromEnv } from "./factory";
import { ORACLE_ENV } from "./config";
import { OracleError } from "./errors";
import { eventSourceOf } from "./identity";

describe("createOracleAdapterFromEnv", () => {
  it("defaults to the mock provider (selection by configuration, not a scattered conditional)", () => {
    const adapter = createOracleAdapterFromEnv({});
    expect(adapter.eventSource).toBe(eventSourceOf("mock-oracle"));
  });

  it("selects the mock explicitly via ORACLE_PROVIDER", () => {
    const adapter = createOracleAdapterFromEnv({ [ORACLE_ENV.PROVIDER]: "mock" });
    expect(adapter.eventSource).toBe(eventSourceOf("mock-oracle"));
  });

  it("throws a clear CONFIG_INVALID, pointing to #23, for an unregistered provider", () => {
    let error: OracleError | null = null;
    try {
      createOracleAdapterFromEnv({ [ORACLE_ENV.PROVIDER]: "some-real-vendor" });
    } catch (e) {
      error = e as OracleError;
    }
    expect(error).toBeInstanceOf(OracleError);
    expect(error?.code).toBe("CONFIG_INVALID");
    expect(error?.failure.message).toContain("some-real-vendor");
    expect(error?.failure.remediation).toContain("#23");
  });

  it("accepts a custom registry, e.g. a deployment wiring #23's real provider without editing this file", () => {
    const fakeReal = {
      eventSource: eventSourceOf("real-vendor"),
      observe: async () => ({
        ok: false as const,
        failure: { code: "NO_DATA" as const, message: "m", remediation: "r", retryable: true },
      }),
    };
    const adapter = createOracleAdapterFromEnv(
      { [ORACLE_ENV.PROVIDER]: "real-vendor" },
      { registry: { "real-vendor": () => fakeReal } },
    );
    expect(adapter).toBe(fakeReal);
  });

  it("passes the loaded config's timeout/freshness values through to the mock adapter", () => {
    const built = ORACLE_PROVIDERS.mock({ provider: "mock", timeoutMs: 1234, maxAgeSeconds: 42, validitySeconds: 99 });
    expect(built.eventSource).toBe(eventSourceOf("mock-oracle"));
  });

  it("propagates a configuration error (e.g. a bad timeout) before selecting any provider", () => {
    expect(() => createOracleAdapterFromEnv({ [ORACLE_ENV.TIMEOUT_MS]: "-1" })).toThrow(OracleError);
  });
});
