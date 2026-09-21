import { AbiCoder } from "ethers";
import { describe, expect, it } from "vitest";
import { validateSettlementEvent } from "../hcs/envelope";
import { externalEventIdFromRef } from "./identity";
import { normalizeObservation } from "./normalize";
import { baseContext } from "./test-fixtures";

const coder = AbiCoder.defaultAbiCoder();
const raw = (overrides = {}) => ({
  providerRef: "order-42",
  observedAt: 1_767_225_000,
  data: 1_000_000n,
  ...overrides,
});

describe("normalizeObservation (pure, ADR §6.9/T-13)", () => {
  it("is deterministic: the same raw observation and context always give the same draft", () => {
    const a = normalizeObservation(raw(), baseContext());
    const b = normalizeObservation(raw(), baseContext());
    expect(a).toEqual(b);
  });

  it("derives externalEventId from providerRef and eventType only (R1-R6), never from observedAt", () => {
    const withoutType = normalizeObservation(raw(), baseContext());
    const withType = normalizeObservation(raw({ eventType: "delivery.confirmed" }), baseContext());
    const laterObservedAt = normalizeObservation(raw({ observedAt: 1_767_225_999 }), baseContext());
    expect(withoutType.ok && withoutType.value.externalEventId).toBe(externalEventIdFromRef("order-42"));
    expect(withType.ok && withType.value.externalEventId).toBe(
      externalEventIdFromRef("order-42", "delivery.confirmed"),
    );
    expect(withoutType.ok).toBe(true);
    expect(laterObservedAt.ok).toBe(true);
    if (withoutType.ok && laterObservedAt.ok) {
      expect(laterObservedAt.value.externalEventId).toBe(withoutType.value.externalEventId);
    }
  });

  it("a re-observation (later observedAt, same identity) keeps externalEventId but changes validUntil", () => {
    const first = normalizeObservation(raw(), baseContext());
    const second = normalizeObservation(raw({ observedAt: 1_767_225_100 }), baseContext());
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.externalEventId).toBe(first.value.externalEventId);
      expect(second.value.observedAt).not.toBe(first.value.observedAt);
      expect(second.value.validUntil).not.toBe(first.value.validUntil);
    }
  });

  it("computes validUntil = observedAt + validitySeconds", () => {
    const result = normalizeObservation(raw(), baseContext({ validitySeconds: 300 }));
    expect(result.ok && result.value.validUntil).toBe(1_767_225_000n + 300n);
  });

  it("passes the whole draft through the shared schema validator (one schema for the project)", () => {
    const result = normalizeObservation(raw(), baseContext());
    expect(result.ok).toBe(true);
    if (result.ok) expect(validateSettlementEvent(result.value).ok).toBe(true);
  });

  describe("data encoding", () => {
    it("uses a hex string as-is", () => {
      const result = normalizeObservation(raw({ data: "0xABCD" }), baseContext());
      expect(result.ok && result.value.data).toBe("0xabcd");
    });

    it("encodes a bigint or safe number as abi.encode(uint256)", () => {
      const bySafeNumber = normalizeObservation(raw({ data: 42 }), baseContext());
      const byBigint = normalizeObservation(raw({ data: 42n }), baseContext());
      expect(bySafeNumber.ok && bySafeNumber.value.data).toBe(coder.encode(["uint256"], [42]));
      expect(byBigint.ok && byBigint.value.data).toEqual(bySafeNumber.ok ? bySafeNumber.value.data : undefined);
    });

    it("empty data becomes 0x", () => {
      expect(normalizeObservation(raw({ data: undefined }), baseContext())).toMatchObject({
        ok: true,
        value: { data: "0x" },
      });
      expect(normalizeObservation(raw({ data: null }), baseContext())).toMatchObject({
        ok: true,
        value: { data: "0x" },
      });
    });

    it("rejects an odd-length hex string, a negative number and an unsupported type", () => {
      expect(normalizeObservation(raw({ data: "0xabc" }), baseContext())).toMatchObject({ ok: false });
      expect(normalizeObservation(raw({ data: -1 }), baseContext())).toMatchObject({ ok: false });
      expect(normalizeObservation(raw({ data: { nested: true } }), baseContext())).toMatchObject({ ok: false });
    });

    it("rejects data over MAX_DATA_LEN", () => {
      const result = normalizeObservation(raw({ data: `0x${"00".repeat(513)}` }), baseContext());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.some(i => i.field === "data")).toBe(true);
    });
  });

  describe("required fields and consistency (R1-R6, ADR §4.9)", () => {
    it("requires providerRef", () => {
      const result = normalizeObservation(raw({ providerRef: undefined }), baseContext());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.map(i => i.field)).toContain("providerRef");
    });

    it("requires a well-formed observedAt", () => {
      for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(normalizeObservation(raw({ observedAt: bad }), baseContext())).toMatchObject({ ok: false });
      }
    });

    it("requires a non-zero policyId", () => {
      const result = normalizeObservation(raw(), baseContext({ policyId: `0x${"00".repeat(32)}` as never }));
      expect(result.ok).toBe(false);
    });

    it("requires validitySeconds to be positive", () => {
      expect(normalizeObservation(raw(), baseContext({ validitySeconds: 0 }))).toMatchObject({ ok: false });
      expect(normalizeObservation(raw(), baseContext({ validitySeconds: -1 }))).toMatchObject({ ok: false });
    });

    it("requires streamSeq 0 for an unordered stream and >= 1 for an ordered one", () => {
      expect(normalizeObservation(raw(), baseContext({ streamSeq: 1n }))).toMatchObject({ ok: false });
      expect(
        normalizeObservation(raw(), baseContext({ streamId: `0x${"11".repeat(32)}` as never, streamSeq: 0n })),
      ).toMatchObject({ ok: false });
      expect(
        normalizeObservation(raw(), baseContext({ streamId: `0x${"11".repeat(32)}` as never, streamSeq: 1n })),
      ).toMatchObject({ ok: true });
    });

    it("collects every problem at once", () => {
      const result = normalizeObservation(
        raw({ providerRef: undefined, observedAt: -1 }),
        baseContext({ validitySeconds: 0 }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.length).toBeGreaterThanOrEqual(3);
    });
  });

  it("defaults submitter to the zero address (anyone may submit)", () => {
    const result = normalizeObservation(raw(), baseContext());
    expect(result.ok && result.value.submitter).toBe("0x0000000000000000000000000000000000000000");
  });
});
