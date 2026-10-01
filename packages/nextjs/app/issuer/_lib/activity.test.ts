import { describe, expect, it } from "vitest";
import { ACTIVITY_STORAGE_KEY, loadActivity, recordActivity } from "./activity";
import type { ActivityEntry } from "./activity";

const entry = (n: number): ActivityEntry => ({
  kind: "issuance",
  credentialId: `0x${n.toString(16).padStart(64, "0")}`,
  at: "2026-10-01T12:00:00.000Z",
  network: "testnet",
  hcsTransactionId: `0.0.1234@1759320000.${n}`,
  hcsSequence: String(n),
  hcsHashscanUrl: null,
  registryTransactionHash: `0x${"ab".repeat(32)}`,
});

function memory(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [[ACTIVITY_STORAGE_KEY, initial]]);
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

describe("issuer activity log", () => {
  it("is empty without storage, with corrupt JSON or with a non-array value", () => {
    expect(loadActivity(null)).toEqual([]);
    expect(loadActivity(memory("{not json"))).toEqual([]);
    expect(loadActivity(memory('{"kind":"issuance"}'))).toEqual([]);
  });

  it("drops entries that are not activity records", () => {
    const stored = JSON.stringify([entry(1), { kind: "other" }, null, { ...entry(2), credentialId: 7 }]);
    expect(loadActivity(memory(stored))).toEqual([entry(1)]);
  });

  it("keeps the newest 50 entries first", () => {
    const storage = memory();
    for (let n = 1; n <= 52; n++) recordActivity(entry(n), storage);
    const saved = loadActivity(storage);
    expect(saved).toHaveLength(50);
    expect(saved[0]).toEqual(entry(52));
    expect(saved.at(-1)).toEqual(entry(3));
  });

  it("still returns the entry when storage refuses to save it", () => {
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(recordActivity(entry(1), full)).toEqual([entry(1)]);
  });

  it("uses the browser's localStorage by default", () => {
    localStorage.clear();
    recordActivity(entry(5));
    expect(loadActivity()).toEqual([entry(5)]);
  });
});
