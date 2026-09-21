import { describe, expect, it } from "vitest";
import { buildEnvelope } from "../hcs/envelope";
import { TEST_ROUTER, makeEvent, signEvent } from "../hcs/test-fixtures";
import {
  INT64_MAX,
  expectedEffects,
  parseSettlementMemo,
  planOperations,
  settlementInputFromEnvelope,
  settlementMemo,
  validateSettlementInput,
} from "./settlement";
import { BENEFICIARY, CONTENT_HASH, EVENT_KEY, OPERATOR, SETTLEMENT_ID, TOKEN, makeInput } from "./test-fixtures";

describe("validateSettlementInput", () => {
  it("normalizes a valid input (amount from bigint, number or decimal string)", () => {
    for (const amount of [1000n, 1000, "1000"]) {
      const result = validateSettlementInput(makeInput({ amount }));
      expect(result).toMatchObject({ ok: true, value: { amount: 1000n, tokenId: TOKEN, beneficiary: BENEFICIARY } });
    }
  });

  it("lowercases the 32-byte identifiers", () => {
    const result = validateSettlementInput(makeInput({ eventKey: EVENT_KEY.toUpperCase().replace("0X", "0x") }));
    expect(result).toMatchObject({ ok: true, value: { eventKey: EVENT_KEY } });
  });

  it("accepts an EVM address as the beneficiary", () => {
    expect(validateSettlementInput(makeInput({ beneficiary: "0x000000000000000000000000000000000000dEaD" })).ok).toBe(
      true,
    );
  });

  it("accepts a zero amount (the ADR's valid no-op)", () => {
    expect(validateSettlementInput(makeInput({ amount: 0n }))).toMatchObject({ ok: true, value: { amount: 0n } });
  });

  it("reports every problem at once, by field", () => {
    const result = validateSettlementInput({ eventKey: "0x12", tokenId: "abc", beneficiary: "nope", amount: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map(i => i.field)).toEqual(
        expect.arrayContaining(["eventKey", "settlementId", "contentHash", "tokenId", "beneficiary", "amount"]),
      );
    }
  });

  it.each([
    ["a zero eventKey", { eventKey: `0x${"00".repeat(32)}` }, "eventKey"],
    ["the zero beneficiary", { beneficiary: "0x0000000000000000000000000000000000000000" }, "beneficiary"],
    ["a token id 0.0.0", { tokenId: "0.0.0" }, "tokenId"],
    ["an amount above int64", { amount: INT64_MAX + 1n }, "amount"],
    ["a fractional amount", { amount: "1.5" }, "amount"],
    ["an unsafe number", { amount: Number.MAX_SAFE_INTEGER + 1 }, "amount"],
  ])("rejects %s", (_, override, field) => {
    const result = validateSettlementInput(makeInput(override));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map(i => i.field)).toContain(field);
  });

  it("accepts exactly int64 max", () => {
    expect(validateSettlementInput(makeInput({ amount: INT64_MAX }))).toMatchObject({
      ok: true,
      value: { amount: INT64_MAX },
    });
  });

  it("rejects a non-object", () => {
    expect(validateSettlementInput(null).ok).toBe(false);
  });
});

describe("planOperations (the strategy of ADR §6.7)", () => {
  const s = { tokenId: TOKEN, treasury: OPERATOR, beneficiary: BENEFICIARY, amount: 500n };

  it("mint-transfer mints the amount and then transfers it from the treasury", () => {
    expect(planOperations("mint-transfer", s)).toEqual([
      { step: "mint", tokenId: TOKEN, amount: 500n },
      { step: "transfer", tokenId: TOKEN, amount: 500n, from: OPERATOR, to: BENEFICIARY },
    ]);
  });

  it("pool-transfer only transfers: it never mints", () => {
    expect(planOperations("pool-transfer", s).map(o => o.step)).toEqual(["transfer"]);
  });

  it("a zero amount has no operations in either model", () => {
    expect(planOperations("mint-transfer", { ...s, amount: 0n })).toEqual([]);
    expect(planOperations("pool-transfer", { ...s, amount: 0n })).toEqual([]);
  });
});

describe("expectedEffects (what the router and the audit must find)", () => {
  const s = { treasury: OPERATOR, beneficiary: BENEFICIARY, amount: 500n };

  it("mint-transfer grows the supply and credits only the beneficiary (the treasury nets zero)", () => {
    expect(expectedEffects("mint-transfer", s)).toEqual({
      supplyDelta: "500",
      balanceDeltas: { [BENEFICIARY]: "500" },
    });
  });

  it("pool-transfer leaves the supply alone and debits the pool", () => {
    expect(expectedEffects("pool-transfer", s)).toEqual({
      supplyDelta: "0",
      balanceDeltas: { [BENEFICIARY]: "500", [OPERATOR]: "-500" },
    });
  });

  it("a no-op changes nothing", () => {
    expect(expectedEffects("mint-transfer", { ...s, amount: 0n })).toEqual({ supplyDelta: "0", balanceDeltas: {} });
  });
});

describe("settlement memo", () => {
  it("round-trips and stays under Hedera's 100-byte limit", () => {
    for (const step of ["mint", "transfer"] as const) {
      const memo = settlementMemo(EVENT_KEY, step);
      expect(Buffer.byteLength(memo)).toBeLessThanOrEqual(100);
      expect(parseSettlementMemo(memo)).toEqual({ eventKey: EVENT_KEY, step });
    }
  });

  it("does not parse anything else", () => {
    for (const memo of [
      "",
      "hello",
      "hvs:1:associate",
      `hvs:2:${EVENT_KEY}:mint`,
      `hvs:1:${EVENT_KEY}:burn`,
      `hvs:1:0x12:mint`,
    ]) {
      expect(parseSettlementMemo(memo)).toBeNull();
    }
  });
});

describe("settlementInputFromEnvelope (coordination with #6 and the router)", () => {
  it("takes the identifiers from the same envelope the router settles", async () => {
    const event = makeEvent();
    const built = buildEnvelope(
      { event, signature: await signEvent(event) },
      { chainId: 296, verifyingContract: TEST_ROUTER },
    );
    if (!built.ok) throw new Error("fixture");
    const input = settlementInputFromEnvelope(built.value, { tokenId: TOKEN, beneficiary: BENEFICIARY, amount: 1000n });
    expect(input).toMatchObject({
      eventKey: built.value.derived.eventKey,
      settlementId: built.value.derived.settlementId,
      contentHash: built.value.derived.contentHash,
      tokenId: TOKEN,
    });
    expect(validateSettlementInput(input).ok).toBe(true);
    // The golden identifiers of the envelope tests: the adapter and the router cannot disagree about which settlement it is.
    expect(input.eventKey).toBe("0xa443f61dfefa9b88087f5580a4365b62f4ff0f44b0cbd672d3323946ed6a27b8");
  });

  it("uses distinct fixtures for the adapter tests", () => {
    expect(new Set([EVENT_KEY, SETTLEMENT_ID, CONTENT_HASH]).size).toBe(3);
  });
});
