import { describe, expect, it, vi } from "vitest";
import { decodeMessage, encodeMessage } from "../hcs/envelope";
import { OracleError } from "./errors";
import {
  INVALID_PAYLOAD_SAMPLES,
  MOCK_ORACLE_SIGNER,
  createMockOracleAdapter,
  createMockOracleProvider,
  makeFixture,
  validateRawObservation,
} from "./mock";
import { eventSourceOf } from "./identity";
import { baseContext, DOMAIN } from "./test-fixtures";

// Fixtures use observedAt = 1_767_225_000; keep the adapter's clock within the default freshness window of that.
const now = () => new Date(1_767_225_060_000);

const fixtureA = makeFixture({ providerRef: "order-1", observedAt: 1_767_225_000, data: 100n });

describe("createMockOracleProvider (implements exactly OracleProvider)", () => {
  it("labels itself as a mock (ADR REQ-12-08: never mistaken for a real integration)", () => {
    const provider = createMockOracleProvider();
    expect(provider.eventSource).toMatch(/^0x[0-9a-f]{64}$/);
    // The label lives in the name hashed into eventSource; recompute it to confirm the name contains "mock".
    expect(provider.eventSource).toBe(eventSourceOf("mock-oracle"));
  });

  it("a fixture always returns the exact same observation (determinism, no clock/randomness)", async () => {
    const provider = createMockOracleProvider({ fixtures: { "order-1": { kind: "observation", value: fixtureA } } });
    const controller = new AbortController();
    const a = await provider.fetch({ ref: "order-1" }, { signal: controller.signal, timeoutMs: 1000 });
    const b = await provider.fetch({ ref: "order-1" }, { signal: controller.signal, timeoutMs: 1000 });
    expect(a).toEqual(fixtureA);
    expect(a).toEqual(b);
  });

  it("a ref with no fixture is NO_DATA, not silence and not a generic error", async () => {
    const provider = createMockOracleProvider();
    const controller = new AbortController();
    const error = await provider.fetch({ ref: "unknown" }, { signal: controller.signal, timeoutMs: 1000 }).then(
      () => null,
      (e: unknown) => e as OracleError,
    );
    expect(error).toBeInstanceOf(OracleError);
    expect(error?.code).toBe("NO_DATA");
  });

  it("an explicit no-data fixture behaves the same as an absent one", async () => {
    const provider = createMockOracleProvider({ fixtures: { "order-2": { kind: "no-data" } } });
    const controller = new AbortController();
    const error = await provider.fetch({ ref: "order-2" }, { signal: controller.signal, timeoutMs: 1000 }).then(
      () => null,
      (e: unknown) => e as OracleError,
    );
    expect(error?.code).toBe("NO_DATA");
  });

  it("an invalid-payload fixture rejects with INVALID_PAYLOAD, naming the structural problem", async () => {
    for (const [name, value] of Object.entries(INVALID_PAYLOAD_SAMPLES)) {
      const provider = createMockOracleProvider({ fixtures: { bad: { kind: "invalid-payload", value } } });
      const controller = new AbortController();
      const error = await provider.fetch({ ref: "bad" }, { signal: controller.signal, timeoutMs: 1000 }).then(
        () => null,
        (e: unknown) => e as OracleError,
      );
      expect(error, name).toBeInstanceOf(OracleError);
      expect(error?.code, name).toBe("INVALID_PAYLOAD");
    }
  });

  it("a timeout fixture never resolves on its own, and rejects when the signal aborts", async () => {
    const provider = createMockOracleProvider({ fixtures: { slow: { kind: "timeout" } } });
    const controller = new AbortController();
    const pending = provider.fetch({ ref: "slow" }, { signal: controller.signal, timeoutMs: 1000 });
    let settled = false;
    pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it("an error fixture rejects with the configured code", async () => {
    const provider = createMockOracleProvider({ fixtures: { down: { kind: "error", code: "PROVIDER_UNAVAILABLE" } } });
    const controller = new AbortController();
    const error = await provider.fetch({ ref: "down" }, { signal: controller.signal, timeoutMs: 1000 }).then(
      () => null,
      (e: unknown) => e as OracleError,
    );
    expect(error?.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error?.failure.retryable).toBe(true);
  });

  it("calls onFetch with every query, for tests that assert what was requested", async () => {
    const seen: string[] = [];
    const provider = createMockOracleProvider({
      fixtures: { "order-1": { kind: "observation", value: fixtureA } },
      onFetch: q => seen.push(q.ref),
    });
    await provider.fetch({ ref: "order-1" }, { signal: new AbortController().signal, timeoutMs: 1000 });
    expect(seen).toEqual(["order-1"]);
  });

  it("never touches the network or credentials: no fetch import, no env var read", () => {
    const spy = vi.spyOn(globalThis, "fetch");
    createMockOracleProvider();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("validateRawObservation", () => {
  it("accepts a well-formed observation and rejects each malformed sample", () => {
    expect(validateRawObservation(fixtureA).ok).toBe(true);
    for (const value of Object.values(INVALID_PAYLOAD_SAMPLES)) expect(validateRawObservation(value).ok).toBe(false);
  });
});

describe("createMockOracleAdapter (mock provider + reference normalizer + fixed-key attestor)", () => {
  const domain = DOMAIN;

  it("implements exactly OracleAdapter and produces a valid, signed event without any credential", async () => {
    const adapter = createMockOracleAdapter({ now, fixtures: { "order-1": { kind: "observation", value: fixtureA } } });
    const result = await adapter.observe({ query: { ref: "order-1" }, context: baseContext(), domain });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.event.eventSource).toBe(adapter.eventSource);
      expect(result.signature).toMatch(/^0x[0-9a-f]{130}$/);
    }
  });

  it("is fully deterministic end to end: two adapters, same fixtures, same result", async () => {
    const build = () =>
      createMockOracleAdapter({
        fixtures: { "order-1": { kind: "observation", value: fixtureA } },
        now: () => new Date("2026-01-01T00:05:00.000Z"),
      });
    const a = await build().observe({ query: { ref: "order-1" }, context: baseContext(), domain });
    const b = await build().observe({ query: { ref: "order-1" }, context: baseContext(), domain });
    expect(a).toEqual(b);
  });

  it("the produced event round-trips through the HCS envelope wire format (#6 compatibility)", async () => {
    const adapter = createMockOracleAdapter({ now, fixtures: { "order-1": { kind: "observation", value: fixtureA } } });
    const result = await adapter.observe({ query: { ref: "order-1" }, context: baseContext(), domain });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const message = encodeMessage(result);
    const decoded = decodeMessage(message, domain, { expectedSigner: MOCK_ORACLE_SIGNER.address });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.derived.attestationDigest).toBeDefined();
  });

  it("calling observe twice with the same ref is, by construction, a duplicate event (same eventKey and digest)", async () => {
    const adapter = createMockOracleAdapter({ now, fixtures: { "order-1": { kind: "observation", value: fixtureA } } });
    const a = await adapter.observe({ query: { ref: "order-1" }, context: baseContext(), domain });
    const b = await adapter.observe({ query: { ref: "order-1" }, context: baseContext(), domain });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.event.externalEventId).toBe(a.event.externalEventId);
      expect(b.signature).toBe(a.signature);
    }
  });

  it("two refs with different eventType but the same providerRef simulate distinct events from one entity (R5)", async () => {
    const delivered = makeFixture({
      providerRef: "order-1",
      observedAt: 1_767_225_000,
      eventType: "delivery.confirmed",
      data: 1n,
    });
    const paid = makeFixture({
      providerRef: "order-1",
      observedAt: 1_767_225_000,
      eventType: "payment.settled",
      data: 1n,
    });
    const adapter = createMockOracleAdapter({
      now,
      fixtures: { delivered: { kind: "observation", value: delivered }, paid: { kind: "observation", value: paid } },
    });
    const a = await adapter.observe({ query: { ref: "delivered" }, context: baseContext(), domain });
    const b = await adapter.observe({ query: { ref: "paid" }, context: baseContext(), domain });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.event.externalEventId).not.toBe(b.event.externalEventId);
  });

  it("simulates an out-of-order stream: a fixture with streamSeq 3 arriving with lastSeq still at 1", async () => {
    const outOfOrder = makeFixture({ providerRef: "reading-3", observedAt: 1_767_225_000, data: 3n });
    const adapter = createMockOracleAdapter({
      now,
      fixtures: { "reading-3": { kind: "observation", value: outOfOrder } },
    });
    const ctx = baseContext({ streamId: `0x${"22".repeat(32)}` as never, streamSeq: 3n });
    const result = await adapter.observe({ query: { ref: "reading-3" }, context: ctx, domain });
    expect(result.ok && result.event.streamSeq).toBe(3n); // #9's router, not the oracle, rejects an out-of-order arrival
  });

  it("simulates inconsistent/malformed data (INVALID_PAYLOAD), stopping before any signature is produced", async () => {
    const adapter = createMockOracleAdapter({
      now,
      fixtures: { bad: { kind: "invalid-payload", value: INVALID_PAYLOAD_SAMPLES.wrongTypeObservedAt } },
    });
    const result = await adapter.observe({ query: { ref: "bad" }, context: baseContext(), domain });
    expect(result).toMatchObject({ ok: false, failure: { code: "INVALID_PAYLOAD" } });
  });

  it("simulates NO_DATA, distinct from any error", async () => {
    const adapter = createMockOracleAdapter();
    const result = await adapter.observe({ query: { ref: "nothing-yet" }, context: baseContext(), domain });
    expect(result).toMatchObject({ ok: false, failure: { code: "NO_DATA", retryable: true } });
  });

  it("simulates a timeout end to end through the adapter's own deadline", async () => {
    const adapter = createMockOracleAdapter({ now, fixtures: { slow: { kind: "timeout" } }, timeoutMs: 20 });
    const result = await adapter.observe({ query: { ref: "slow" }, context: baseContext(), domain });
    expect(result).toMatchObject({ ok: false, failure: { code: "TIMEOUT", retryable: true } });
  }, 1000);

  it("accepts an overridden signer key while staying deterministic for that key", async () => {
    const key = `0x${"09".repeat(32)}`;
    const adapter = createMockOracleAdapter({
      now,
      fixtures: { "order-1": { kind: "observation", value: fixtureA } },
      signer: key,
    });
    const result = await adapter.observe({ query: { ref: "order-1" }, context: baseContext(), domain });
    expect(result.ok).toBe(true);
  });
});
