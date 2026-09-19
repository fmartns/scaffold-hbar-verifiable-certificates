import { describe, expect, it } from "vitest";
import { NETWORKS } from "../networks";
import { ESTIMATED_FEE_USD, buildCostEstimate, estimateCost, fetchChargedFee, fetchUsdPerHbar } from "./cost";

const rate = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
// The real testnet answer of 2026-09: 231199 cents buy 30000 HBAR, i.e. US$ 0.07707 per HBAR.
const REAL_RATE = { current_rate: { cent_equivalent: 231199, hbar_equivalent: 30000 } };

describe("fetchUsdPerHbar", () => {
  it("converts cents per HBAR-equivalent into USD per HBAR", async () => {
    expect(await fetchUsdPerHbar(NETWORKS.testnet, rate(REAL_RATE))).toBeCloseTo(0.077066, 5);
  });

  it("asks the selected network's Mirror Node", async () => {
    const urls: string[] = [];
    await fetchUsdPerHbar(NETWORKS.mainnet, (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(REAL_RATE));
    }) as typeof fetch);
    expect(urls).toEqual(["https://mainnet.mirrornode.hedera.com/api/v1/network/exchangerate"]);
  });

  it.each([
    ["an HTTP error", rate({}, 503)],
    ["a malformed body", rate({ nope: 1 })],
    ["a zero rate", rate({ current_rate: { cent_equivalent: 0, hbar_equivalent: 1 } })],
    [
      "a network failure",
      (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as typeof fetch,
    ],
  ])("returns null instead of throwing on %s", async (_, fetchImpl) => {
    expect(await fetchUsdPerHbar(NETWORKS.testnet, fetchImpl)).toBeNull();
  });
});

describe("buildCostEstimate", () => {
  it("shows USD and HBAR when the rate is known", () => {
    const estimate = buildCostEstimate(NETWORKS.testnet, 0.077066);
    expect(estimate.createTopic).toEqual({ usd: "0.02", hbar: "0.2595" });
    expect(estimate.publishMessage).toEqual({ usd: "0.0005", hbar: "0.0065" });
    expect(estimate.usdPerHbar).toBe("0.0771");
  });

  it("falls back to USD only when the rate is unknown", () => {
    const estimate = buildCostEstimate(NETWORKS.testnet, null);
    expect(estimate.createTopic).toEqual({ usd: "0.02", hbar: null });
    expect(estimate.usdPerHbar).toBeNull();
  });

  it("marks only mainnet as real money", () => {
    expect(buildCostEstimate(NETWORKS.testnet, 0.1).free).toBe(true);
    expect(buildCostEstimate(NETWORKS.local, 0.1).free).toBe(true);
    expect(buildCostEstimate(NETWORKS.mainnet, 0.1).free).toBe(false);
  });

  it("stays above what was measured on the real network (0.0198 for the topic, 0.0004 for a message)", () => {
    expect(ESTIMATED_FEE_USD.createTopic).toBeGreaterThan(0.0198);
    expect(ESTIMATED_FEE_USD.publishMessage).toBeGreaterThan(0.00042);
  });

  it("estimateCost combines the lookup and the estimate", async () => {
    expect((await estimateCost(NETWORKS.testnet, rate(REAL_RATE))).createTopic.hbar).toBe("0.2595");
    expect((await estimateCost(NETWORKS.testnet, rate({}, 500))).createTopic.hbar).toBeNull();
  });
});

describe("fetchChargedFee", () => {
  // The real fee of the topic creation: 25 631 823 tinybars.
  const tx = (fee: unknown) => rate({ transactions: [{ charged_tx_fee: fee }] });

  it("reads the charged fee and converts it", async () => {
    expect(await fetchChargedFee(NETWORKS.testnet, "0.0.1-1-2", 0.077066, tx(25_631_823))).toEqual({
      tinybars: "25631823",
      hbar: "0.25631823",
      usd: "0.02",
    });
  });

  it("omits USD without a rate, and returns null for anything unusable", async () => {
    expect((await fetchChargedFee(NETWORKS.testnet, "0.0.1-1-2", null, tx(550_775)))?.usd).toBeNull();
    for (const bad of [tx(-1), tx("12"), tx(1.5), rate({ transactions: [] }), rate({}, 404)]) {
      expect(await fetchChargedFee(NETWORKS.testnet, "0.0.1-1-2", 0.07, bad)).toBeNull();
    }
    expect(
      await fetchChargedFee(NETWORKS.testnet, "x", 0.07, (async () => {
        throw new Error("down");
      }) as typeof fetch),
    ).toBeNull();
  });

  it("asks for the transaction by its Mirror id", async () => {
    const urls: string[] = [];
    await fetchChargedFee(NETWORKS.testnet, "0.0.9-17-5", 0.07, (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("{}", { status: 404 });
    }) as typeof fetch);
    expect(urls).toEqual(["https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.9-17-5"]);
  });
});
