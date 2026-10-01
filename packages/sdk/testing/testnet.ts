/**
 * A deterministic, in-memory Hedera Testnet for end-to-end flows (`yarn verify:testnet`): a JSON-RPC relay backed by an
 * in-memory `CredentialRegistry` (the contract's checks, errors and events, from the generated ABI), the in-memory HCS
 * topic and the fake Mirror Node of this package, the operator account of `network.ts`, and a virtual clock that moves
 * one second per consensus event. Signed transactions are decoded and executed; reverts answer like the relay
 * (`code 3`, revert `data`). Nothing reaches a network.
 */
import { Interface, Transaction, ZeroAddress, keccak256, toUtf8Bytes, verifyTypedData } from "ethers";
import {
  CREDENTIAL_EVENT_TYPES,
  computeCredentialDigest,
  computeCredentialId,
  credentialDomain,
} from "../hedera/hcs/credential-envelope";
import type { CredentialEvent } from "../hedera/hcs/credential-envelope";
import type { Hex } from "../hedera/hcs/envelope";
import { NETWORKS } from "../hedera/networks";
import { CredentialRegistryAbi } from "../generated";
import { DOMAIN, NOT_FOUND_RECORD, REGISTRY, TOPIC, issuedLog } from "./credentials";
import { createInMemoryTopic } from "./hcs";
import { fakeFetch, virtualClock } from "./mirror";
import type { FakeRecord, FakeWorld } from "./mirror";
import { HBAR, HEALTH_ACCOUNT, HEALTH_SECRET_KEY, fakeHederaNetwork } from "./network";

const IFACE = new Interface(CredentialRegistryAbi);
export const ADMIN_ROLE = keccak256(toUtf8Bytes("ADMIN_ROLE"));
const RELAY_HOST = new URL(NETWORKS.testnet.rpcUrl).host;

/** Environment of the fake Testnet: the operator of `network.ts`, the fixture topic and registry. */
export const testnetEnv = {
  HEDERA_NETWORK: "testnet",
  HEDERA_OPERATOR_ID: HEALTH_ACCOUNT,
  HEDERA_OPERATOR_KEY: HEALTH_SECRET_KEY,
  HEDERA_HCS_TOPIC_ID: TOPIC,
  HEDERA_CREDENTIAL_REGISTRY_ADDRESS: REGISTRY,
};

export interface FakeIssuer {
  signer: string;
  active?: boolean;
  maxValidity?: bigint;
}

export interface FakeTestnetOptions {
  /** Holder of `ADMIN_ROLE`. */
  admin?: string;
  issuers?: Record<string, FakeIssuer>;
  startMs?: number;
  balanceTinybars?: bigint;
  gasPriceWeibars?: bigint;
  /** Each HCS message and log is hidden from the Mirror Node for its first N reads (indexing lag). */
  mirrorLagReads?: number;
  /** JSON-RPC methods that fail at the transport level (the relay is down for them). */
  downMethods?: string[];
  /** USD per HBAR served by the exchange-rate endpoint; `null` makes it unavailable. */
  usdPerHbar?: number | null;
}

class Revert extends Error {
  constructor(readonly data: string) {
    super("execution reverted");
  }
}
const revert = (name: string, args: unknown[] = []) => new Revert(IFACE.encodeErrorResult(name, args));

const tsOf = (ms: number) => `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1_000_000).padStart(9, "0")}`;
const nsToTs = (ns: bigint) => `${ns / 1_000_000_000n}.${(ns % 1_000_000_000n).toString().padStart(9, "0")}`;

