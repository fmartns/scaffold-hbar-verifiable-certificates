import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { SMOKE_TEST_ROUTER_PLACEHOLDER, SMOKE_TEST_SOURCE, runPublishSmokeTest } from "./smoke-test";
import { SETTLEMENT_EVENT_TYPES, decodeMessage, eip712Domain, encodeMessage } from "./envelope";
import {
  FIXED_CONSENSUS,
  FIXED_TX_ID,
  TEST_ROUTER,
  TEST_TOPIC,
  TEST_SIGNER,
  fakeTransport,
  goodReceipt,
  hederaError,
  validEnv,
} from "./test-fixtures";
import type { TransportRequest } from "./publisher";

const NOW = 1_767_225_000_000;
const clock = () => {
  let t = NOW;
  return () => (t += 40); // every read advances 40 ms
};

/** Mirror Node that serves what the fake transport received, after `after` lookups. */
function fakeMirror(sent: { message?: Uint8Array }, opts: { after?: number; corrupt?: boolean; fee?: number } = {}) {
  let lookups = 0;
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/api/v1/topics/")) {
      lookups++;
      if (!sent.message || lookups <= (opts.after ?? 0)) return new Response("", { status: 404 });
      const bytes = opts.corrupt ? new Uint8Array([1, 2, 3]) : sent.message;
      return new Response(JSON.stringify({ message: Buffer.from(bytes).toString("base64") }));
    }
    if (url.pathname === "/api/v1/network/exchangerate") {
      return new Response(JSON.stringify({ current_rate: { cent_equivalent: 231199, hbar_equivalent: 30000 } }));
    }
    if (url.pathname.startsWith("/api/v1/transactions/")) {
      return new Response(JSON.stringify({ transactions: [{ charged_tx_fee: opts.fee ?? 550_775 }] }));
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { impl, lookups: () => lookups };
}

function capturingTransport(sent: { message?: Uint8Array }) {
  return fakeTransport((request: TransportRequest) => {
    sent.message = request.message;
    return goodReceipt();
  });
}

const env = (extra: Record<string, string> = {}) => ({ ...validEnv(extra) });
const base = { topicId: TEST_TOPIC, sleep: async () => undefined, now: clock(), signer: TEST_SIGNER };

