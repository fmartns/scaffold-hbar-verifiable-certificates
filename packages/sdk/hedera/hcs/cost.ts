/**
 * Cost estimates and charged fees for the HCS operations, shown to the person BEFORE anything is paid for.
 *
 * The USD figures below were measured on Hedera Testnet (2026-09), where the fee schedule mirrors mainnet, and are rounded
 * up: creating a topic with a submitKey charged 0.2563 HBAR (about US$ 0.0198) and publishing one 644-byte message charged
 * 0.0055 HBAR (about US$ 0.0004). Message fees grow with the size. They are estimates, never a promise; the exact charge
 * is read back from Mirror Node after the transaction (`fetchChargedFee`). Testnet HBAR has no monetary value.
 * The lookups themselves (exchange rate, charged fee) are shared with the HTS adapter; see `../cost`.
 */
import { costLine, fetchUsdPerHbar, isFreeNetwork } from "../cost";
import type { CostLine } from "../cost";
import type { HederaNetwork } from "../networks";

/** Rounded-up USD estimates of the operations. */
export const ESTIMATED_FEE_USD = {
  createTopic: 0.02,
  /** Publishing one settlement envelope (about 500-960 bytes). */
  publishMessage: 0.0005,
} as const;

export interface CostEstimate {
  createTopic: CostLine;
  publishMessage: CostLine;
  /** USD per HBAR used for the conversion; null when unknown. */
  usdPerHbar: string | null;
  /** True on networks where HBAR has no monetary value (testnet, local). */
  free: boolean;
}

export function buildCostEstimate(network: HederaNetwork, usdPerHbar: number | null): CostEstimate {
  return {
    createTopic: costLine(ESTIMATED_FEE_USD.createTopic, usdPerHbar),
    publishMessage: costLine(ESTIMATED_FEE_USD.publishMessage, usdPerHbar),
    usdPerHbar: usdPerHbar ? usdPerHbar.toFixed(4) : null,
    free: isFreeNetwork(network),
  };
}

export async function estimateCost(
  network: HederaNetwork,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<CostEstimate> {
  return buildCostEstimate(network, await fetchUsdPerHbar(network, fetchImpl));
}

export { fetchUsdPerHbar, fetchChargedFee } from "../cost";
export type { ChargedFee, CostLine } from "../cost";
