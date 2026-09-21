import { Interface } from "ethers";
import { Status } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";
import {
  HTS_RESPONSE_CODES,
  HtsError,
  classifyHtsError,
  classifyHtsStatus,
  decodeHtsFailed,
  htsStatusName,
  interpretHtsResponseCode,
} from "./errors";
import { hederaError, timeout } from "./test-fixtures";

const CTX = { operation: "transfer" as const, tokenId: "0.0.5555", accountId: "0.0.9001", amount: "1000" };

describe("response codes", () => {
  it("match the Hedera SDK's own table, so a wrong number cannot hide a wrong mapping", () => {
    for (const [code, name] of Object.entries(HTS_RESPONSE_CODES)) {
      expect(
        (Status as unknown as { _fromCode(c: number): { toString(): string } })._fromCode(Number(code)).toString(),
      ).toBe(name);
    }
    expect(htsStatusName(22)).toBe("SUCCESS");
    expect(htsStatusName(999999)).toBeUndefined();
  });
});

describe("classifyHtsStatus: each HTS scenario has its own code, message and action", () => {
  it.each([
    ["TOKEN_NOT_ASSOCIATED_TO_ACCOUNT", "NOT_ASSOCIATED", true, /not associated/, /associate/i],
    ["INVALID_TOKEN_ID", "TOKEN_NOT_FOUND", false, /does not exist/, /HEDERA_HTS_TOKEN_ID/],
    ["TOKEN_WAS_DELETED", "TOKEN_INVALID", false, /deleted/, /new settlement token/],
    ["TOKEN_IS_PAUSED", "TOKEN_PAUSED", true, /paused/, /Unpause/],
    ["INSUFFICIENT_TOKEN_BALANCE", "INSUFFICIENT_BALANCE", true, /enough/, /Fund/],
    ["SPENDER_DOES_NOT_HAVE_ALLOWANCE", "INSUFFICIENT_ALLOWANCE", true, /allowance/, /Approve/],
    ["AMOUNT_EXCEEDS_ALLOWANCE", "INSUFFICIENT_ALLOWANCE", true, /allowance/, /Approve/],
    ["TOKEN_HAS_NO_SUPPLY_KEY", "NO_MINT_PERMISSION", false, /supply key/, /supply key/],
    ["INVALID_SUPPLY_KEY", "NO_MINT_PERMISSION", false, /supply key/, /pool-transfer/],
    ["TOKEN_MAX_SUPPLY_REACHED", "SUPPLY_EXCEEDED", false, /maximum supply/, /Reduce/],
    ["ACCOUNT_FROZEN_FOR_TOKEN", "ACCOUNT_FROZEN", true, /frozen/, /freeze key/],
    ["ACCOUNT_KYC_NOT_GRANTED_FOR_TOKEN", "KYC_NOT_GRANTED", true, /KYC/, /KYC key/],
    ["INVALID_ACCOUNT_ID", "ACCOUNT_NOT_FOUND", false, /does not exist/, /beneficiary/i],
    ["ACCOUNT_DELETED", "ACCOUNT_NOT_FOUND", false, /deleted/, /beneficiary/i],
    ["INVALID_TOKEN_MINT_AMOUNT", "AMOUNT_OUT_OF_RANGE", false, /not valid/, /int64/],
    ["BUSY", "NETWORK_UNAVAILABLE", true, /right now/, /Retry/],
    ["SOMETHING_NEW", "TRANSACTION_FAILED", false, /SOMETHING_NEW/, /Hedera response code/],
  ])("%s -> %s", (status, code, retryable, message, remediation) => {
    const failure = classifyHtsStatus(status, CTX);
    expect(failure).toMatchObject({
      code,
      retryable,
      hederaStatus: status,
      outcome: "rejected",
      operation: "transfer",
    });
    expect(failure.message).toMatch(message);
    expect(failure.remediation).toMatch(remediation);
  });

  it("names the account and the token in the message", () => {
    const failure = classifyHtsStatus("TOKEN_NOT_ASSOCIATED_TO_ACCOUNT", CTX);
    expect(failure.message).toContain("0.0.9001");
    expect(failure.message).toContain("0.0.5555");
    expect(failure).toMatchObject({ tokenId: "0.0.5555", accountId: "0.0.9001" });
  });

  it("depends on the operation for a signature failure: mint means no mint permission", () => {
    expect(classifyHtsStatus("INVALID_SIGNATURE", { operation: "mint", tokenId: "0.0.5555" })).toMatchObject({
      code: "NO_MINT_PERMISSION",
    });
    expect(classifyHtsStatus("INVALID_SIGNATURE", { operation: "transfer" })).toMatchObject({
      code: "TRANSACTION_FAILED",
    });
    expect(classifyHtsStatus("INVALID_SIGNATURE", { operation: "associate" }).remediation).toMatch(/own key/);
  });
});

