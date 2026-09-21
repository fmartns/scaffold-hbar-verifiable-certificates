/**
 * HashScan and Mirror Node identifiers, derived from the network table (`networks.ts`). The single place that builds
 * explorer links: the HCS publisher (#6) and the HTS adapter (#7) both use it, and neither may format its own.
 * A network without a public explorer (local) yields `null`.
 */
import type { HederaNetwork } from "./networks";

/** `0.0.123@1712345678.123456789` -> `0.0.123-1712345678-123456789` (the Mirror Node REST format). */
export function toMirrorTransactionId(transactionId: string): string {
  const match = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(transactionId);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : transactionId;
}

/** `1712345678.123456789` -> `1712345678123456789` */
export function timestampToNanoseconds(consensusTimestamp: string): string {
  const [seconds, nanos] = consensusTimestamp.split(".");
  return (BigInt(seconds) * 1_000_000_000n + BigInt(nanos)).toString();
}

/**
 * HashScan page of a transaction, addressed by consensus timestamp: unique per record, unlike a transaction id, which can
 * have duplicates and children.
 */
export function hashscanTransactionUrl(network: HederaNetwork, consensusTimestamp: string): string | null {
  return network.hashscanUrl ? `${network.hashscanUrl}/transaction/${consensusTimestamp}` : null;
}

export function hashscanTopicUrl(network: HederaNetwork, topicId: string): string | null {
  return network.hashscanUrl ? `${network.hashscanUrl}/topic/${topicId}` : null;
}

export function hashscanTokenUrl(network: HederaNetwork, tokenId: string): string | null {
  return network.hashscanUrl ? `${network.hashscanUrl}/token/${tokenId}` : null;
}

export function hashscanAccountUrl(network: HederaNetwork, accountId: string): string | null {
  return network.hashscanUrl ? `${network.hashscanUrl}/account/${accountId}` : null;
}
