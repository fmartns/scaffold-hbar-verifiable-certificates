/**
 * A deterministic, in-memory Mirror Node + JSON-RPC relay for credential evidence. The answers are shaped like the
 * Mirror Node REST API (topics/messages, contracts/results/logs, contracts/results) and JSON-RPC `eth_call`.
 * `statusOf` is answered from `world.records`, or delegated to a real node (Hardhat) through `world.rpc`.
 */
import { Interface } from "ethers";
import type { CredentialAuditContext } from "../hedera/audit/audit";
import { createCredentialMirror } from "../hedera/audit/mirror";
import { CREDENTIAL_REGISTRY_ABI, createCredentialStatusReader } from "../hedera/audit/registry";
import { NETWORK, NOT_FOUND_RECORD, REGISTRY, REVOKED_AT, TOPIC } from "./credentials";

const REGISTRY_IFACE = new Interface(CREDENTIAL_REGISTRY_ABI);

export interface FakeMessage {
  sequence: bigint;
  consensusTimestamp: string;
  bytes: Uint8Array;
  payer?: string;
  /** Hidden for the first N reads (simulates Mirror indexing lag). */
  visibleAfterReads?: number;
}

export interface FakeLog {
  topics: string[];
  data: string;
  consensusTimestamp: string;
  transactionHash: string;
  /** Emitting contract; defaults to the fixture `REGISTRY`. */
  address?: string;
  visibleAfterReads?: number;
}

export interface FakeRecord {
  status: 0 | 1 | 2;
  issuer: string;
  credentialHash: string;
  subjectCommitment: string;
  signer: string;
  issuedAt: bigint;
  revokedAt: bigint;
}

export interface FakeWorld {
  messages: FakeMessage[];
  logs: FakeLog[];
  records: Map<string, FakeRecord>;
  transactions?: Record<string, unknown>[];
  /** Topic id reported in message bodies; defaults to the fixture `TOPIC`. */
  topicId?: string;
  /** Answers every JSON-RPC POST instead of `records` (e.g. relayed to a Hardhat node). Returns the `result`. */
  rpc?: (params: unknown[], method: string) => Promise<unknown>;
  /** Forced HTTP status for requests whose URL contains the key (e.g. `{"/topics/": 503}`). */
  failures?: Record<string, number>;
  /** `true` makes every request throw (network down). */
  offline?: boolean;
}

const json = (body: unknown, status = 200) =>
  new Response(
    JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
    { status },
  );

const inRange = (ts: string, gte: string | undefined, lte: string | undefined) =>
  (!gte || Number(ts) >= Number(gte)) && (!lte || Number(ts) <= Number(lte));

const range = (params: URLSearchParams) => {
  let gte: string | undefined;
  let lte: string | undefined;
  for (const value of params.getAll("timestamp")) {
    if (value.startsWith("gte:")) gte = value.slice(4);
    if (value.startsWith("lte:")) lte = value.slice(4);
  }
  return { gte, lte };
};

const messageJson = (m: FakeMessage, topicId: string) => ({
  consensus_timestamp: m.consensusTimestamp,
  message: Buffer.from(m.bytes).toString("base64"),
  payer_account_id: m.payer ?? "0.0.1001",
  running_hash: Buffer.from("ab".repeat(48), "hex").toString("base64"),
  sequence_number: Number(m.sequence),
  topic_id: topicId,
});

