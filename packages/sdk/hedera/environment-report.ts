/**
 * Presentation of an {@link EnvironmentValidation} as plain text. Pure: it returns lines and never prints, so the
 * setup command, CI logs and any other consumer decide where the text goes. Contains no ANSI codes.
 */
import type { EnvironmentIssue, EnvironmentValidation } from "./environment";

function formatIssue(item: EnvironmentIssue): string[] {
  const marker = item.severity === "error" ? "x" : "!";
  return [`  ${marker} [${item.code}] ${item.message}`, `      Fix: ${item.remediation}`];
}

export function formatEnvironmentReport(result: EnvironmentValidation): string[] {
  const lines: string[] = [];
  if (result.ok) {
    lines.push("Hedera environment is valid.");
    lines.push(`  Network:  ${result.network}`);
    lines.push(`  Account:  ${result.accountId}`);
    lines.push(`  Balance:  ${result.balance.hbar} HBAR (minimum ${result.minimumBalance.hbar} HBAR)`);
    lines.push(`  Key:      ${result.keyVerified ? "matches the account" : "not verified against the account"}`);
    lines.push(`  HashScan: ${result.hashscanUrl ?? "not available for this network"}`);
  } else if (result.status === "unverified") {
    lines.push("Could not verify the Hedera environment (no answer from the network).");
  } else {
    lines.push("Hedera environment is not valid.");
  }
  for (const item of result.ok ? [] : result.issues) lines.push(...formatIssue(item));
  if (result.warnings.length > 0) {
    lines.push("Warnings:");
    for (const item of result.warnings) lines.push(...formatIssue(item));
  }
  return lines;
}
