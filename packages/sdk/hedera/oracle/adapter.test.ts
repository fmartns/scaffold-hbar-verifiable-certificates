import { describe, expect, it, vi } from "vitest";
import { createOracleAdapter } from "./adapter";
import { OracleError } from "./errors";
import { normalizeObservation } from "./normalize";
import type { Attestor, EventNormalizer, OracleProvider, RawObservation } from "./types";
import { baseContext, DOMAIN } from "./test-fixtures";

const RAW: RawObservation = { providerRef: "order-1", observedAt: 1_767_225_060, data: 100n };
const now = () => new Date(1_767_225_060_000 + 30_000); // 30s after observedAt: well within the default 300s window

function fakeProvider(behaviour: (query: { ref: string }) => Promise<RawObservation>): OracleProvider {
  return {
    eventSource: "0xaa".padEnd(66, "0") as `0x${string}`,
    fetch: (query, options) =>
      Promise.race([
        behaviour(query),
        new Promise<never>((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))),
      ]),
  };
}

const workingProvider = fakeProvider(async () => RAW);
const normalizer: EventNormalizer = { normalize: normalizeObservation };
const signingAttestor: Attestor = {
  attest: async draft => ({ event: draft, signature: `0x${"11".repeat(65)}` as `0x${string}` }),
};

