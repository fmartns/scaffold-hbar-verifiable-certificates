import { describe, expect, it } from "vitest";
import { DEFAULT_NETWORK, NETWORKS, getNetwork, selectedNetworkName } from "./networks";

describe("networks", () => {
  it("defaults to testnet when HEDERA_NETWORK is unset or empty", () => {
    expect(DEFAULT_NETWORK).toBe("testnet");
    expect(selectedNetworkName({})).toBe("testnet");
    expect(selectedNetworkName({ HEDERA_NETWORK: "  " })).toBe("testnet");
  });

  it("rejects an unknown HEDERA_NETWORK instead of falling back", () => {
    expect(() => selectedNetworkName({ HEDERA_NETWORK: "previewnet" })).toThrow(/Invalid HEDERA_NETWORK "previewnet"/);
  });

  it("applies the Mirror Node override only to the selected network", () => {
    const env = { HEDERA_NETWORK: "testnet", HEDERA_MIRROR_NODE_URL: "https://mirror.example/" };
    expect(getNetwork("testnet", env).mirrorNodeUrl).toBe("https://mirror.example");
    expect(getNetwork("mainnet", env).mirrorNodeUrl).toBe(NETWORKS.mainnet.mirrorNodeUrl);
    expect(getNetwork("local", { HEDERA_MIRROR_NODE_URL: "https://mirror.example" })).toEqual(NETWORKS.local);
  });

  it("does not expose a HashScan URL for the local network", () => {
    expect(NETWORKS.local.hashscanUrl).toBeNull();
    expect(NETWORKS.testnet.hashscanUrl).toBe("https://hashscan.io/testnet");
  });
});
