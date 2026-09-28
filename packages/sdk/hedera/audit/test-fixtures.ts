/**
 * Deterministic fixtures for the credential audit tests. NOT exported from the package.
 * The fake answers are shaped like the Mirror Node REST API (topics/messages, contracts/results/logs, contracts/results)
 * and the JSON-RPC `eth_call`. Keys are throwaway and control nothing; ECDSA (RFC 6979) makes every signature stable.
 */
import { Interface, Wallet, ZeroHash, keccak256, toUtf8Bytes } from "ethers";
import { NETWORKS } from "../networks";
import {
  CREDENTIAL_EVENT_TYPES,
  CREDENTIAL_REVOCATION_TYPES,
  computeCredentialDigest,
  computeCredentialId,
  credentialDomain,
  encodeCredentialMessage,
} from "../hcs/credential-envelope";
import type { CredentialEvent, CredentialRevocation } from "../hcs/credential-envelope";
import type { Hex } from "../hcs/envelope";
import type { CredentialAuditContext } from "./audit";
import { createCredentialMirror } from "./mirror";
import { CREDENTIAL_REGISTRY_ABI, createCredentialStatusReader } from "./registry";

export const NETWORK = NETWORKS.testnet;
export const ISSUER_SIGNER = new Wallet(`0x${"11".repeat(32)}`);
export const ADMIN = new Wallet(`0x${"22".repeat(32)}`);
export const STRANGER = new Wallet(`0x${"33".repeat(32)}`);
export const REGISTRY = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
export const TOPIC = "0.0.4567";
export const DOMAIN = { chainId: NETWORK.chainId, verifyingContract: REGISTRY };

export const b32 = (label: string) => keccak256(toUtf8Bytes(label)) as Hex;

/** Unix seconds of the issuance block. */
export const ISSUED_AT = 1_767_225_600n;
export const REVOKED_AT = ISSUED_AT + 600n;

export function makeCredentialEvent(overrides: Partial<CredentialEvent> = {}): CredentialEvent {
  return {
    version: 1,
    issuer: b32("acme-university"),
    externalCredentialId: b32("diploma:2026:0001"),
    credentialHash: b32("credential-document-v1"),
    subjectCommitment: b32("salted-subject-commitment"),
    schemaId: b32("schema:diploma:v1"),
    signedAt: ISSUED_AT - 5n,
    validUntil: ISSUED_AT + 600n,
    submitter: "0x0000000000000000000000000000000000000000",
    ...overrides,
  };
}

export const CREDENTIAL_ID = computeCredentialId(
  makeCredentialEvent().issuer,
  makeCredentialEvent().externalCredentialId,
);

export function makeRevocation(overrides: Partial<CredentialRevocation> = {}): CredentialRevocation {
  return {
    version: 1,
    credentialId: CREDENTIAL_ID,
    issuer: makeCredentialEvent().issuer,
    reasonCode: b32("reason:superseded"),
    signedAt: REVOKED_AT - 5n,
    ...overrides,
  };
}

export const signIssuance = (event: CredentialEvent, signer = ISSUER_SIGNER, domain = DOMAIN) =>
  signer.signTypedData(credentialDomain(domain), CREDENTIAL_EVENT_TYPES, event);

export const signRevocation = (revocation: CredentialRevocation, signer = ISSUER_SIGNER, domain = DOMAIN) =>
  signer.signTypedData(credentialDomain(domain), CREDENTIAL_REVOCATION_TYPES, revocation);

// ---------------------------------------------------------------------------------------------------------------------
// Fake Mirror Node + JSON-RPC
// ---------------------------------------------------------------------------------------------------------------------

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
  /** Forced HTTP status for requests whose URL contains the key (e.g. `{"/topics/": 503}`). */
  failures?: Record<string, number>;
  /** `true` makes every request throw (network down). */
  offline?: boolean;
}

export const NOT_FOUND_RECORD: FakeRecord = {
  status: 0,
  issuer: ZeroHash,
  credentialHash: ZeroHash,
  subjectCommitment: ZeroHash,
  signer: "0x0000000000000000000000000000000000000000",
  issuedAt: 0n,
  revokedAt: 0n,
};

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