describe("runPublishSmokeTest", () => {
  it("publishes through the real publisher, reads the message back and confirms digest and signer", async () => {
    const sent: { message?: Uint8Array } = {};
    const { transport, calls } = capturingTransport(sent);
    const result = await runPublishSmokeTest(env(), { ...base, transport, fetch: fakeMirror(sent).impl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toHaveLength(1);
    expect(calls[0].topicId).toBe(TEST_TOPIC);
    expect(result.published).toMatchObject({
      status: "published",
      transactionId: FIXED_TX_ID,
      consensusTimestamp: FIXED_CONSENSUS,
    });
    expect(result.timings.publishMs).toBeGreaterThan(0);
    expect(result.charged).toEqual({ tinybars: "550775", hbar: "0.00550775", usd: "0.0004" });
    expect(result.routerIsPlaceholder).toBe(false);
  });

  it("sends a self-labelled throwaway attestation that no router can settle", async () => {
    const sent: { message?: Uint8Array } = {};
    const { transport } = capturingTransport(sent);
    await runPublishSmokeTest(env(), { ...base, transport, fetch: fakeMirror(sent).impl });
    const decoded = decodeMessage(sent.message as Uint8Array, { chainId: 296, verifyingContract: TEST_ROUTER });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.event.eventSource).toBe(SMOKE_TEST_SOURCE);
      expect(decoded.value.derived.signer).toBe(TEST_SIGNER.address.toLowerCase());
    }
  });

  it("signs with a random key by default, never a fixed one", async () => {
    const signers = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const sent: { message?: Uint8Array } = {};
      const { transport } = capturingTransport(sent);
      await runPublishSmokeTest(env(), {
        topicId: TEST_TOPIC,
        transport,
        fetch: fakeMirror(sent).impl,
        sleep: async () => undefined,
      });
      const decoded = decodeMessage(sent.message as Uint8Array, { chainId: 296, verifyingContract: TEST_ROUTER });
      if (decoded.ok) signers.add(decoded.value.derived.signer);
    }
    expect(signers.size).toBe(2);
  });

  it("uses a placeholder router, and says so, while none is configured", async () => {
    const sent: { message?: Uint8Array } = {};
    const { transport } = capturingTransport(sent);
    const noRouter = { HEDERA_NETWORK: "testnet" };
    const result = await runPublishSmokeTest(noRouter, { ...base, transport, fetch: fakeMirror(sent).impl });
    expect(result).toMatchObject({ ok: true, routerIsPlaceholder: true });
    expect(
      decodeMessage(sent.message as Uint8Array, { chainId: 296, verifyingContract: SMOKE_TEST_ROUTER_PLACEHOLDER }).ok,
    ).toBe(true);
  });

  it("waits for Mirror Node to index the message", async () => {
    const sent: { message?: Uint8Array } = {};
    const { transport } = capturingTransport(sent);
    const mirror = fakeMirror(sent, { after: 4 });
    const result = await runPublishSmokeTest(env(), { ...base, transport, fetch: mirror.impl });
    expect(result.ok).toBe(true);
    expect(mirror.lookups()).toBe(5);
  });

  it("reports a publish that is not visible on Mirror in time as a read-stage failure that keeps the publication", async () => {
    const sent: { message?: Uint8Array } = {};
    const { transport } = capturingTransport(sent);
    const result = await runPublishSmokeTest(env(), {
      ...base,
      transport,
      fetch: fakeMirror(sent, { after: 99 }).impl,
      readAttempts: 3,
    });
    expect(result).toMatchObject({ ok: false, stage: "read", published: { transactionId: FIXED_TX_ID } });
    if (!result.ok && result.stage === "read") expect(result.message).toMatch(/not lost/);
  });

  it("fails when Mirror returns something that is not the published attestation", async () => {
    const sent: { message?: Uint8Array } = {};
    const { transport } = capturingTransport(sent);
    const result = await runPublishSmokeTest(env(), {
      ...base,
      transport,
      fetch: fakeMirror(sent, { corrupt: true }).impl,
    });
    expect(result).toMatchObject({ ok: false, stage: "read" });
  });

  it("fails when Mirror returns a different valid attestation than the one published (digest mismatch)", async () => {
    const sent: { message?: Uint8Array } = {};
    const { transport } = capturingTransport(sent);
    const other: { message?: Uint8Array } = {};
    // A perfectly valid envelope, but for another event: same signer, same router, different identity.
    await runPublishSmokeTest(env(), {
      ...base,
      now: () => NOW + 5_000,
      transport: capturingTransport(other).transport,
      fetch: fakeMirror(other).impl,
    });
    const mirror = fakeMirror(other);
    const result = await runPublishSmokeTest(env(), { ...base, transport, fetch: mirror.impl });
    expect(result).toMatchObject({ ok: false, stage: "read" });
    if (!result.ok && result.stage === "read") expect(result.message).toMatch(/does not decode to the attestation/);
  });

  it("fails when the message on Mirror carries the same event signed by someone else (signer mismatch)", async () => {
    const sent: { message?: Uint8Array } = {};
    const { transport } = capturingTransport(sent);
    const impostor = new Wallet(`0x${"02".repeat(32)}`);
    let served: Uint8Array | undefined;
    const inner = fakeMirror(sent);
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/messages/") && sent.message) {
        if (!served) {
          const decoded = decodeMessage(sent.message, { chainId: 296, verifyingContract: TEST_ROUTER });
          if (!decoded.ok) throw new Error("fixture");
          const signature = await impostor.signTypedData(
            eip712Domain({ chainId: 296, verifyingContract: TEST_ROUTER }),
            SETTLEMENT_EVENT_TYPES,
            decoded.value.event,
          );
          served = encodeMessage({ event: decoded.value.event, signature: signature as `0x${string}` });
        }
        return new Response(JSON.stringify({ message: Buffer.from(served).toString("base64") }));
      }
      return inner.impl(input, init);
    }) as typeof fetch;
    const result = await runPublishSmokeTest(env(), { ...base, transport, fetch: fetchImpl });
    expect(result).toMatchObject({ ok: false, stage: "read" });
  });

  it("reports a publish failure with the normalized error", async () => {
    const { transport } = fakeTransport(() => {
      throw hederaError("PrecheckStatusError", "INVALID_TOPIC_ID");
    });
    const result = await runPublishSmokeTest(env(), { ...base, transport, fetch: fakeMirror({}).impl });
    expect(result).toMatchObject({ ok: false, stage: "publish", error: { code: "TOPIC_INVALID" } });
  });

  it("reports an unusable configuration as a publish-stage CONFIG_INVALID", async () => {
    const { transport } = fakeTransport(() => goodReceipt());
    const result = await runPublishSmokeTest(env({ HEDERA_NETWORK: "devnet" }), {
      ...base,
      transport,
      fetch: fakeMirror({}).impl,
    });
    expect(result).toMatchObject({ ok: false, stage: "publish", error: { code: "CONFIG_INVALID" } });
  });

  it("does not need a real signer key to be the test signer's (random wallets work)", async () => {
    const sent: { message?: Uint8Array } = {};
    const { transport } = capturingTransport(sent);
    const wallet = Wallet.createRandom();
    const result = await runPublishSmokeTest(env(), {
      ...base,
      signer: wallet,
      transport,
      fetch: fakeMirror(sent).impl,
    });
    expect(result.ok).toBe(true);
  });
});
