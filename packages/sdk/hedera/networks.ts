/**
 * Single source of truth for Hedera network configuration.
 * The SDK, the CLIs and the Next.js app read it from here; no other file may hardcode a Mirror Node or HashScan URL.
 */
export type HederaNetworkName = "testnet" | "mainnet" | "local";

export type HederaNetwork = {
  name: HederaNetworkName;
  /** Mirror Node REST base URL (no trailing slash). */
  mirrorNodeUrl: string;
  /** HashScan base URL, or null when the network has no known public explorer. */
  hashscanUrl: string | null;
};

export const NETWORKS: Record<HederaNetworkName, HederaNetwork> = {
  testnet: {
    name: "testnet",
    mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
    hashscanUrl: "https://hashscan.io/testnet",
  },
  mainnet: {
    name: "mainnet",
    mirrorNodeUrl: "https://mainnet.mirrornode.hedera.com",
    hashscanUrl: "https://hashscan.io/mainnet",
  },
  // Default Mirror Node REST port of the Hedera Local Node.
  local: {
    name: "local",
    mirrorNodeUrl: "http://127.0.0.1:5551",
    hashscanUrl: null,
  },
};

export const DEFAULT_NETWORK: HederaNetworkName = "testnet";

type Env = Record<string, string | undefined>;

export function isNetworkName(value: string): value is HederaNetworkName {
  return Object.prototype.hasOwnProperty.call(NETWORKS, value);
}

/** Parses `HEDERA_NETWORK`. An unset or empty value selects the default; an unknown value is an error. */
export function selectedNetworkName(env: Env = {}): HederaNetworkName {
  const raw = env.HEDERA_NETWORK?.trim();
  if (!raw) return DEFAULT_NETWORK;
  if (!isNetworkName(raw)) {
    throw new Error(`Invalid HEDERA_NETWORK "${raw}". Expected one of: ${Object.keys(NETWORKS).join(", ")}.`);
  }
  return raw;
}

/**
 * Returns the configuration of a network. `HEDERA_MIRROR_NODE_URL` overrides the Mirror Node of the network selected by
 * `HEDERA_NETWORK` only, so a single override cannot silently redirect a different network.
 */
export function getNetwork(name: HederaNetworkName, env: Env = {}): HederaNetwork {
  const base = NETWORKS[name];
  if (selectedNetworkName(env) !== name) return base;
  return { ...base, mirrorNodeUrl: (env.HEDERA_MIRROR_NODE_URL?.trim() || base.mirrorNodeUrl).replace(/\/+$/, "") };
}
