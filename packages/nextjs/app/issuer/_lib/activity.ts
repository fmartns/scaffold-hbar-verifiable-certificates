/**
 * Local record of this browser's issuances and revocations: identifiers and evidence links only (credential ID, HCS
 * transaction id and HashScan URL, registry transaction hash). Never the subject, its salt or any form content.
 */
export interface ActivityEntry {
  kind: "issuance" | "revocation";
  credentialId: string;
  at: string;
  network: string;
  hcsTransactionId: string;
  hcsSequence: string;
  hcsHashscanUrl: string | null;
  registryTransactionHash: string;
}

export const ACTIVITY_STORAGE_KEY = "sh.issuer.activity.v1";
const MAX_ENTRIES = 50;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const browserStorage = (): StorageLike | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const isEntry = (value: unknown): value is ActivityEntry => {
  const e = value as Partial<ActivityEntry> | null;
  return (
    !!e &&
    (e.kind === "issuance" || e.kind === "revocation") &&
    typeof e.credentialId === "string" &&
    typeof e.hcsTransactionId === "string" &&
    typeof e.registryTransactionHash === "string"
  );
};

export function loadActivity(storage: StorageLike | null = browserStorage()): ActivityEntry[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(ACTIVITY_STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

export function recordActivity(entry: ActivityEntry, storage: StorageLike | null = browserStorage()): ActivityEntry[] {
  const next = [entry, ...loadActivity(storage)].slice(0, MAX_ENTRIES);
  try {
    storage?.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage full or disabled: the entry is still shown for this session.
  }
  return next;
}
