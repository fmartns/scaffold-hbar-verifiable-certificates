/**
 * HBAR amounts without floating point. Dependency-free, so it is safe in browser code.
 */

export const TINYBARS_PER_HBAR = 100_000_000n;

export function formatHbar(tinybars: bigint): string {
  const negative = tinybars < 0n;
  const abs = negative ? -tinybars : tinybars;
  const whole = abs / TINYBARS_PER_HBAR;
  const fraction = (abs % TINYBARS_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
