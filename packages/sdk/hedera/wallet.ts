/**
 * Browser wallet (EIP-1193) helpers for the selected network. Imports only dependency-free modules so it is safe in a
 * client bundle: import it as `@sh/sdk/hedera/wallet`, not from the package root (which pulls in the Hedera SDK).
 *
 * The chain added to a wallet always uses the PUBLIC relay of `networks.ts`, never `HEDERA_RPC_URL`: an override may
 * carry an API key in its path and must not leave the server.
 */
import { hashscanAccountUrl } from "./explorer";
import { NETWORKS } from "./networks";
import type { HederaNetworkName } from "./networks";

export { formatWeibarsAsHbar } from "./hbar";

/** Public, secret-free description of the network a wallet should be on. Safe to send to the browser. */
export interface WalletTarget {
  network: HederaNetworkName;
  chainId: number;
  /** `0x`-prefixed hex, as EIP-1193 reports `eth_chainId`. */
  chainIdHex: string;
  hashscanUrl: string | null;
}

/** EIP-3085 `wallet_addEthereumChain` parameters. */
export interface AddEthereumChainParameter {
  chainId: string;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
}

export const toChainIdHex = (chainId: number) => `0x${chainId.toString(16)}`;

export function walletTarget(name: HederaNetworkName): WalletTarget {
  const network = NETWORKS[name];
  return {
    network: name,
    chainId: network.chainId,
    chainIdHex: toChainIdHex(network.chainId),
    hashscanUrl: network.hashscanUrl,
  };
}

export function addEthereumChainParameter(name: HederaNetworkName): AddEthereumChainParameter {
  const network = NETWORKS[name];
  return {
    chainId: toChainIdHex(network.chainId),
    chainName: `Hedera ${name.charAt(0).toUpperCase()}${name.slice(1)}`,
    // The relay exposes HBAR with 18 decimals (weibars), whatever the native 8.
    nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
    rpcUrls: [network.rpcUrl],
    ...(network.hashscanUrl && { blockExplorerUrls: [network.hashscanUrl] }),
  };
}

/** HashScan page of a wallet's EVM address on the target network; `null` without a public explorer. */
export function walletAccountUrl(target: Pick<WalletTarget, "network">, address: string): string | null {
  return hashscanAccountUrl(NETWORKS[target.network], address);
}

/** Compares an EIP-1193 `eth_chainId` answer (hex or decimal string) with the target. */
export function isTargetChain(target: Pick<WalletTarget, "chainId">, reported: string | number | null | undefined) {
  if (typeof reported === "number") return reported === target.chainId;
  if (typeof reported !== "string" || !/^(0x[0-9a-fA-F]+|\d+)$/.test(reported)) return false;
  return Number(BigInt(reported)) === target.chainId;
}