describe("createOracleAdapter (composed reference flow)", () => {
  it("fetches, normalizes, validates and attests, returning everything a caller needs", async () => {
    const adapter = createOracleAdapter({ provider: workingProvider, normalizer, attestor: signingAttestor, now });
    const result = await adapter.observe({ query: { ref: "order-1" }, context: baseContext(), domain: DOMAIN });
    expect(result).toMatchObject({ ok: true, raw: RAW });
    if (result.ok) {
      expect(result.draft.externalEventId).toBeDefined();
      expect(result.event).toEqual(result.draft);
      expect(result.signature).toBe(`0x${"11".repeat(65)}`);
    }
  });

  it("exposes the provider's eventSource", () => {
    const adapter = createOracleAdapter({ provider: workingProvider, normalizer, attestor: signingAttestor });
    expect(adapter.eventSource).toBe(workingProvider.eventSource);
  });

  it("classifies a provider fetch failure without calling normalize or attest", async () => {
    let normalizeCalls = 0;
    let attestCalls = 0;
    const failing = fakeProvider(async () => {
      throw new OracleError({ code: "PROVIDER_UNAVAILABLE", message: "down", remediation: "retry", retryable: true });
    });
    const adapter = createOracleAdapter({
      provider: failing,
      normalizer: { normalize: (raw, ctx) => (normalizeCalls++, normalizeObservation(raw, ctx)) },
      attestor: { attest: async draft => (attestCalls++, { event: draft, signature: "0x" as `0x${string}` }) },
    });
    const result = await adapter.observe({ query: { ref: "order-1" }, context: baseContext(), domain: DOMAIN });
    expect(result).toMatchObject({ ok: false, failure: { code: "PROVIDER_UNAVAILABLE" } });
    expect(normalizeCalls).toBe(0);
    expect(attestCalls).toBe(0);
  });

  it("times out a slow provider using its own configured timeoutMs, and aborts the provider's signal", async () => {
    let aborted = false;
    const slow: OracleProvider = {
      eventSource: workingProvider.eventSource,
      fetch: (_query, options) =>
        new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    };
    const adapter = createOracleAdapter({ provider: slow, normalizer, attestor: signingAttestor, timeoutMs: 20 });
    const result = await adapter.observe({ query: { ref: "order-1" }, context: baseContext(), domain: DOMAIN });
    expect(result).toMatchObject({ ok: false, failure: { code: "TIMEOUT", retryable: true } });
    expect(aborted).toBe(true);
  }, 1000);

  it("reports NORMALIZATION_FAILED with the field issues and never attests", async () => {
    let attestCalls = 0;
    const adapter = createOracleAdapter({
      provider: fakeProvider(async () => ({ observedAt: 1_767_225_060 }) as RawObservation), // no providerRef
      normalizer,
      attestor: { attest: async draft => (attestCalls++, { event: draft, signature: "0x" as `0x${string}` }) },
      now,
    });
    const result = await adapter.observe({ query: { ref: "order-1" }, context: baseContext(), domain: DOMAIN });
    expect(result).toMatchObject({ ok: false, failure: { code: "NORMALIZATION_FAILED" } });
    if (!result.ok) expect(result.failure.issues?.some(i => i.field === "providerRef")).toBe(true);
    expect(attestCalls).toBe(0);
  });

  it("reports INVALID_EVENT when the normalizer's own output does not pass the shared schema", async () => {
    const brokenNormalizer: EventNormalizer = {
      normalize: () => ({
        ok: true,
        value: { ...normalizeInvalid(), policyId: `0x${"00".repeat(32)}` as `0x${string}` },
      }),
    };
    const adapter = createOracleAdapter({
      provider: workingProvider,
      normalizer: brokenNormalizer,
      attestor: signingAttestor,
      now,
    });
    const result = await adapter.observe({ query: { ref: "order-1" }, context: baseContext(), domain: DOMAIN });
    expect(result).toMatchObject({ ok: false, failure: { code: "INVALID_EVENT" } });
  });

  it("rejects an observation older than maxAgeSeconds before attesting (freshness precheck, ADR §8 '#8')", async () => {
    let attestCalls = 0;
    const adapter = createOracleAdapter({
      provider: workingProvider,
      normalizer,
      attestor: { attest: async draft => (attestCalls++, { event: draft, signature: "0x" as `0x${string}` }) },
      maxAgeSeconds: 60,
      now: () => new Date((1_767_225_060 + 120) * 1000), // 120s later, over the 60s window
    });
    const result = await adapter.observe({ query: { ref: "order-1" }, context: baseContext(), domain: DOMAIN });
    expect(result).toMatchObject({ ok: false, failure: { code: "TOO_STALE", retryable: true } });
    expect(attestCalls).toBe(0);
  });

  it("accepts an observation right at the edge of maxAgeSeconds", async () => {
    const adapter = createOracleAdapter({
      provider: workingProvider,
      normalizer,
      attestor: signingAttestor,
      maxAgeSeconds: 60,
      now: () => new Date((1_767_225_060 + 60) * 1000),
    });
    const result = await adapter.observe({ query: { ref: "order-1" }, context: baseContext(), domain: DOMAIN });
    expect(result.ok).toBe(true);
  });

  it("rejects a runaway validity window before attesting", async () => {
    let attestCalls = 0;
    const adapter = createOracleAdapter({
      provider: workingProvider,
      normalizer,
      attestor: { attest: async draft => (attestCalls++, { event: draft, signature: "0x" as `0x${string}` }) },
      defaultValiditySeconds: 900,
      now,
    });
    const result = await adapter.observe({
      query: { ref: "order-1" },
      context: baseContext({ validitySeconds: 10_000 }),
      domain: DOMAIN,
    });
    expect(result).toMatchObject({ ok: false, failure: { code: "VALIDITY_WINDOW_TOO_LONG" } });
    expect(attestCalls).toBe(0);
  });

  it("propagates an attestation failure normalized, after fetch/normalize/validate/freshness all passed", async () => {
    const failingAttestor: Attestor = {
      attest: async () => {
        throw new OracleError({
          code: "ATTESTATION_FAILED",
          message: "signer down",
          remediation: "retry",
          retryable: true,
        });
      },
    };
    const adapter = createOracleAdapter({ provider: workingProvider, normalizer, attestor: failingAttestor, now });
    const result = await adapter.observe({ query: { ref: "order-1" }, context: baseContext(), domain: DOMAIN });
    expect(result).toMatchObject({ ok: false, failure: { code: "ATTESTATION_FAILED" } });
  });

  it("never logs to the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(m =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const adapter = createOracleAdapter({ provider: workingProvider, normalizer, attestor: signingAttestor, now });
    await adapter.observe({ query: { ref: "order-1" }, context: baseContext(), domain: DOMAIN });
    expect(spies.every(s => s.mock.calls.length === 0)).toBe(true);
    spies.forEach(s => s.mockRestore());
  });
});

function normalizeInvalid() {
  const result = normalizeObservation(RAW, baseContext());
  if (!result.ok) throw new Error("fixture invalid");
  return result.value;
}
