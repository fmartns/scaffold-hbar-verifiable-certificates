/**
 * A NON-DURABLE, in-memory {@link IdempotencyLedger} for tests and local development. Production callers supply their own
 * (a database row keyed by `idempotencyKey`, with `begin` as an atomic insert); the adapter deliberately introduces no
 * storage of its own. Records are cloned on the way in and out so callers cannot mutate them.
 */
import type { IdempotencyLedger, LedgerRecord } from "./types";

const clone = <T>(value: T): T => structuredClone(value);

export function createInMemoryLedger(): IdempotencyLedger & { records(): LedgerRecord[] } {
  const store = new Map<string, LedgerRecord>();
  return {
    async get(key) {
      const record = store.get(key);
      return record ? clone(record) : null;
    },
    async begin(record) {
      const existing = store.get(record.idempotencyKey);
      if (existing) return { created: false, record: clone(existing) };
      store.set(record.idempotencyKey, clone(record));
      return { created: true, record: clone(record) };
    },
    async save(record) {
      store.set(record.idempotencyKey, clone(record));
    },
    records: () => [...store.values()].map(clone),
  };
}