export function fakeTestnet(options: FakeTestnetOptions = {}) {
  const clock = virtualClock(options.startMs ?? Date.UTC(2026, 9, 1, 12, 0, 0));
  const tick = () => {
    clock.advance(1_000);
    return clock.now();
  };
  const world: FakeWorld = { messages: [], logs: [], records: new Map<string, FakeRecord>(), topicId: TOPIC };
  const topic = createInMemoryTopic(world, {
    payer: HEALTH_ACCOUNT,
    consensusAt: () => tsOf(tick()),
    visibleAfterReads: options.mirrorLagReads,
  });
  const admin = (options.admin ?? ZeroAddress).toLowerCase();
  const issuers = new Map<string, Required<FakeIssuer>>(
    Object.entries(options.issuers ?? {}).map(([id, cfg]) => [
      id.toLowerCase(),
      { signer: cfg.signer.toLowerCase(), active: cfg.active ?? true, maxValidity: cfg.maxValidity ?? 900n },
    ]),
  );
  const receipts = new Map<string, { status: string; blockNumber: string; from: string }>();
  const nonces = new Map<string, number>();
  const transactions: { method: string; from: string; hash: string; status: string }[] = [];
  const rpcCalls: string[] = [];

  /** Executes one registry call as `from`. `apply` commits state and events (a sent transaction). */
  function execute(from: string, data: string, apply: { hash: string } | null): string {
    const parsed = IFACE.parseTransaction({ data });
    if (!parsed) throw revert("InvalidSignature");
    const nowS = BigInt(Math.floor(clock.now() / 1000));
    switch (parsed.name) {
      case "statusOf": {
        const r = world.records.get(String(parsed.args[0]).toLowerCase()) ?? NOT_FOUND_RECORD;
        return IFACE.encodeFunctionResult("statusOf", [
          [r.issuer, r.credentialHash, r.subjectCommitment, r.signer, r.issuedAt, r.revokedAt, r.status],
        ]);
      }
      case "issuerOf": {
        const cfg = issuers.get(String(parsed.args[0]).toLowerCase());
        return IFACE.encodeFunctionResult("issuerOf", [
          [cfg?.signer ?? ZeroAddress, cfg?.active ?? false, cfg?.maxValidity ?? 0n],
        ]);
      }
      case "hasRole":
        return IFACE.encodeFunctionResult("hasRole", [
          parsed.args[0] === ADMIN_ROLE && String(parsed.args[1]).toLowerCase() === admin,
        ]);
      case "registerIssuer": {
        if (from !== admin) throw revert("AccessControlUnauthorizedAccount", [from, ADMIN_ROLE]);
        const id = String(parsed.args[0]).toLowerCase();
        if (issuers.has(id)) throw revert("IssuerAlreadyRegistered", [id]);
        if (apply)
          issuers.set(id, { signer: String(parsed.args[1]).toLowerCase(), active: true, maxValidity: parsed.args[2] });
        return "0x";
      }
      case "issue": {
        const [e, signature, hcs] = parsed.args;
        const event: CredentialEvent = {
          version: Number(e.version),
          issuer: String(e.issuer).toLowerCase() as Hex,
          externalCredentialId: String(e.externalCredentialId).toLowerCase() as Hex,
          credentialHash: String(e.credentialHash).toLowerCase() as Hex,
          subjectCommitment: String(e.subjectCommitment).toLowerCase() as Hex,
          schemaId: String(e.schemaId).toLowerCase() as Hex,
          signedAt: BigInt(e.signedAt),
          validUntil: BigInt(e.validUntil),
          submitter: String(e.submitter).toLowerCase() as Hex,
        };
        if (event.submitter !== ZeroAddress && event.submitter !== from) {
          throw revert("SubmitterMismatch", [event.submitter, from]);
        }
        const cfg = issuers.get(event.issuer);
        if (!cfg) throw revert("UnknownIssuer", [event.issuer]);
        if (!cfg.active) throw revert("InactiveIssuer", [event.issuer]);
        const recovered = verifyTypedData(
          credentialDomain(DOMAIN),
          CREDENTIAL_EVENT_TYPES,
          event,
          signature,
        ).toLowerCase();
        if (recovered !== cfg.signer) throw revert("UnauthorizedSigner", [recovered, cfg.signer]);
        const id = computeCredentialId(event.issuer, event.externalCredentialId);
        const existing = world.records.get(id);
        if (existing) {
          if (
            existing.credentialHash === event.credentialHash &&
            existing.subjectCommitment === event.subjectCommitment
          ) {
            throw revert("AlreadyIssued", [id, existing.issuedAt]);
          }
          throw revert("ConflictingCredential", [id, existing.credentialHash, event.credentialHash]);
        }
        if (nowS > event.validUntil) throw revert("Expired", [event.validUntil, nowS]);
        if (apply) {
          world.records.set(id, {
            status: 1,
            issuer: event.issuer,
            credentialHash: event.credentialHash,
            subjectCommitment: event.subjectCommitment,
            signer: recovered,
            issuedAt: nowS,
            revokedAt: 0n,
          });
          world.logs.push({
            ...issuedLog(event, {
              signer: recovered,
              digest: computeCredentialDigest(event, DOMAIN),
              hcsSequence: BigInt(hcs.sequence),
              hcsTs: nsToTs(BigInt(hcs.consensusTimestampNs)),
              ts: tsOf(clock.now()),
              txHash: apply.hash,
            }),
            visibleAfterReads: options.mirrorLagReads,
          });
        }
        return IFACE.encodeFunctionResult("issue", [id]);
      }
      case "revoke": {
        const id = String(parsed.args[0]).toLowerCase();
        const record = world.records.get(id);
        if (!record) throw revert("UnknownCredential", [id]);
        if (record.status === 2) throw revert("AlreadyRevoked", [id, record.revokedAt]);
        const cfg = issuers.get(record.issuer.toLowerCase());
        const byIssuer = Boolean(cfg?.active && cfg.signer === from);
        const byAdmin = !byIssuer && from === admin;
        if (!byIssuer && !byAdmin) throw revert("UnauthorizedRevoker", [id, from]);
        if (apply) {
          record.status = 2;
          record.revokedAt = nowS;
          const encoded = IFACE.encodeEventLog("CredentialRevoked", [id, record.issuer, from, byAdmin, nowS]);
          world.logs.push({
            topics: encoded.topics.map(t => t.toLowerCase()),
            data: encoded.data,
            consensusTimestamp: tsOf(clock.now()),
            transactionHash: apply.hash,
            visibleAfterReads: options.mirrorLagReads,
          });
        }
        return "0x";
      }
      default:
        throw new Error(`fake registry: unexpected ${parsed.name}`);
    }
  }

  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    rpcCalls.push(method);
    if (options.downMethods?.includes(method)) throw new TypeError("fetch failed");
    switch (method) {
      case "eth_chainId":
        return `0x${NETWORKS.testnet.chainId.toString(16)}`;
      case "eth_gasPrice":
        return `0x${(options.gasPriceWeibars ?? 710_000_000_000n).toString(16)}`;
      case "eth_getTransactionCount":
        return `0x${(nonces.get(String(params[0]).toLowerCase()) ?? 0).toString(16)}`;
      case "eth_call":
      case "eth_estimateGas": {
        const tx = params[0] as { from?: string; data: string };
        const result = execute((tx.from ?? ZeroAddress).toLowerCase(), tx.data, null);
        return method === "eth_call" ? result : "0x30d40";
      }
      case "eth_sendRawTransaction": {
        const tx = Transaction.from(String(params[0]));
        const from = tx.from!.toLowerCase();
        const hash = tx.hash!.toLowerCase();
        nonces.set(from, (nonces.get(from) ?? 0) + 1);
        tick();
        let status = "0x1";
        try {
          execute(from, tx.data, { hash });
        } catch (error) {
          if (!(error instanceof Revert)) throw error;
          status = "0x0";
        }
        const name = IFACE.parseTransaction({ data: tx.data })?.name ?? "unknown";
        transactions.push({ method: name, from, hash, status });
        receipts.set(hash, { status, blockNumber: `0x${transactions.length.toString(16)}`, from });
        return hash;
      }
      case "eth_getTransactionReceipt":
        return receipts.get(String(params[0]).toLowerCase()) ?? null;
      default:
        throw new Error(`fake relay: unexpected ${method}`);
    }
  }

  const mirror = fakeFetch(world);
  const accounts = fakeHederaNetwork({ balance: options.balanceTinybars ?? 1_000n * HBAR });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === RELAY_HOST && init?.method === "POST") {
      const request = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] };
      try {
        return json({ jsonrpc: "2.0", id: request.id, result: await rpc(request.method, request.params ?? []) });
      } catch (error) {
        if (error instanceof Revert) {
          return json({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: 3, message: "execution reverted", data: error.data },
          });
        }
        throw error;
      }
    }
    if (url.pathname === "/api/v1/network/exchangerate") {
      const rate = options.usdPerHbar === undefined ? 0.12 : options.usdPerHbar;
      if (rate === null) return new Response("{}", { status: 503 });
      return json({ current_rate: { cent_equivalent: Math.round(rate * 10_000), hbar_equivalent: 100 } });
    }
    if (url.pathname.startsWith("/api/v1/accounts/") || url.pathname === "/api/v1/blocks") {
      return accounts.fetch(input, init);
    }
    return mirror.fetch(input, init);
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    world,
    topic,
    clock,
    issuers,
    transactions,
    rpcCalls,
    mirrorCalls: mirror.calls,
  };
}
