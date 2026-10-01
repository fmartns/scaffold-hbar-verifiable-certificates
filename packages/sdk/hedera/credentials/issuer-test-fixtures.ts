/**
 * Deterministic fixtures of the issuer console: a fixed issuer key, a fake EIP-1193 wallet that signs for real, a fake
 * registry behind JSON-RPC and a fake HCS transport. No network, no clock.
 */
import { Interface, TypedDataEncoder, Wallet } from "ethers";
import { CREDENTIAL_REGISTRY_ABI } from "../audit/registry";
import type { HcsTransport, TransportReceipt } from "../hcs/publisher";
import { NETWORKS } from "../networks";
import { CREDENTIAL_SCHEMA_PRESETS } from "./fields";
import type { CredentialDraftInput } from "./fields";
import { CREDENTIAL_REGISTRY_ISSUER_ABI } from "./registry-calls";
import type { CredentialPublishReceipt, CredentialStatusView, Eip1193Like, IssuerBackend } from "./issuer-flow";

export const ISSUER_KEY = `0x${"1c".repeat(32)}`;
export const ISSUER_WALLET = new Wallet(ISSUER_KEY);
export const ISSUER_ADDRESS = ISSUER_WALLET.address.toLowerCase();
export const OTHER_WALLET = new Wallet(`0x${"2d".repeat(32)}`);
export const REGISTRY_ADDRESS = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
export const TOPIC_ID = "0.0.4567";
export const CHAIN_ID = NETWORKS.testnet.chainId;
export const NOW_MS = Date.UTC(2026, 9, 1, 12, 0, 0);
export const TX_HASH = `0x${"ab".repeat(32)}`;

export const DRAFT_INPUT: CredentialDraftInput = {
  issuerName: "acme-university",
  schema: CREDENTIAL_SCHEMA_PRESETS[1].descriptor,
  reference: "ENR-2026-0042",
  subjectIdType: "email",
  subjectIdValue: "maria.silva@example.com",
  issuedOn: "2026-09-21",
  expiresOn: "",
  claims: {
    courseCode: "CS-301",
    courseName: "Distributed Ledgers",
    completedOn: "2026-09-20",
    hours: "60",
    grade: "A",
  },
  validitySeconds: 600,
};

export const ENV = {
  HEDERA_NETWORK: "testnet",
  HEDERA_HCS_TOPIC_ID: TOPIC_ID,
  HEDERA_CREDENTIAL_REGISTRY_ADDRESS: REGISTRY_ADDRESS,
  HEDERA_OPERATOR_ID: "0.0.1001",
  HEDERA_OPERATOR_KEY: `302e020100300506032b657004220420${"aa".repeat(32)}`,
};

const ISSUER_ABI = new Interface(CREDENTIAL_REGISTRY_ISSUER_ABI);
const READ_ABI = new Interface(CREDENTIAL_REGISTRY_ABI);

export const revertData = (name: string, args: unknown[] = []) => ISSUER_ABI.encodeErrorResult(name, args);

/** A JSON-RPC error carrying revert data, shaped like MetaMask's. */
export const revertError = (name: string, args: unknown[] = []) =>
  Object.assign(new Error("execution reverted"), { code: -32603, data: { data: revertData(name, args) } });

export interface FakeWalletOptions {
  accounts?: string[];
  chainId?: string;
  wallet?: Wallet;
  /** Overrides per method; a function result is awaited, an Error is thrown. */
  overrides?: Record<string, unknown>;
  receipts?: (unknown | Error)[];
}

