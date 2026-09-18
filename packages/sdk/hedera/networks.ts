/**
 * Single source of truth for Hedera network configuration.
 * Hardhat, the Next.js app and the SDK all read it from here; no other file may hardcode an RPC or Mirror Node URL.
 */

export type HederaNetworkName = "testnet" | "mainnet" | "local";

export type HederaNetwork = {
  name: HederaNetworkName;
  /** EVM chain id served by the JSON-RPC relay. */
  chainId: number;
  /** JSON-RPC relay endpoint. The public Hashio endpoints are meant for development and testing only. */
  rpcUrl: string;
  /** Mirror Node REST base URL (no trailing slash). */
  mirrorNodeUrl: string;
  /** HashScan base URL, or null when the network has no known public explorer. */
  hashscanUrl: string | null;
};

export const NETWORKS: Record<HederaNetworkName, HederaNetwork> = {
  testnet: {
    name: "testnet",
    chainId: 296,
    rpcUrl: "https://testnet.hashio.io/api",
    mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
    hashscanUrl: "https://hashscan.io/testnet",
  },
  mainnet: {
    name: "mainnet",
    chainId: 295,
    rpcUrl: "https://mainnet.hashio.io/api",
    mirrorNodeUrl: "https://mainnet.mirrornode.hedera.com",
    hashscanUrl: "https://hashscan.io/mainnet",
  },
  // Defaults of the Hedera Local Node (relay on 7546, Mirror Node REST on 5551).
  local: {
    name: "local",
    chainId: 298,
    rpcUrl: "http://127.0.0.1:7546",
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
 * Returns the configuration of a network. `HEDERA_RPC_URL` and `HEDERA_MIRROR_NODE_URL` override the endpoints of the
 * network selected by `HEDERA_NETWORK` only, so a single override cannot silently redirect a different network.
 */
export function getNetwork(name: HederaNetworkName, env: Env = {}): HederaNetwork {
  const base = NETWORKS[name];
  if (selectedNetworkName(env) !== name) return base;
  return {
    ...base,
    rpcUrl: env.HEDERA_RPC_URL?.trim() || base.rpcUrl,
    mirrorNodeUrl: (env.HEDERA_MIRROR_NODE_URL?.trim() || base.mirrorNodeUrl).replace(/\/+$/, ""),
  };
}

/** Configuration of the network selected by `HEDERA_NETWORK` (testnet by default). */
export function getSelectedNetwork(env: Env = {}): HederaNetwork {
  return getNetwork(selectedNetworkName(env), env);
}
