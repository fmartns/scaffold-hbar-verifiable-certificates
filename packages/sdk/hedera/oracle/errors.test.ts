import { describe, expect, it } from "vitest";
import { OracleError, OracleTimeoutError, classifyOracleError, isOracleError } from "./errors";

describe("classifyOracleError", () => {
  it("passes an OracleError through unchanged, adding the query if it was not already set", () => {
    const original = new OracleError({ code: "NO_DATA", message: "m", remediation: "r", retryable: true });
    expect(classifyOracleError(original, { query: "order-1" })).toMatchObject({ code: "NO_DATA", query: "order-1" });
  });

  it("does not override a query the error already carries", () => {
    const original = new OracleError({
      code: "NO_DATA",
      message: "m",
      remediation: "r",
      retryable: true,
      query: "order-1",
    });
    expect(classifyOracleError(original, { query: "order-2" }).query).toBe("order-1");
  });

  it("classifies an OracleTimeoutError and a DOM AbortError as TIMEOUT", () => {
    expect(classifyOracleError(new OracleTimeoutError(500), { timeoutMs: 500 })).toMatchObject({
      code: "TIMEOUT",
      retryable: true,
    });
    const abortError = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    expect(classifyOracleError(abortError)).toMatchObject({ code: "TIMEOUT" });
  });

  it("classifies a network-shaped error as PROVIDER_UNAVAILABLE, retryable", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" });
    expect(classifyOracleError(refused)).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
  });

  it("classifies anything else as UNEXPECTED_RESPONSE, not retryable, without leaking the message", () => {
    const failure = classifyOracleError(new Error("api key sk-secret-abc123 invalid"));
    expect(failure).toMatchObject({ code: "UNEXPECTED_RESPONSE", retryable: false });
    expect(JSON.stringify(failure)).not.toContain("sk-secret-abc123");
  });

  it("attaches the query to a freshly classified failure", () => {
    expect(classifyOracleError(new Error("boom"), { query: "order-9" }).query).toBe("order-9");
  });
});

describe("isOracleError / OracleError", () => {
  it("distinguishes an OracleError from a plain Error", () => {
    expect(isOracleError(new OracleError({ code: "NO_DATA", message: "m", remediation: "r", retryable: true }))).toBe(
      true,
    );
    expect(isOracleError(new Error("x"))).toBe(false);
  });

  it("exposes a stable .code getter", () => {
    const error = new OracleError({ code: "TIMEOUT", message: "m", remediation: "r", retryable: true });
    expect(error.code).toBe("TIMEOUT");
    expect(error.name).toBe("OracleError");
  });
});