/** EIP-1193 wallet that signs typed data with a real key. Records every call in order. */
export function fakeWallet(options: FakeWalletOptions = {}) {
  const calls: { method: string; params?: unknown[] }[] = [];
  const wallet = options.wallet ?? ISSUER_WALLET;
  const receipts = [...(options.receipts ?? [{ status: "0x1", blockNumber: "0x10", from: ISSUER_ADDRESS }])];
  const provider: Eip1193Like = {
    async request({ method, params }) {
      calls.push({ method, params });
      const override = options.overrides?.[method];
      if (override instanceof Error) throw override;
      if (typeof override === "function") return (override as (p?: unknown[]) => unknown)(params);
      if (override !== undefined) return override;
      switch (method) {
        case "eth_accounts":
          return options.accounts ?? [ISSUER_ADDRESS];
        case "eth_chainId":
          return options.chainId ?? `0x${CHAIN_ID.toString(16)}`;
        case "eth_signTypedData_v4": {
          const payload = JSON.parse(String(params?.[1]));
          const types = { ...payload.types };
          delete types.EIP712Domain;
          return wallet.signTypedData(payload.domain, types, payload.message);
        }
        case "eth_call":
          return "0x";
        case "eth_sendTransaction":
          return TX_HASH;
        case "eth_getTransactionReceipt": {
          const next = receipts.length > 1 ? receipts.shift() : receipts[0];
          if (next instanceof Error) throw next;
          return next;
        }
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  return { provider, calls, methods: () => calls.map(c => c.method) };
}

export function publishReceipt(overrides: Partial<CredentialPublishReceipt> = {}): CredentialPublishReceipt {
  return {
    kind: "issuance",
    credentialId: `0x${"11".repeat(32)}`,
    digest: `0x${"22".repeat(32)}`,
    signer: ISSUER_ADDRESS as `0x${string}`,
    topicId: TOPIC_ID,
    network: "testnet",
    transactionId: "0.0.1001@1790000000.000000001",
    mirrorTransactionId: "0.0.1001-1790000000-000000001",
    hcsRef: { sequence: "42", consensusTimestampNs: "1790000001000000002" },
    consensusTimestamp: "1790000001.000000002",
    hashscanUrl: "https://hashscan.io/testnet/transaction/1790000001.000000002",
    hashscanTopicUrl: `https://hashscan.io/testnet/topic/${TOPIC_ID}`,
    mirrorMessageUrl: `https://testnet.mirrornode.hedera.com/api/v1/topics/${TOPIC_ID}/messages/42`,
    messageSha256: `0x${"33".repeat(32)}`,
    recordedAt: new Date(NOW_MS).toISOString(),
    ...overrides,
  };
}

export function fakeBackend(
  options: { publish?: () => Promise<CredentialPublishReceipt>; status?: Partial<CredentialStatusView> } = {},
) {
  const published: unknown[] = [];
  const backend: IssuerBackend = {
    async publish(request) {
      published.push(request);
      return options.publish ? options.publish() : publishReceipt({ kind: request.kind });
    },
    async status(credentialId) {
      return {
        credentialId: credentialId as `0x${string}`,
        status: "issued",
        issuer: `0x${"44".repeat(32)}`,
        signer: ISSUER_ADDRESS as `0x${string}`,
        issuedAt: "1790000000",
        revokedAt: "0",
        ...options.status,
      };
    },
  };
  return { backend, published };
}

export interface RegistryState {
  issuers?: Record<string, { signer: string; active: boolean }>;
  records?: Record<string, { status: 0 | 1 | 2; issuer: string; revokedAt?: number }>;
  /** Makes every eth_call fail at the transport level. */
  down?: boolean;
}

/** `fetch` answering `eth_call` on the registry like the relay would. */
export function fakeRelay(state: RegistryState) {
  const calls: string[] = [];
  const fetchImpl = (async (_url: string, init?: { body?: string }) => {
    if (state.down) throw new TypeError("fetch failed");
    const body = JSON.parse(init?.body ?? "{}");
    const data: string = body.params?.[0]?.data ?? "";
    const selector = data.slice(0, 10);
    let result = "0x";
    if (selector === ISSUER_ABI.getFunction("issuerOf")!.selector) {
      calls.push("issuerOf");
      const [issuer] = ISSUER_ABI.decodeFunctionData("issuerOf", data);
      const cfg = state.issuers?.[String(issuer).toLowerCase()];
      result = ISSUER_ABI.encodeFunctionResult("issuerOf", [
        [cfg?.signer ?? "0x0000000000000000000000000000000000000000", cfg?.active ?? false, 900n],
      ]);
    } else if (selector === READ_ABI.getFunction("statusOf")!.selector) {
      calls.push("statusOf");
      const [id] = READ_ABI.decodeFunctionData("statusOf", data);
      const rec = state.records?.[String(id).toLowerCase()];
      const zero = `0x${"0".repeat(64)}`;
      result = READ_ABI.encodeFunctionResult("statusOf", [
        [
          rec?.issuer ?? zero,
          zero,
          zero,
          "0x0000000000000000000000000000000000000000",
          rec ? 1790000000n : 0n,
          BigInt(rec?.revokedAt ?? 0),
          rec?.status ?? 0,
        ],
      ]);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export function fakeTransport(outcome: Partial<TransportReceipt> | Error = {}) {
  const submitted: Uint8Array[] = [];
  const transport: HcsTransport = {
    async submit(request) {
      submitted.push(request.message);
      request.onTransactionId("0.0.1001@1790000000.000000001");
      if (outcome instanceof Error) throw outcome;
      return {
        transactionId: "0.0.1001@1790000000.000000001",
        sequenceNumber: "42",
        runningHash: "ab".repeat(48),
        consensusTimestamp: "1790000001.000000002",
        ...outcome,
      };
    },
  };
  return { transport, submitted };
}

/** Signs a draft event like a wallet would, for server tests. */
export async function signEvent(
  event: Parameters<typeof TypedDataEncoder.hash>[2],
  types: Parameters<typeof TypedDataEncoder.hash>[1],
  wallet: Wallet = ISSUER_WALLET,
) {
  return wallet.signTypedData(
    { name: "HederaVerifiableCredentials", version: "1", chainId: CHAIN_ID, verifyingContract: REGISTRY_ADDRESS },
    types,
    event,
  );
}
