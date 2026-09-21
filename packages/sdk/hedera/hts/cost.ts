/**
 * Cost estimates and charged fees for the HTS operations, shown to the person BEFORE anything is paid for.
 *
 * The USD figures below were measured on Hedera Testnet (2026-09), where the fee schedule mirrors mainnet, and are rounded
 * up: a TokenCreate (treasury + supply key) charged 12.8159 HBAR (about US$ 0.99, matching Hedera's published $1 token
 * creation fee), a TokenAssociate charged 0.6408 HBAR (about US$ 0.0494) and a TokenMint charged 0.2563 HBAR (about
 * US$ 0.0198), sampled from real transactions of those types on Mirror Node. A token TransferTransaction was not found
 * live in the same sample; its estimate uses the base CryptoTransfer fee observed (0.0013 HBAR, about US$ 0.0001), which a
 * token transfer should not exceed by much. They are estimates, never a promise; the exact charge is read back from
 * Mirror Node after the transaction (`fetchChargedFee`, shared with the HCS publisher). Testnet HBAR has no monetary value.
 */
import { costLine, fetchUsdPerHbar, isFreeNetwork } from "../cost";
import type { CostLine } from "../cost";
import type { HederaNetwork } from "../networks";

/** Rounded-up USD estimates of the operations. */
export const ESTIMATED_HTS_FEE_USD = {
  createToken: 1,
  associate: 0.05,
  mint: 0.02,
  transfer: 0.0002,
} as const;

export interface HtsCostEstimate {
  createToken: CostLine;
  associate: CostLine;
  mint: CostLine;
  transfer: CostLine;
  /** USD per HBAR used for the conversion; null when unknown. */
  usdPerHbar: string | null;
  /** True on networks where HBAR has no monetary value (testnet, local). */
  free: boolean;
}

export function buildHtsCostEstimate(network: HederaNetwork, usdPerHbar: number | null): HtsCostEstimate {
  return {
    createToken: costLine(ESTIMATED_HTS_FEE_USD.createToken, usdPerHbar),
    associate: costLine(ESTIMATED_HTS_FEE_USD.associate, usdPerHbar),
    mint: costLine(ESTIMATED_HTS_FEE_USD.mint, usdPerHbar),
    transfer: costLine(ESTIMATED_HTS_FEE_USD.transfer, usdPerHbar),
    usdPerHbar: usdPerHbar ? usdPerHbar.toFixed(4) : null,
    free: isFreeNetwork(network),
  };
}

export async function estimateHtsCost(
  network: HederaNetwork,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<HtsCostEstimate> {
  return buildHtsCostEstimate(network, await fetchUsdPerHbar(network, fetchImpl));
}

export { fetchUsdPerHbar, fetchChargedFee } from "../cost";
export type { ChargedFee, CostLine } from "../cost";
