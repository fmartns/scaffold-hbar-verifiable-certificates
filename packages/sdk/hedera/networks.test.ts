import { describe, expect, it } from "vitest";
import { DEFAULT_NETWORK, NETWORKS, getNetwork, getSelectedNetwork, selectedNetworkName } from "./networks";

describe("networks", () => {
  it("uses the documented chain ids", () => {
    expect(NETWORKS.mainnet.chainId).toBe(295);
    expect(NETWORKS.testnet.chainId).toBe(296);
    expect(NETWORKS.local.chainId).toBe(298);
  });

  it("defaults to testnet when HEDERA_NETWORK is unset or empty", () => {
    expect(DEFAULT_NETWORK).toBe("testnet");
    expect(selectedNetworkName({})).toBe("testnet");
    expect(selectedNetworkName({ HEDERA_NETWORK: "  " })).toBe("testnet");
    expect(getSelectedNetwork({}).chainId).toBe(296);
  });

  it("rejects an unknown HEDERA_NETWORK instead of falling back", () => {
    expect(() => selectedNetworkName({ HEDERA_NETWORK: "previewnet" })).toThrow(/Invalid HEDERA_NETWORK "previewnet"/);
  });

  it("applies endpoint overrides only to the selected network", () => {
    const env = {
      HEDERA_NETWORK: "testnet",
      HEDERA_RPC_URL: "https://rpc.example/api",
      HEDERA_MIRROR_NODE_URL: "https://mirror.example/",
    };
    expect(getNetwork("testnet", env).rpcUrl).toBe("https://rpc.example/api");
    expect(getNetwork("testnet", env).mirrorNodeUrl).toBe("https://mirror.example");
    expect(getNetwork("mainnet", env).rpcUrl).toBe(NETWORKS.mainnet.rpcUrl);
    expect(getNetwork("mainnet", env).mirrorNodeUrl).toBe(NETWORKS.mainnet.mirrorNodeUrl);
  });

  it("applies overrides to the default network when HEDERA_NETWORK is unset, and never to another one", () => {
    const env = { HEDERA_RPC_URL: "https://rpc.example/api" };
    expect(getNetwork("testnet", env).rpcUrl).toBe("https://rpc.example/api");
    expect(getNetwork("local", env).rpcUrl).toBe(NETWORKS.local.rpcUrl);
  });

  it("does not expose a HashScan URL for the local network", () => {
    expect(NETWORKS.local.hashscanUrl).toBeNull();
    expect(NETWORKS.testnet.hashscanUrl).toBe("https://hashscan.io/testnet");
  });
});
