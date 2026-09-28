/**
 * HBAR amounts without floating point. Dependency-free so browser code (the wallet panel) can import it without pulling
 * in the Hedera SDK.
 */

export const TINYBARS_PER_HBAR = 100_000_000n;

/**
 * The JSON-RPC relay reports native balances with 18 decimals, like ether: 1 tinybar = 10^10 weibars.
 */
export const WEIBARS_PER_TINYBAR = 10_000_000_000n;

export function formatHbar(tinybars: bigint): string {
  const negative = tinybars < 0n;
  const abs = negative ? -tinybars : tinybars;
  const whole = abs / TINYBARS_PER_HBAR;
  const fraction = (abs % TINYBARS_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Formats an `eth_getBalance` answer (hex weibars) as HBAR, truncated to tinybar precision; `null` if malformed. */
export function formatWeibarsAsHbar(hexWeibars: string): string | null {
  if (!/^0x[0-9a-fA-F]+$/.test(hexWeibars)) return null;
  return formatHbar(BigInt(hexWeibars) / WEIBARS_PER_TINYBAR);
}