const messageJson = (m: FakeMessage) => ({
  consensus_timestamp: m.consensusTimestamp,
  message: Buffer.from(m.bytes).toString("base64"),
  payer_account_id: m.payer ?? "0.0.1001",
  running_hash: Buffer.from("ab".repeat(48), "hex").toString("base64"),
  sequence_number: Number(m.sequence),
  topic_id: TOPIC,
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

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (world.offline) throw new TypeError("fetch failed");
    for (const [needle, status] of Object.entries(world.failures ?? {})) {
      if (url.href.includes(needle)) return json({ _status: { messages: [{ message: "forced" }] } }, status);
    }

    if (init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as { params: [{ data: string }] };
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
      return json(messageJson(m));
    }
    match = /^\/topics\/([^/]+)\/messages$/.exec(path);
    if (match) {
      const { gte, lte } = range(url.searchParams);
      const messages = world.messages
        .filter(m => inRange(m.consensusTimestamp, gte, lte) && visible(`list:${m.sequence}`, m.visibleAfterReads))
        .map(messageJson);
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
          address: REGISTRY,
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

// ---------------------------------------------------------------------------------------------------------------------
// Scenario: a consistent issuance (and optionally revocation), from which tests remove or corrupt one piece
// ---------------------------------------------------------------------------------------------------------------------

export const ISSUANCE_SEQUENCE = 5n;
export const REVOCATION_SEQUENCE = 9n;
export const HCS_ISSUANCE_TS = `${ISSUED_AT - 3n}.100000000`;
export const ISSUED_TX_TS = `${ISSUED_AT}.200000000`;
export const HCS_REVOCATION_TS = `${REVOKED_AT - 3n}.100000000`;
export const REVOKED_TX_TS = `${REVOKED_AT}.200000000`;
export const ISSUED_TX_HASH = `0x${"a1".repeat(32)}`;
export const REVOKED_TX_HASH = `0x${"b2".repeat(32)}`;

export const nsOf = (ts: string) => {
  const [s, n] = ts.split(".");
  return BigInt(s) * 1_000_000_000n + BigInt(n);
};

export function issuedLog(
  event: CredentialEvent,
  opts: { signer?: string; digest?: string; hcsSequence?: bigint; hcsTs?: string; ts?: string; txHash?: string } = {},
): FakeLog {
  const credentialId = computeCredentialId(event.issuer, event.externalCredentialId);
  const encoded = REGISTRY_IFACE.encodeEventLog("CredentialIssued", [
    credentialId,
    event.issuer,
    event.subjectCommitment,
    event.credentialHash,
    event.schemaId,
    opts.digest ?? computeCredentialDigest(event, DOMAIN),
    opts.signer ?? ISSUER_SIGNER.address,
    event.signedAt,
    opts.hcsSequence ?? ISSUANCE_SEQUENCE,
    nsOf(opts.hcsTs ?? HCS_ISSUANCE_TS),
  ]);
  return {
    topics: encoded.topics.map(t => t.toLowerCase()),
    data: encoded.data,
    consensusTimestamp: opts.ts ?? ISSUED_TX_TS,
    transactionHash: opts.txHash ?? ISSUED_TX_HASH,
  };
}

export function revokedLog(
  opts: { revokedBy?: string; byAdmin?: boolean; ts?: string; credentialId?: string } = {},
): FakeLog {
  const encoded = REGISTRY_IFACE.encodeEventLog("CredentialRevoked", [
    opts.credentialId ?? CREDENTIAL_ID,
    makeCredentialEvent().issuer,
    opts.revokedBy ?? ISSUER_SIGNER.address,
    opts.byAdmin ?? false,
    REVOKED_AT,
  ]);
  return {
    topics: encoded.topics.map(t => t.toLowerCase()),
    data: encoded.data,
    consensusTimestamp: opts.ts ?? REVOKED_TX_TS,
    transactionHash: REVOKED_TX_HASH,
  };
}

export function recordOf(event: CredentialEvent, status: 1 | 2 = 1, signer = ISSUER_SIGNER.address): FakeRecord {
  return {
    status,
    issuer: event.issuer,
    credentialHash: event.credentialHash,
    subjectCommitment: event.subjectCommitment,
    signer,
    issuedAt: ISSUED_AT,
    revokedAt: status === 2 ? REVOKED_AT : 0n,
  };
}

export async function issuanceMessage(
  event = makeCredentialEvent(),
  opts: { sequence?: bigint; ts?: string; signer?: Wallet } = {},
): Promise<FakeMessage> {
  return {
    sequence: opts.sequence ?? ISSUANCE_SEQUENCE,
    consensusTimestamp: opts.ts ?? HCS_ISSUANCE_TS,
    bytes: encodeCredentialMessage({ kind: "issuance", event, signature: await signIssuance(event, opts.signer) }),
  };
}

export async function revocationMessage(
  revocation = makeRevocation(),
  opts: { sequence?: bigint; ts?: string; signer?: Wallet } = {},
): Promise<FakeMessage> {
  return {
    sequence: opts.sequence ?? REVOCATION_SEQUENCE,
    consensusTimestamp: opts.ts ?? HCS_REVOCATION_TS,
    bytes: encodeCredentialMessage({
      kind: "revocation",
      revocation,
      signature: await signRevocation(revocation, opts.signer),
    }),
  };
}

/** A fully consistent world: issuance (and revocation when `revoked`). */
export async function consistentWorld(revoked = false): Promise<FakeWorld> {
  const event = makeCredentialEvent();
  const world: FakeWorld = {
    messages: [await issuanceMessage(event)],
    logs: [issuedLog(event)],
    records: new Map([[CREDENTIAL_ID, recordOf(event, revoked ? 2 : 1)]]),
  };
  if (revoked) {
    world.messages.push(await revocationMessage());
    world.logs.push(revokedLog());
  }
  return world;
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
  const clock = virtualClock(Number((overrides.nowSeconds ?? REVOKED_AT + 30n) * 1000n));
  const ctx: CredentialAuditContext = {
    network: NETWORK,
    registryAddress: REGISTRY,
    topicId: TOPIC,
    mirror: createCredentialMirror(NETWORK, { fetch }),
    registry: createCredentialStatusReader({ network: NETWORK, registryAddress: REGISTRY, fetch }),
    pollTimeoutMs: 5_000,
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  };
  return { ctx, calls, clock };
}
