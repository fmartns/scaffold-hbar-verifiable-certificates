import { keccak256, toUtf8Bytes } from "ethers";
import { describe, expect, it } from "vitest";
import { manualSettlementIdentifiers } from "./manual-settlement";
import { BENEFICIARY, TOKEN } from "./test-fixtures";

describe("manualSettlementIdentifiers", () => {
  it("is deterministic: the same label (and inputs) always gives the same identifiers", () => {
    const a = manualSettlementIdentifiers({ label: "smoke-1", tokenId: TOKEN, beneficiary: BENEFICIARY, amount: 100n });
    const b = manualSettlementIdentifiers({ label: "smoke-1", tokenId: TOKEN, beneficiary: BENEFICIARY, amount: 100n });
    expect(a).toEqual(b);
    expect(a.eventKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("a different label is a different settlement", () => {
    const a = manualSettlementIdentifiers({ label: "smoke-1", tokenId: TOKEN, beneficiary: BENEFICIARY, amount: 100n });
    const b = manualSettlementIdentifiers({ label: "smoke-2", tokenId: TOKEN, beneficiary: BENEFICIARY, amount: 100n });
    expect(b.eventKey).not.toBe(a.eventKey);
    expect(b.settlementId).not.toBe(a.settlementId);
  });

  it("the same label with a different amount keeps eventKey/settlementId but changes contentHash (a conflict, not a new settlement)", () => {
    const a = manualSettlementIdentifiers({ label: "smoke-1", tokenId: TOKEN, beneficiary: BENEFICIARY, amount: 100n });
    const b = manualSettlementIdentifiers({ label: "smoke-1", tokenId: TOKEN, beneficiary: BENEFICIARY, amount: 200n });
    expect(b.eventKey).toBe(a.eventKey);
    expect(b.settlementId).toBe(a.settlementId);
    expect(b.contentHash).not.toBe(a.contentHash);
  });

  it("without a label, generates one and never collides across calls", () => {
    const a = manualSettlementIdentifiers({ tokenId: TOKEN, beneficiary: BENEFICIARY, amount: 1n });
    const b = manualSettlementIdentifiers({ tokenId: TOKEN, beneficiary: BENEFICIARY, amount: 1n });
    expect(a.label).toMatch(/^cli-\d+-[0-9a-z]+$/);
    expect(a.eventKey).not.toBe(b.eventKey);
  });
});

describe("manualSettlementIdentifiers golden vector", () => {
  it("derives eventKey, settlementId and contentHash from distinct, labelled strings (pins the formula)", () => {
    const ids = manualSettlementIdentifiers({
      label: "golden",
      tokenId: TOKEN,
      beneficiary: BENEFICIARY,
      amount: 100n,
    });
    expect(ids).toEqual({
      label: "golden",
      eventKey: keccak256(toUtf8Bytes("hvs-cli.event:golden")),
      settlementId: keccak256(toUtf8Bytes("hvs-cli.settlement:golden")),
      contentHash: keccak256(toUtf8Bytes(`hvs-cli.content:golden:${TOKEN}:${BENEFICIARY}:100`)),
    });
    // eventKey and settlementId must never be derived from the same tagged string as one another.
    expect(ids.eventKey).not.toBe(ids.settlementId);
  });
});
