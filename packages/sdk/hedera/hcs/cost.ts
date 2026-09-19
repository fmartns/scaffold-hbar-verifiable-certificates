/**
 * Cost estimates and charged fees for the HCS operations, shown to the person BEFORE anything is paid for.
 *
 * The USD figures below were measured on Hedera Testnet (2026-09), where the fee schedule mirrors mainnet, and are rounded
 * up: creating a topic with a submitKey charged 0.2563 HBAR (about US$ 0.0198) and publishing one 644-byte message charged
 * 0.0055 HBAR (about US$ 0.0004). Message fees grow with the size. They are estimates, never a promise; the exact charge
 * is read back from Mirror Node after the transaction (`fetchChargedFee`). Testnet HBAR has no monetary value.
 * Pure functions plus two Mirror Node lookups through an injectable `fetch`; best-effort: a failed lookup never blocks.
 */
import { formatHbar } from "../environment";
import type { HbarAmount } from "../environment";
import type { HederaNetwork } from "../networks";

/** Rounded-up USD estimates of the operations. */
export const ESTIMATED_FEE_USD = {
  createTopic: 0.02,
  /** Publishing one settlement envelope (about 500-960 bytes). */
  publishMessage: 0.0005,
} as const;

export interface CostLine {
  usd: string;
  /** null when the exchange rate could not be fetched. */
  hbar: string | null;
}

export interface CostEstimate {
  createTopic: CostLine;
  publishMessage: CostLine;
  /** USD per HBAR used for the conversion; null when unknown. */
  usdPerHbar: string | null;
  /** True on networks where HBAR has no monetary value (testnet, local). */
  free: boolean;
}

const usd = (value: number) =>
  value < 0.001 ? value.toFixed(4) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");

/** `cent_equivalent` cents buy `hbar_equivalent` HBAR: USD per HBAR = cents / hbar / 100. Null on any malformed answer. */
export async function fetchUsdPerHbar(
  network: HederaNetwork,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = 5_000,
): Promise<number | null> {
  try {
    const response = await fetchImpl(`${network.mirrorNodeUrl}/api/v1/network/exchangerate`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const rate = ((await response.json()) as { current_rate?: { cent_equivalent?: number; hbar_equivalent?: number } })
      .current_rate;
    if (!rate?.cent_equivalent || !rate.hbar_equivalent) return null;
    const value = rate.cent_equivalent / rate.hbar_equivalent / 100;
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function buildCostEstimate(network: HederaNetwork, usdPerHbar: number | null): CostEstimate {
  const line = (value: number): CostLine => ({
    usd: usd(value),
    hbar: usdPerHbar ? (value / usdPerHbar).toFixed(4) : null,
  });
  return {
    createTopic: line(ESTIMATED_FEE_USD.createTopic),
    publishMessage: line(ESTIMATED_FEE_USD.publishMessage),
    usdPerHbar: usdPerHbar ? usdPerHbar.toFixed(4) : null,
    free: network.name !== "mainnet",
  };
}

export async function estimateCost(
  network: HederaNetwork,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<CostEstimate> {
  return buildCostEstimate(network, await fetchUsdPerHbar(network, fetchImpl));
}

export interface ChargedFee extends HbarAmount {
  /** Approximate USD at the current rate; null when the rate is unknown. */
  usd: string | null;
}

/** The fee Hedera actually charged for a transaction, read from Mirror Node. Null while it is not indexed yet. */
export async function fetchChargedFee(
  network: HederaNetwork,
  mirrorTransactionId: string,
  usdPerHbar: number | null,
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = 5_000,
): Promise<ChargedFee | null> {
  try {
    const response = await fetchImpl(`${network.mirrorNodeUrl}/api/v1/transactions/${mirrorTransactionId}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const fee = ((await response.json()) as { transactions?: { charged_tx_fee?: number }[] }).transactions?.[0]
      ?.charged_tx_fee;
    if (typeof fee !== "number" || !Number.isSafeInteger(fee) || fee < 0) return null;
    return {
      tinybars: String(fee),
      hbar: formatHbar(BigInt(fee)),
      usd: usdPerHbar ? usd((fee / 1e8) * usdPerHbar) : null,
    };
  } catch {
    return null;
  }
}
