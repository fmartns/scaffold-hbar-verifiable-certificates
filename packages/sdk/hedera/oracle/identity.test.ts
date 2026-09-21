import { keccak256, toUtf8Bytes } from "ethers";
import { describe, expect, it } from "vitest";
import {
  eventSourceOf,
  externalEventIdFromFeedRound,
  externalEventIdFromFields,
  externalEventIdFromRef,
} from "./identity";

describe("eventSourceOf (ADR R6)", () => {
  it("is keccak256 of the lowercase ASCII name", () => {
    expect(eventSourceOf("Mock-Oracle")).toBe(keccak256(toUtf8Bytes("mock-oracle")));
  });

  it("is deterministic and case-insensitive", () => {
    expect(eventSourceOf("provider-x")).toBe(eventSourceOf("PROVIDER-X"));
  });

  it("rejects non-ASCII names", () => {
    expect(() => eventSourceOf("própvider")).toThrow();
  });
});

describe("externalEventIdFromRef (R4, R5)", () => {
  it("is deterministic: the same ref always gives the same id", () => {
    expect(externalEventIdFromRef("order-42")).toBe(externalEventIdFromRef("order-42"));
  });

  it("namespaces by event type (R5): the same ref under two types gives two ids", () => {
    const a = externalEventIdFromRef("order-42", "delivery.confirmed");
    const b = externalEventIdFromRef("order-42", "payment.settled");
    expect(a).not.toBe(b);
    expect(a).not.toBe(externalEventIdFromRef("order-42"));
  });

  it("never hashes JSON (R4): differs from hashing the ref as a bare string when a type is given", () => {
    const withType = externalEventIdFromRef("order-42", "delivery.confirmed");
    const bareRef = externalEventIdFromRef("order-42");
    expect(withType).not.toBe(bareRef);
  });
});

describe("externalEventIdFromFeedRound (R6, on-chain feeds)", () => {
  it("is deterministic and distinguishes feed and round", () => {
    expect(externalEventIdFromFeedRound("BTC/USD", 5n)).toBe(externalEventIdFromFeedRound("BTC/USD", 5n));
    expect(externalEventIdFromFeedRound("BTC/USD", 5n)).not.toBe(externalEventIdFromFeedRound("BTC/USD", 6n));
    expect(externalEventIdFromFeedRound("BTC/USD", 5n)).not.toBe(externalEventIdFromFeedRound("ETH/USD", 5n));
  });

  it("accepts a plain number round, equal to the bigint form", () => {
    expect(externalEventIdFromFeedRound("BTC/USD", 5)).toBe(externalEventIdFromFeedRound("BTC/USD", 5n));
  });
});

describe("externalEventIdFromFields (R1-R4 fallback)", () => {
  it("is deterministic and order-sensitive", () => {
    expect(externalEventIdFromFields(["a", 1n])).toBe(externalEventIdFromFields(["a", 1n]));
    expect(externalEventIdFromFields(["a", 1n])).not.toBe(externalEventIdFromFields([1n, "a"]));
  });
});
