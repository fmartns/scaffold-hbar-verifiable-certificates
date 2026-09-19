import { describe, expect, it } from "vitest";
import { HcsPublishError, HcsTimeoutError, classifyPublishError, isHcsPublishError } from "./errors";
import { hederaError } from "./test-fixtures";

const CTX = { topicId: "0.0.4567", timeoutMs: 500 };

describe("classifyPublishError", () => {
  it.each([
    ["INVALID_TOPIC_ID", "PrecheckStatusError", "TOPIC_INVALID", "rejected"],
    ["TOPIC_EXPIRED", "ReceiptStatusError", "TOPIC_INVALID", "rejected"],
    ["INVALID_SIGNATURE", "PrecheckStatusError", "TRANSACTION_FAILED", "rejected"],
    ["INSUFFICIENT_PAYER_BALANCE", "PrecheckStatusError", "TRANSACTION_FAILED", "rejected"],
    ["MESSAGE_SIZE_TOO_LARGE", "ReceiptStatusError", "TRANSACTION_FAILED", "rejected"],
    ["BUSY", "PrecheckStatusError", "NETWORK_UNAVAILABLE", "rejected"],
    ["PLATFORM_NOT_ACTIVE", "PrecheckStatusError", "NETWORK_UNAVAILABLE", "rejected"],
  ] as const)("maps %s from %s to %s (%s)", (status, name, code, outcome) => {
    const failure = classifyPublishError(hederaError(name, status), CTX);
    expect(failure).toMatchObject({ code, outcome, hederaStatus: status, topicId: "0.0.4567" });
  });

  it("marks a busy network as retryable and a rejected transaction as not retryable", () => {
    expect(classifyPublishError(hederaError("PrecheckStatusError", "BUSY"), CTX).retryable).toBe(true);
    expect(classifyPublishError(hederaError("ReceiptStatusError", "INVALID_SIGNATURE"), CTX).retryable).toBe(false);
  });

  it("explains that a signature failure means the operator is not the submit key", () => {
    expect(classifyPublishError(hederaError("ReceiptStatusError", "INVALID_SIGNATURE"), CTX).remediation).toMatch(
      /submitKey/,
    );
  });

  it("treats the SDK's max-attempts/timeout error and the local deadline as an unknown outcome", () => {
    for (const error of [
      hederaError("MaxAttemptsOrTimeoutError", undefined, "max attempts of 10 was reached"),
      new HcsTimeoutError(500),
    ]) {
      const failure = classifyPublishError(error, { ...CTX, transactionId: "0.0.1@1.1" });
      expect(failure).toMatchObject({
        code: "TIMEOUT",
        outcome: "unknown",
        retryable: true,
        transactionId: "0.0.1@1.1",
      });
      expect(failure.remediation).toMatch(/transactionId/);
    }
  });

  it("detects a network failure before any transaction id as not sent, and after one as unknown", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:50211"), { code: "ECONNREFUSED" });
    expect(classifyPublishError(refused, CTX)).toMatchObject({
      code: "NETWORK_UNAVAILABLE",
      outcome: "not_sent",
      retryable: true,
    });
    expect(classifyPublishError(refused, { ...CTX, transactionId: "0.0.1@1.1" })).toMatchObject({
      code: "NETWORK_UNAVAILABLE",
      outcome: "unknown",
    });
    expect(classifyPublishError(hederaError("GrpcServiceError", undefined, "14 UNAVAILABLE"), CTX).code).toBe(
      "NETWORK_UNAVAILABLE",
    );
  });

  it("never leaks the text of an unrecognized error", () => {
    const failure = classifyPublishError(new Error("secret-key-302e020100300506032b657004220420deadbeef"), CTX);
    expect(failure.code).toBe("UNEXPECTED_RESPONSE");
    expect(JSON.stringify(failure)).not.toMatch(/deadbeef|secret-key/);
  });

  it("does not leak the message of recognized errors either", () => {
    const failure = classifyPublishError(
      hederaError("PrecheckStatusError", "INVALID_TOPIC_ID", "key 302e0201 exploded"),
      CTX,
    );
    expect(JSON.stringify(failure)).not.toContain("302e0201");
  });

  it("passes a normalized error through and only adds missing context", () => {
    const original = new HcsPublishError({
      code: "CONFIG_INVALID",
      outcome: "not_sent",
      message: "m",
      remediation: "r",
      retryable: false,
    });
    expect(classifyPublishError(original, CTX)).toMatchObject({ code: "CONFIG_INVALID", topicId: "0.0.4567" });
  });

  it("gives HcsPublishError a stable code and outcome", () => {
    const error = new HcsPublishError({
      code: "TIMEOUT",
      outcome: "unknown",
      message: "m",
      remediation: "r",
      retryable: true,
    });
    expect(isHcsPublishError(error)).toBe(true);
    expect(isHcsPublishError(new Error("x"))).toBe(false);
    expect([error.code, error.outcome, error.name]).toEqual(["TIMEOUT", "unknown", "HcsPublishError"]);
  });
});
