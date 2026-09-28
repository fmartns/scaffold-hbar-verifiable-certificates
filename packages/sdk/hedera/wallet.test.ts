import { describe, expect, it } from "vitest";
import { formatWeibarsAsHbar } from "./hbar";
import { NETWORKS } from "./networks";
import { addEthereumChainParameter, isTargetChain, toChainIdHex, walletAccountUrl, walletTarget } from "./wallet";

describe("wallet helpers", () => {
  it("describes the target network from networks.ts only", () => {
    expect(walletTarget("testnet")).toEqual({
      network: "testnet",
      chainId: 296,
      chainIdHex: "0x128",
      hashscanUrl: "https://hashscan.io/testnet",
    });
    expect(walletTarget("local").hashscanUrl).toBeNull();
  });

  it("adds a chain with the public relay, 18-decimal HBAR and HashScan", () => {
    expect(addEthereumChainParameter("testnet")).toEqual({
      chainId: "0x128",
      chainName: "Hedera Testnet",
      nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
      rpcUrls: [NETWORKS.testnet.rpcUrl],
      blockExplorerUrls: ["https://hashscan.io/testnet"],
    });
    expect(addEthereumChainParameter("local")).not.toHaveProperty("blockExplorerUrls");
  });

  it("compares the wallet chain whatever its encoding, and never throws on garbage", () => {
    const target = walletTarget("testnet");
    expect(isTargetChain(target, "0x128")).toBe(true);
    expect(isTargetChain(target, "296")).toBe(true);
    expect(isTargetChain(target, 296)).toBe(true);
    expect(isTargetChain(target, "0x127")).toBe(false);
    for (const garbage of ["", "0x", "0xzz", "testnet", null, undefined]) {
      expect(isTargetChain(target, garbage)).toBe(false);
    }
    expect(toChainIdHex(295)).toBe("0x127");
  });

  it("links a wallet address through the explorer helper", () => {
    const address = `0x${"ab".repeat(20)}`;
    expect(walletAccountUrl(walletTarget("testnet"), address)).toBe(`https://hashscan.io/testnet/account/${address}`);
    expect(walletAccountUrl(walletTarget("local"), address)).toBeNull();
  });

  it("formats eth_getBalance weibars as HBAR at tinybar precision", () => {
    expect(formatWeibarsAsHbar(`0x${(10n ** 18n).toString(16)}`)).toBe("1");
    expect(formatWeibarsAsHbar(`0x${(1234500000n * 10n ** 10n + 9n).toString(16)}`)).toBe("12.345");
    expect(formatWeibarsAsHbar("0x0")).toBe("0");
    expect(formatWeibarsAsHbar("12")).toBeNull();
  });
});
