import { Interface, Wallet } from "ethers";
import type { CredentialAuditReportJson, IssuerConsoleSettings, IssuerError } from "@sh/sdk/hedera/wallet";
import { CREDENTIAL_REGISTRY_ISSUER_ABI, walletTarget } from "@sh/sdk/hedera/wallet";

export const ISSUER = new Wallet(`0x${"1c".repeat(32)}`);
export const ACCOUNT = ISSUER.address.toLowerCase();
export const REGISTRY = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
export const TX_HASH = `0x${"ab".repeat(32)}`;
export const CREDENTIAL_ID = `0x${"11".repeat(32)}`;

export const SETTINGS: IssuerConsoleSettings = {
  configured: true,
  issues: [],
  network: "testnet",
  chainId: 296,
  registryAddress: REGISTRY,
  topicId: "0.0.4567",
  hashscanUrl: "https://hashscan.io/testnet",
};

export const TARGET = walletTarget("testnet");

const registry = new Interface(CREDENTIAL_REGISTRY_ISSUER_ABI);
export const revert = (name: string, args: unknown[] = []) =>
  Object.assign(new Error("execution reverted"), {
    code: -32603,
    data: { data: registry.encodeErrorResult(name, args) },
  });

/** An injected EIP-1193 wallet that signs for real; `overrides` replace a method's answer (an Error is thrown). */
export function installWallet(
  options: { accounts?: string[]; chainId?: string; overrides?: Record<string, unknown>; receipt?: unknown } = {},
) {
  const calls: string[] = [];
  const ethereum = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      calls.push(method);
      const override = options.overrides?.[method];
      if (override instanceof Error) throw override;
      if (typeof override === "function") return override(params);
      if (override !== undefined) return override;
      switch (method) {
        case "eth_accounts":
        case "eth_requestAccounts":
          return options.accounts ?? [ACCOUNT];
        case "eth_chainId":
          return options.chainId ?? "0x128";
        case "eth_signTypedData_v4": {
          const payload = JSON.parse(String(params?.[1]));
          const types = { ...payload.types };
          delete types.EIP712Domain;
          return ISSUER.signTypedData(payload.domain, types, payload.message);
        }
        case "eth_call":
          return "0x";
        case "eth_sendTransaction":
          return TX_HASH;
        case "eth_getTransactionReceipt":
          return options.receipt === undefined
            ? { status: "0x1", blockNumber: "0x10", from: ACCOUNT }
            : options.receipt;
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
    on() {},
    removeListener() {},
  };
  (window as unknown as { ethereum?: unknown }).ethereum = ethereum;
  return { calls };
}

export function uninstallWallet() {
  delete (window as unknown as { ethereum?: unknown }).ethereum;
}

export const receipt = (kind: "issuance" | "revocation", credentialId = CREDENTIAL_ID) => ({
  kind,
  credentialId,
  digest: `0x${"22".repeat(32)}`,
  signer: ACCOUNT,
  topicId: "0.0.4567",
  network: "testnet",
  transactionId: "0.0.1001@1790000000.000000001",
  mirrorTransactionId: "0.0.1001-1790000000-000000001",
  hcsRef: { sequence: "42", consensusTimestampNs: "1790000001000000002" },
  consensusTimestamp: "1790000001.000000002",
  hashscanUrl: "https://hashscan.io/testnet/transaction/1790000001.000000002",
  hashscanTopicUrl: "https://hashscan.io/testnet/topic/0.0.4567",
  mirrorMessageUrl: "https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.4567/messages/42",
  messageSha256: `0x${"33".repeat(32)}`,
  recordedAt: "2026-10-01T12:00:00.000Z",
});

export function auditReport(overrides: Partial<CredentialAuditReportJson> = {}): CredentialAuditReportJson {
  return {
    credentialId: CREDENTIAL_ID as `0x${string}`,
    subject: { kind: "credential" },
    onChain: { status: "issued", record: null },
    evidence: "consistent",
    issuance: {
      hcs: null,
      onChain: {
        transactionHash: TX_HASH,
        consensusTimestamp: "1790000005.000000001",
        hashscanUrl: "https://hashscan.io/testnet/transaction/1790000005.000000001",
        signer: ACCOUNT as `0x${string}`,
        attestationDigest: `0x${"22".repeat(32)}`,
        schemaId: `0x${"55".repeat(32)}`,
        hcsSequence: "42",
        hcsConsensusTimestampNs: "1790000001000000002",
      },
      matched: true,
    },
    revocation: null,
    timeline: [
      {
        step: "hcs.issuance",
        consensusTimestamp: "1790000001.000000002",
        reference: "0.0.4567#42",
        hashscanUrl: "https://hashscan.io/testnet/transaction/1790000001.000000002",
      },
      {
        step: "chain.issued",
        consensusTimestamp: "1790000005.000000001",
        reference: TX_HASH,
        hashscanUrl: "https://hashscan.io/testnet/transaction/1790000005.000000001",
      },
    ],
    findings: [],
    provenance: {
      network: "testnet",
      mirrorNode: "https://testnet.mirrornode.hedera.com",
      rpc: "https://testnet.hashio.io",
      registryAddress: REGISTRY,
      topicId: "0.0.4567",
      queriedAt: "2026-10-01T12:00:10.000Z",
      highestConsensusTimestampSeen: "1790000005.000000001",
    },
    ...overrides,
  };
}

type Route = { status?: number; body: unknown } | Error;

/** `fetch` for the console API: one handler per path, recorded in order. */
export function fakeApi(routes: { publish?: Route | Route[]; status?: Route; audit?: Route }) {
  const requests: { path: string; body: unknown }[] = [];
  const queue = Array.isArray(routes.publish) ? [...routes.publish] : null;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0].replace("/api/credentials/", "");
    requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    const route: Route | undefined =
      path === "publish" ? (queue ? queue.shift() : (routes.publish as Route)) : routes[path as "status" | "audit"];
    if (!route) throw new Error(`no route for ${path}`);
    if (route instanceof Error) throw route;
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

export const ok = (value: unknown) => ({ status: 200, body: { ok: true, value } });
export const fail = (status: number, error: IssuerError) => ({ status, body: { ok: false, error } });
