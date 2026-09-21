/**
 * Cost estimates and charged fees, shared by every module that shows a person what an operation may cost BEFORE they pay
 * for it (the HCS publisher, the HTS adapter). Pure functions plus Mirror Node lookups through an injectable `fetch`;
 * best-effort: a failed lookup never blocks the caller, it just leaves the USD-only estimate or `null`.
 */
import { formatHbar } from "./environment";
import type { HbarAmount } from "./environment";
import type { HederaNetwork } from "./networks";

export interface CostLine {
  usd: string;
  /** null when the exchange rate could not be fetched. */
  hbar: string | null;
}

/** Rounds to 4 decimals under a cent, 3 significant decimals otherwise, and trims trailing zeros. */
export const formatUsd = (value: number): string =>
  value < 0.001 ? value.toFixed(4) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");

export function costLine(usdEstimate: number, usdPerHbar: number | null): CostLine {
  return { usd: formatUsd(usdEstimate), hbar: usdPerHbar ? (usdEstimate / usdPerHbar).toFixed(4) : null };
}

/** True on networks where HBAR has no monetary value: showing a cost is informational only, never a real charge. */
export const isFreeNetwork = (network: HederaNetwork): boolean => network.name !== "mainnet";

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
      usd: usdPerHbar ? formatUsd((fee / 1e8) * usdPerHbar) : null,
    };
  } catch {
    return null;
  }
}