describe("interpretHtsResponseCode (numeric codes, e.g. from the router's HtsFailed)", () => {
  it.each([
    [184, "NOT_ASSOCIATED"],
    [167, "TOKEN_NOT_FOUND"],
    [178, "INSUFFICIENT_BALANCE"],
    [180, "NO_MINT_PERMISSION"],
    [189, "NO_MINT_PERMISSION"],
    [236, "SUPPLY_EXCEEDED"],
    [293, "INSUFFICIENT_ALLOWANCE"],
    [265, "TOKEN_PAUSED"],
  ])("%i -> %s, keeping the numeric code", (numeric, code) => {
    expect(interpretHtsResponseCode(numeric, CTX)).toMatchObject({ code, hederaCode: numeric });
  });

  it("does not turn an unknown code or SUCCESS into a guess", () => {
    expect(interpretHtsResponseCode(99999, CTX)).toMatchObject({ code: "TRANSACTION_FAILED", hederaCode: 99999 });
    expect(interpretHtsResponseCode(22, CTX)).toMatchObject({ code: "UNEXPECTED_RESPONSE", outcome: "not_sent" });
  });
});

describe("decodeHtsFailed (revert data of SettlementRouter.settle, ADR §6.5)", () => {
  const iface = new Interface(["error HtsFailed(uint8 op, int64 responseCode)"]);
  const revert = (op: number, code: number) => iface.encodeErrorResult("HtsFailed", [op, code]);

  it("decodes the operation and the response code into a normalized failure", () => {
    expect(decodeHtsFailed(revert(2, 184), { tokenId: "0.0.5555", accountId: "0.0.9001" })).toMatchObject({
      code: "NOT_ASSOCIATED",
      operation: "transfer",
      hederaCode: 184,
      outcome: "rejected",
    });
    expect(decodeHtsFailed(revert(1, 180))).toMatchObject({ code: "NO_MINT_PERMISSION", operation: "mint" });
  });

  it("returns null for any other revert", () => {
    expect(decodeHtsFailed("0x")).toBeNull();
    expect(
      decodeHtsFailed(
        new Interface(["error AlreadySettled(bytes32 eventKey, uint64 settledAt)"]).encodeErrorResult(
          "AlreadySettled",
          ["0x" + "11".repeat(32), 5],
        ),
      ),
    ).toBeNull();
    expect(decodeHtsFailed("not hex")).toBeNull();
  });
});

describe("classifyHtsError (whatever the SDK or the executor threw)", () => {
  it("classifies precheck and receipt status errors from the SDK by name and status", () => {
    expect(classifyHtsError(hederaError("PrecheckStatusError", "TOKEN_NOT_ASSOCIATED_TO_ACCOUNT"), CTX)).toMatchObject({
      code: "NOT_ASSOCIATED",
    });
    expect(classifyHtsError(hederaError("ReceiptStatusError", "INSUFFICIENT_TOKEN_BALANCE"), CTX)).toMatchObject({
      code: "INSUFFICIENT_BALANCE",
      outcome: "rejected",
    });
  });

  it("treats a timeout as an unknown outcome that keeps the transaction id", () => {
    for (const error of [timeout(), hederaError("MaxAttemptsOrTimeoutError", undefined, "max attempts reached")]) {
      expect(classifyHtsError(error, { ...CTX, transactionId: "0.0.1@1.1", timeoutMs: 500 })).toMatchObject({
        code: "TIMEOUT",
        outcome: "unknown",
        retryable: true,
        transactionId: "0.0.1@1.1",
      });
    }
  });

  it("marks a network failure as not sent before a transaction id exists, and unknown after", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(classifyHtsError(refused, CTX)).toMatchObject({ code: "NETWORK_UNAVAILABLE", outcome: "not_sent" });
    expect(classifyHtsError(refused, { ...CTX, transactionId: "0.0.1@1.1" })).toMatchObject({
      code: "NETWORK_UNAVAILABLE",
      outcome: "unknown",
    });
  });

  it("treats a busy network that answers after consensus as unknown, not as a refusal", () => {
    expect(classifyHtsError(hederaError("ReceiptStatusError", "BUSY"), CTX)).toMatchObject({
      code: "NETWORK_UNAVAILABLE",
      outcome: "unknown",
    });
    expect(classifyHtsError(hederaError("PrecheckStatusError", "BUSY"), CTX)).toMatchObject({
      code: "NETWORK_UNAVAILABLE",
      outcome: "rejected",
    });
  });

  it("passes a normalized error through and adds the context", () => {
    const original = new HtsError({
      code: "ASSOCIATION_NOT_AUTHORIZED",
      outcome: "not_sent",
      operation: "associate",
      message: "m",
      remediation: "r",
      retryable: false,
    });
    expect(classifyHtsError(original, { ...CTX, idempotencyKey: "0xaa" })).toMatchObject({
      code: "ASSOCIATION_NOT_AUTHORIZED",
      idempotencyKey: "0xaa",
    });
  });

  it("never leaks the text of an error", () => {
    const failure = classifyHtsError(new Error("operator key 302e020100300506032b657004220420deadbeef"), CTX);
    expect(failure.code).toBe("UNEXPECTED_RESPONSE");
    expect(JSON.stringify(failure)).not.toMatch(/deadbeef|302e0201/);
    expect(
      JSON.stringify(
        classifyHtsError(hederaError("PrecheckStatusError", "INVALID_TOKEN_ID", "key 302e0201 exploded"), CTX),
      ),
    ).not.toContain("302e0201");
  });

  it("gives HtsError a stable code and outcome", () => {
    const error = new HtsError({
      code: "TIMEOUT",
      outcome: "unknown",
      operation: "mint",
      message: "m",
      remediation: "r",
      retryable: true,
    });
    expect([error.code, error.outcome, error.name]).toEqual(["TIMEOUT", "unknown", "HtsError"]);
  });
});
