/**
 * Read-only Mirror Node queries of the credential audit (#10), through an injectable `fetch`: HCS topic messages,
 * `CredentialRegistry` logs and `CredentialRegistry` transactions (contract results).
 *
 * Mirror Node is a read replica, eventually consistent (ADR-001 §3.8): `null`/empty means "not indexed (yet)", never
 * "does not exist". Callers poll (`./poll`) and report provenance. Topic-filtered log queries always carry a timestamp
 * range (ADR P6).
 */
import { hexlify } from "ethers";
import type { HederaNetwork } from "../networks";

export type MirrorReadErrorCode = "MIRROR_UNAVAILABLE" | "MIRROR_MALFORMED";

export class MirrorReadError extends Error {
  readonly code: MirrorReadErrorCode;
  readonly retryable: boolean;
  constructor(code: MirrorReadErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "MirrorReadError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface HcsTopicMessage {
  topicId: string;
  sequenceNumber: bigint;
  /** `seconds.nanoseconds`. */
  consensusTimestamp: string;
  message: Uint8Array;
  payerAccountId: string;
  runningHash: string;
}

export interface ContractLog {
  address: string;
  topics: string[];
  data: string;
  consensusTimestamp: string;
  transactionHash: string;
  logIndex: number;
}

export interface ContractTransaction {
  transactionHash: string;
  consensusTimestamp: string;
  from: string;
  result: string;
  /** 4-byte selector of the called function, e.g. `0x...` of `issue`/`revoke`. */
  functionSelector: string;
}

/** Inclusive consensus-timestamp range, `seconds.nanoseconds` or `seconds`. */
export interface TimestampRange {
  from: string;
  to: string;
}

export interface CredentialMirror {
  /** Origin of the Mirror Node, for provenance. */
  readonly origin: string;
  getTopicMessage(topicId: string, sequence: bigint): Promise<HcsTopicMessage | null>;
  /** Messages in the range, ascending, at most `maxPages` × 100. */
  listTopicMessages(
    topicId: string,
    range: TimestampRange,
    options?: { maxPages?: number },
  ): Promise<HcsTopicMessage[]>;
  getContractLogs(
    contract: string,
    query: { topic0: string; topic1?: string } & TimestampRange,
    options?: { maxPages?: number },
  ): Promise<ContractLog[]>;
  listContractTransactions(
    contract: string,
    range: TimestampRange,
    options?: { maxPages?: number },
  ): Promise<ContractTransaction[]>;
}

export interface CredentialMirrorOptions {
  fetch?: typeof fetch;
  /** Deadline of one HTTP request. Default 10000 ms. */
  timeoutMs?: number;
}

const DEFAULT_MAX_PAGES = 10;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

export function createCredentialMirror(
  network: HederaNetwork,
  options: CredentialMirrorOptions = {},
): CredentialMirror {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const origin = new URL(network.mirrorNodeUrl).origin;

  async function get(path: string): Promise<Record<string, unknown> | null> {
    let response: Response;
    try {
      response = await fetchImpl(`${network.mirrorNodeUrl}/api/v1${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new MirrorReadError("MIRROR_UNAVAILABLE", `Could not reach the Mirror Node at ${origin}.`, true);
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new MirrorReadError("MIRROR_UNAVAILABLE", `The Mirror Node answered HTTP ${response.status}.`, retryable);
    }
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw new MirrorReadError("MIRROR_MALFORMED", "The Mirror Node returned a malformed answer.", false);
    }
  }

  /** Follows `links.next` (a path that already carries `/api/v1`). */
  async function paginate(path: string, key: string, maxPages: number): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let next: string | null = path;
    for (let page = 0; next && page < maxPages; page++) {
      const body = await get(next);
      if (!body) break;
      const list = body[key];
      if (!Array.isArray(list)) throw new MirrorReadError("MIRROR_MALFORMED", `Mirror answer has no "${key}".`, false);
      items.push(...(list as Record<string, unknown>[]));
      const link = (body.links as { next?: string | null } | undefined)?.next;
      next = link ? link.replace(/^\/api\/v1/, "") : null;
    }
    return items;
  }

  function toMessage(topicId: string, m: Record<string, unknown>): HcsTopicMessage {
    const sequence = m.sequence_number;
    const timestamp = str(m.consensus_timestamp);
    const payload = str(m.message);
    if ((typeof sequence !== "number" && typeof sequence !== "string") || !timestamp || !payload) {
      throw new MirrorReadError("MIRROR_MALFORMED", "Mirror topic message is missing required fields.", false);
    }
    const runningHash = str(m.running_hash);
    return {
      topicId: str(m.topic_id) || topicId,
      sequenceNumber: BigInt(sequence),
      consensusTimestamp: timestamp,
      message: Uint8Array.from(Buffer.from(payload, "base64")),
      payerAccountId: str(m.payer_account_id),
      runningHash: runningHash ? hexlify(Buffer.from(runningHash, "base64")) : "",
    };
  }

  const range = (r: TimestampRange) => `timestamp=gte:${r.from}&timestamp=lte:${r.to}`;

  return {
    origin,

    async getTopicMessage(topicId, sequence) {
      const body = await get(`/topics/${topicId}/messages/${sequence.toString()}`);
      return body ? toMessage(topicId, body) : null;
    },

    async listTopicMessages(topicId, r, opts = {}) {
      const items = await paginate(
        `/topics/${topicId}/messages?${range(r)}&order=asc&limit=100`,
        "messages",
        opts.maxPages ?? DEFAULT_MAX_PAGES,
      );
      return items.map(m => toMessage(topicId, m));
    },

    async getContractLogs(contract, query, opts = {}) {
      const topics = `topic0=${query.topic0}${query.topic1 ? `&topic1=${query.topic1}` : ""}`;
      const items = await paginate(
        `/contracts/${contract}/results/logs?${topics}&${range(query)}&order=asc&limit=100`,
        "logs",
        opts.maxPages ?? DEFAULT_MAX_PAGES,
      );
      return items.map(l => {
        const topicsList = Array.isArray(l.topics) ? (l.topics as unknown[]).map(t => str(t).toLowerCase()) : [];
        const timestamp = str(l.timestamp);
        if (topicsList.length === 0 || !timestamp) {
          throw new MirrorReadError("MIRROR_MALFORMED", "Mirror contract log is missing required fields.", false);
        }
        return {
          address: str(l.address).toLowerCase(),
          topics: topicsList,
          data: str(l.data) || "0x",
          consensusTimestamp: timestamp,
          transactionHash: str(l.transaction_hash).toLowerCase(),
          logIndex: Number(l.index ?? 0),
        };
      });
    },

    async listContractTransactions(contract, r, opts = {}) {
      const items = await paginate(
        `/contracts/${contract}/results?${range(r)}&order=asc&limit=100`,
        "results",
        opts.maxPages ?? DEFAULT_MAX_PAGES,
      );
      return items.map(t => ({
        transactionHash: str(t.hash).toLowerCase(),
        consensusTimestamp: str(t.timestamp),
        from: str(t.from).toLowerCase(),
        result: str(t.result) || "UNKNOWN",
        functionSelector: str(t.function_parameters).slice(0, 10).toLowerCase(),
      }));
    },
  };
}
