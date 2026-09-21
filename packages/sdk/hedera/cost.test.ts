import { describe, expect, it } from "vitest";
import { NETWORKS } from "./networks";
import { costLine, fetchChargedFee, fetchUsdPerHbar, formatUsd, isFreeNetwork } from "./cost";

const rate = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
// The real testnet answer of 2026-09: 231199 cents buy 30000 HBAR, i.e. US$ 0.07707 per HBAR.
const REAL_RATE = { current_rate: { cent_equivalent: 231199, hbar_equivalent: 30000 } };

describe("formatUsd", () => {
  it("shows 4 decimals under a cent, 3 significant otherwise, trimmed", () => {
    expect(formatUsd(0.0004)).toBe("0.0004");
    expect(formatUsd(0.02)).toBe("0.02");
    expect(formatUsd(0.05)).toBe("0.05");
  });
});

describe("costLine", () => {
  it("converts to HBAR when the rate is known, and to USD only otherwise", () => {
    expect(costLine(0.02, 0.077066)).toEqual({ usd: "0.02", hbar: "0.2595" });
    expect(costLine(0.02, null)).toEqual({ usd: "0.02", hbar: null });
  });
});

describe("isFreeNetwork", () => {
  it("is true everywhere except mainnet", () => {
    expect(isFreeNetwork(NETWORKS.testnet)).toBe(true);
    expect(isFreeNetwork(NETWORKS.local)).toBe(true);
    expect(isFreeNetwork(NETWORKS.mainnet)).toBe(false);
  });
});

describe("fetchUsdPerHbar", () => {
  it("converts cents per HBAR-equivalent into USD per HBAR", async () => {
    expect(await fetchUsdPerHbar(NETWORKS.testnet, rate(REAL_RATE))).toBeCloseTo(0.077066, 5);
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

describe("fetchChargedFee", () => {
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
});