/** A `fetch` serving the world. Every request is recorded in `calls`. */
export function fakeFetch(world: FakeWorld) {
  const calls: string[] = [];
  const reads = new Map<string, number>();
  const visible = (key: string, after = 0) => {
    const n = (reads.get(key) ?? 0) + 1;
    reads.set(key, n);
    return n > after;
  };
  const topicId = () => world.topicId ?? TOPIC;

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (world.offline) throw new TypeError("fetch failed");
    for (const [needle, status] of Object.entries(world.failures ?? {})) {
      if (url.href.includes(needle)) return json({ _status: { messages: [{ message: "forced" }] } }, status);
    }

    if (init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as { method: string; params: [{ data: string }] };
      if (world.rpc) return json({ jsonrpc: "2.0", id: 1, result: await world.rpc(request.params, request.method) });
      const [credentialId] = REGISTRY_IFACE.decodeFunctionData("statusOf", request.params[0].data);
      const r = world.records.get(String(credentialId).toLowerCase()) ?? NOT_FOUND_RECORD;
      const result = REGISTRY_IFACE.encodeFunctionResult("statusOf", [
        [r.issuer, r.credentialHash, r.subjectCommitment, r.signer, r.issuedAt, r.revokedAt, r.status],
      ]);
      return json({ jsonrpc: "2.0", id: 1, result });
    }

    const path = url.pathname.replace(/^\/api\/v1/, "");
    let match = /^\/topics\/([^/]+)\/messages\/(\d+)$/.exec(path);
    if (match) {
      const m = world.messages.find(x => x.sequence === BigInt(match![2]));
      if (!m || !visible(`msg:${m.sequence}`, m.visibleAfterReads)) return json({ _status: {} }, 404);
      return json(messageJson(m, topicId()));
    }
    match = /^\/topics\/([^/]+)\/messages$/.exec(path);
    if (match) {
      const { gte, lte } = range(url.searchParams);
      const messages = world.messages
        .filter(m => inRange(m.consensusTimestamp, gte, lte) && visible(`list:${m.sequence}`, m.visibleAfterReads))
        .map(m => messageJson(m, topicId()));
      return json({ messages, links: { next: null } });
    }
    match = /^\/contracts\/([^/]+)\/results\/logs$/.exec(path);
    if (match) {
      const { gte, lte } = range(url.searchParams);
      const topic0 = url.searchParams.get("topic0")?.toLowerCase();
      const topic1 = url.searchParams.get("topic1")?.toLowerCase();
      const logs = world.logs
        .filter(
          l =>
            l.topics[0] === topic0 &&
            (!topic1 || l.topics[1] === topic1) &&
            inRange(l.consensusTimestamp, gte, lte) &&
            visible(`log:${l.transactionHash}`, l.visibleAfterReads),
        )
        .map((l, index) => ({
          address: (l.address ?? REGISTRY).toLowerCase(),
          contract_id: "0.0.9001",
          data: l.data,
          index,
          topics: l.topics,
          timestamp: l.consensusTimestamp,
          transaction_hash: l.transactionHash,
        }));
      return json({ logs, links: { next: null } });
    }
    match = /^\/contracts\/([^/]+)\/results$/.exec(path);
    if (match) return json({ results: world.transactions ?? [], links: { next: null } });
    return json({ _status: {} }, 404);
  }) as typeof fetch;

  return { fetch: impl, calls };
}

/** A virtual clock: `sleep` advances it instantly, so polling is deterministic and fast. */
export function virtualClock(startMs: number) {
  let now = startMs;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    sleeps,
  };
}

/** Audit context over the fake world; `nowSeconds` defaults to 30 s after the last on-chain fact. */
export function auditContext(
  world: FakeWorld,
  overrides: Partial<CredentialAuditContext> & { nowSeconds?: bigint } = {},
) {
  const { fetch, calls } = fakeFetch(world);
  const { nowSeconds, ...rest } = overrides;
  const clock = virtualClock(Number((nowSeconds ?? REVOKED_AT + 30n) * 1000n));
  const network = rest.network ?? NETWORK;
  const registryAddress = rest.registryAddress ?? REGISTRY;
  const ctx: CredentialAuditContext = {
    network,
    registryAddress,
    topicId: world.topicId ?? TOPIC,
    mirror: createCredentialMirror(network, { fetch }),
    registry: createCredentialStatusReader({ network, registryAddress, fetch }),
    pollTimeoutMs: 5_000,
    now: clock.now,
    sleep: clock.sleep,
    ...rest,
  };
  return { ctx, calls, clock };
}
