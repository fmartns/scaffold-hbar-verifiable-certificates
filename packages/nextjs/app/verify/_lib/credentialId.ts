import { isCredentialId } from "@sh/sdk/hedera/wallet";

/**
 * Normalizes whatever a visitor hands the verifier — a bare `credentialId`, or the full value scanned from a QR
 * code (e.g. `https://host/verify/0x...`, with or without a trailing slash or query string) — into a lowercase
 * `credentialId`, the same identity `CredentialRegistry.statusOf` and the audit expect. Returns `null` when nothing
 * that looks like a credential id can be found, so the caller can show a specific "not a credential id" message
 * instead of forwarding junk to the API.
 */
export function extractCredentialId(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const candidates = [trimmed];
  try {
    const url = new URL(trimmed);
    const segments = url.pathname.split("/").filter(Boolean);
    const last = segments.at(-1);
    if (last) candidates.push(last);
  } catch {
    // Not a URL: the trimmed value itself is the only candidate.
  }

  const hexMatch = trimmed.match(/0x[0-9a-fA-F]{64}/);
  if (hexMatch) candidates.push(hexMatch[0]);

  for (const candidate of candidates) {
    const lower = candidate.trim().toLowerCase();
    if (isCredentialId(lower)) return lower;
  }
  return null;
}
