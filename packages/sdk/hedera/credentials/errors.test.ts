import { describe, expect, it } from "vitest";
import { AbiCoder, encodeBytes32String } from "ethers";
import { IssuerFlowError, IssuerTimeoutError, classifyIssuerError, fromHcsPublishFailure } from "./errors";
import type { IssuerErrorCategory } from "./errors";
import { decodeRegistryError } from "./registry-calls";
import { revertData, revertError } from "./issuer-test-fixtures";

const ID = `0x${"11".repeat(32)}`;
const ISSUER = `0x${"44".repeat(32)}`;
const A = `0x${"aa".repeat(20)}`;
const B = `0x${"bb".repeat(20)}`;

describe("registry custom errors", () => {
  it("decodes every error the issuer can hit, and revert strings", () => {
    expect(decodeRegistryError(revertData("UnknownIssuer", [ISSUER]))).toEqual({
      name: "UnknownIssuer",
      args: { issuer: ISSUER },
    });
    const reason = `0x08c379a0${AbiCoder.defaultAbiCoder().encode(["string"], ["nope"]).slice(2)}`;
    expect(decodeRegistryError(reason)).toEqual({ name: "Error", args: { reason: "nope" } });
    expect(decodeRegistryError("0xdeadbeef")).toBeNull();
    expect(decodeRegistryError("garbage")).toBeNull();
  });

  it.each<[string, unknown[], IssuerErrorCategory, RegExp]>([
    ["UnknownIssuer", [ISSUER], "issuer_not_registered", /not registered/],
    ["InactiveIssuer", [ISSUER], "issuer_not_registered", /deactivated/],
    ["UnauthorizedSigner", [A, B], "issuer_not_registered", /not the registered signer/],
    ["UnauthorizedRevoker", [ID, A], "issuer_not_registered", /not the current signer/],
    ["AlreadyIssued", [ID, 1790000000n], "contract_rejected", /already issued on 2026/],
    ["ConflictingCredential", [ID, ID, ISSUER], "contract_rejected", /different content/],
    ["Expired", [1n, 2n], "contract_rejected", /expired/],
    ["SignedInFuture", [2n, 1n], "contract_rejected", /future/],
    ["ValidityWindowTooLong", [9000n, 900n], "contract_rejected", /9000 s/],
    ["Paused", [], "contract_rejected", /paused/],
    ["SubmitterMismatch", [A, B], "contract_rejected", /pinned/],
    ["InvalidField", [encodeBytes32String("schemaId")], "contract_rejected", /schemaId/],
    ["UnknownCredential", [ID], "contract_rejected", /No credential/],
    ["AlreadyRevoked", [ID, 1790000000n], "contract_rejected", /already revoked/],
    ["InvalidSignature", [], "contract_rejected", /signature/],
  ])("%s has a specific category and message", (name, args, category, message) => {
    const error = classifyIssuerError(revertError(name, args));
    expect(error.category).toBe(category);
    expect(error.code).toBe(name);
    expect(error.message).toMatch(message);
    expect(error.remediation.length).toBeGreaterThan(10);
  });

  it("finds revert data wherever providers nest it", () => {
    const data = revertData("UnknownIssuer", [ISSUER]);
    for (const shape of [{ data }, { error: { data } }, { info: { error: { data: { data } } } }, { cause: { data } }]) {
      expect(classifyIssuerError(shape).code).toBe("UnknownIssuer");
    }
    expect(classifyIssuerError(new Error(`execution reverted: ${data}`)).code).toBe("UnknownIssuer");
  });
});

