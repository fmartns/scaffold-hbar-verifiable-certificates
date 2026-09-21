import { describe, expect, it } from "vitest";
import { NETWORKS } from "../networks";
import { ESTIMATED_HTS_FEE_USD, buildHtsCostEstimate, estimateHtsCost } from "./cost";

const rate = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
const REAL_RATE = { current_rate: { cent_equivalent: 231199, hbar_equivalent: 30000 } };

describe("buildHtsCostEstimate", () => {
  it("shows USD and HBAR for associate, mint and transfer when the rate is known", () => {
    const estimate = buildHtsCostEstimate(NETWORKS.testnet, 0.077066);
    expect(estimate.createToken).toEqual({ usd: "1", hbar: "12.9759" });
    expect(estimate.associate).toEqual({ usd: "0.05", hbar: "0.6488" });
    expect(estimate.mint).toEqual({ usd: "0.02", hbar: "0.2595" });
    expect(estimate.transfer).toEqual({ usd: "0.0002", hbar: "0.0026" });
    expect(estimate.usdPerHbar).toBe("0.0771");
  });

  it("falls back to USD only when the rate is unknown", () => {
    const estimate = buildHtsCostEstimate(NETWORKS.testnet, null);
    expect(estimate.createToken).toEqual({ usd: "1", hbar: null });
    expect(estimate.associate).toEqual({ usd: "0.05", hbar: null });
    expect(estimate.usdPerHbar).toBeNull();
  });

  it("marks only mainnet as real money", () => {
    expect(buildHtsCostEstimate(NETWORKS.testnet, 0.1).free).toBe(true);
    expect(buildHtsCostEstimate(NETWORKS.mainnet, 0.1).free).toBe(false);
  });

  it("stays at or above what was measured on the real network (createToken 0.9877, associate 0.0494, mint 0.0198)", () => {
    expect(ESTIMATED_HTS_FEE_USD.createToken).toBeGreaterThan(0.9877);
    expect(ESTIMATED_HTS_FEE_USD.associate).toBeGreaterThan(0.0494);
    expect(ESTIMATED_HTS_FEE_USD.mint).toBeGreaterThan(0.0198);
  });

  it("estimateHtsCost combines the lookup and the estimate", async () => {
    expect((await estimateHtsCost(NETWORKS.testnet, rate(REAL_RATE))).associate.hbar).toBe("0.6488");
    expect((await estimateHtsCost(NETWORKS.testnet, rate({}, 500))).associate.hbar).toBeNull();
  });
});