describe("classifyIssuerError: one specific message per failure scenario", () => {
  const cases: [string, unknown, IssuerErrorCategory, string][] = [
    [
      "wallet rejection (EIP-1193 4001)",
      { code: 4001, message: "User rejected the request." },
      "rejected",
      "WALLET_REJECTED",
    ],
    ["wallet rejection (ethers)", { code: "ACTION_REJECTED" }, "rejected", "WALLET_REJECTED"],
    ["pending wallet request", { code: -32002 }, "rejected", "WALLET_REQUEST_PENDING"],
    ["wallet unauthorized (4100)", { code: 4100 }, "wallet_disconnected", "WALLET_DISCONNECTED"],
    ["wallet disconnected (4900)", { code: 4900 }, "wallet_disconnected", "WALLET_DISCONNECTED"],
    [
      "Hedera status from the relay",
      new Error("transaction failed: INSUFFICIENT_PAYER_BALANCE"),
      "hedera",
      "INSUFFICIENT_PAYER_BALANCE",
    ],
    [
      "insufficient funds",
      { code: -32000, message: "insufficient funds for gas * price + value" },
      "hedera",
      "INSUFFICIENT_PAYER_BALANCE",
    ],
    ["wrong nonce", new Error("WRONG_NONCE"), "hedera", "WRONG_NONCE"],
    ["flow timeout", new IssuerTimeoutError("Waiting", 1000, `0x${"ab".repeat(32)}`), "timeout", "TIMEOUT"],
    ["abort timeout", Object.assign(new Error("signal timed out"), { name: "TimeoutError" }), "timeout", "TIMEOUT"],
    ["fetch failure", new TypeError("Failed to fetch"), "rpc_unavailable", "RPC_UNAVAILABLE"],
    ["relay rate limit", { code: -32005, message: "limit exceeded" }, "rpc_unavailable", "RPC_UNAVAILABLE"],
    [
      "internal JSON-RPC error",
      { code: -32603, message: "Internal JSON-RPC error." },
      "rpc_unavailable",
      "RPC_UNAVAILABLE",
    ],
    ["anything else", { weird: true }, "unknown", "UNKNOWN"],
  ];
  it.each(cases)("%s", (_label, error, category, code) => {
    const classified = classifyIssuerError(error);
    expect(classified.category).toBe(category);
    expect(classified.code).toBe(code);
  });

  it("keeps the transaction hash of a timed-out transaction for reconciliation", () => {
    const hash = `0x${"ab".repeat(32)}`;
    expect(classifyIssuerError(new IssuerTimeoutError("Waiting", 1000, hash)).transactionHash).toBe(hash);
  });

  it("passes an already classified error through unchanged", () => {
    const original = classifyIssuerError({ code: 4001 });
    expect(classifyIssuerError(new IssuerFlowError(original))).toBe(original);
  });

  it("never echoes raw provider text (which may carry URLs or input)", () => {
    const classified = classifyIssuerError(new TypeError("Failed to fetch https://relay.example/api?key=SECRET"));
    expect(JSON.stringify(classified)).not.toContain("SECRET");
  });
});

describe("HCS publish failures", () => {
  const base = { outcome: "unknown" as const, message: "m", remediation: "r", retryable: true };
  it.each<[string, IssuerErrorCategory]>([
    ["TIMEOUT", "timeout"],
    ["NETWORK_UNAVAILABLE", "rpc_unavailable"],
    ["CONFIG_INVALID", "not_configured"],
    ["INVALID_EVENT", "invalid_input"],
    ["TRANSACTION_FAILED", "hedera"],
    ["TOPIC_NOT_WRITABLE", "hedera"],
  ])("%s → %s", (code, category) => {
    expect(fromHcsPublishFailure({ ...base, code: code as never }).category).toBe(category);
  });

  it("names the Hedera status and keeps the transaction id", () => {
    const error = fromHcsPublishFailure({
      ...base,
      code: "TRANSACTION_FAILED",
      hederaStatus: "INSUFFICIENT_PAYER_BALANCE",
      transactionId: "0.0.1@1.2",
    });
    expect(error.message).toContain("INSUFFICIENT_PAYER_BALANCE");
    expect(error.transactionId).toBe("0.0.1@1.2");
  });
});
