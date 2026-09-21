/**
 * Read-only Mirror Node access for the HTS adapter, through an injectable `fetch`. Mirror Node is eventually consistent
 * (ADR §3.8): a missing record is not proof of absence, and callers must treat these answers as preflight and
 * reconciliation evidence, never as the enforcement of a guarantee.
 * Token balances can exceed 2^53, so they are read from the raw text and carried as bigint.
 */
import type { HederaNetwork } from "../networks";
import { HtsError } from "./errors";
import { parseSettlementMemo } from "./settlement";
import type { SettlementStep } from "./settlement";

export interface MirrorKey {
  /** `ED25519`, `ECDSA_SECP256K1` or `ProtobufEncoded` (contract-id, key list, threshold...). */
  type: string;
  key: string;
}

export interface TokenInfo {
  tokenId: string;
  type: string;
  deleted: boolean;
  paused: boolean;
  supplyType: "INFINITE" | "FINITE";
  maxSupply: bigint;
  totalSupply: bigint;
  treasuryAccountId: string;
  supplyKey: MirrorKey | null;
  kycKey: MirrorKey | null;
  freezeKey: MirrorKey | null;
  freezeDefault: boolean;
  decimals: number;
  symbol: string;
}

export interface TokenRelationship {
  balance: bigint;
  freezeStatus: "NOT_APPLICABLE" | "FROZEN" | "UNFROZEN";
  kycStatus: "NOT_APPLICABLE" | "GRANTED" | "REVOKED";
  automatic: boolean;
}

export interface AccountInfo {
  accountId: string;
  deleted: boolean;
  /** `-1` unlimited, `0` none: with a non-zero value a transfer may associate the token by itself. */
  maxAutomaticTokenAssociations: number;
  evmAddress: string | null;
}

export interface SettlementTransaction {
  step: SettlementStep;
  /** Mirror format `0.0.x-sss-nnn`. */
  transactionId: string;
  consensusTimestamp: string;
  result: string;
}

export interface MirrorTransaction {
  transactionId: string;
  consensusTimestamp: string;
  result: string;
  name: string;
}

export interface HtsMirror {
  getToken(tokenId: string): Promise<TokenInfo | null>;
  /** `null` when the account holds no relationship with the token (not associated). */
  getRelationship(accountId: string, tokenId: string): Promise<TokenRelationship | null>;
  /** Accepts an account id or an EVM address/alias. */
  getAccount(idOrAddress: string): Promise<AccountInfo | null>;
  /** Contract id (`0.0.x`) deployed at an EVM address, or `null`. */
  getContractId(evmAddress: string): Promise<string | null>;
  /** Transactions by `accountId` since `sinceSeconds` whose memo is a settlement memo of `eventKey`. */
  findSettlementTransactions(
    accountId: string,
    eventKey: string,
    sinceSeconds: number,
  ): Promise<SettlementTransaction[]>;
  getTransaction(mirrorTransactionId: string): Promise<MirrorTransaction | null>;
}

export interface MirrorOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const unavailable = (detail: string) =>
  new HtsError({
    code: "NETWORK_UNAVAILABLE",
    outcome: "not_sent",
    operation: "preflight",
    message: `Could not read from the Mirror Node (${detail}).`,
    remediation: "Check your connection and HEDERA_MIRROR_NODE_URL, then retry. Nothing was sent.",
    retryable: true,
  });

/** Wraps balances written as JSON numbers in quotes so values above 2^53 survive `JSON.parse`. */
const quoteBigBalances = (text: string) => text.replace(/("balance"\s*:\s*)(\d{16,})/g, '$1"$2"');

const bigint = (value: unknown): bigint => {
  try {
    return BigInt(String(value ?? "0"));
  } catch {
    return 0n;
  }
};

const key = (value: unknown): MirrorKey | null => {
  const k = value as { _type?: string; key?: string } | null | undefined;
  return k?.key ? { type: k._type ?? "unknown", key: k.key.toLowerCase() } : null;
};

export function createHtsMirror(network: HederaNetwork, options: MirrorOptions = {}): HtsMirror {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function get(path: string): Promise<unknown | null> {
    let response: Response;
    try {
      response = await fetchImpl(`${network.mirrorNodeUrl}/api/v1${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw unavailable("network error");
    }
    if (response.status === 404) return null;
    if (!response.ok) throw unavailable(`HTTP ${response.status}`);
    try {
      return JSON.parse(quoteBigBalances(await response.text()));
    } catch {
      throw unavailable("malformed answer");
    }
  }

  return {
    async getToken(tokenId) {
      const t = (await get(`/tokens/${tokenId}`)) as Record<string, unknown> | null;
      if (!t) return null;
      return {
        tokenId: String(t.token_id ?? tokenId),
        type: String(t.type ?? ""),
        deleted: t.deleted === true,
        paused: t.pause_status === "PAUSED",
        supplyType: t.supply_type === "FINITE" ? "FINITE" : "INFINITE",
        maxSupply: bigint(t.max_supply),
        totalSupply: bigint(t.total_supply),
        treasuryAccountId: String(t.treasury_account_id ?? ""),
        supplyKey: key(t.supply_key),
        kycKey: key(t.kyc_key),
        freezeKey: key(t.freeze_key),
        freezeDefault: t.freeze_default === true,
        decimals: Number(t.decimals ?? 0),
        symbol: String(t.symbol ?? ""),
      };
    },

    async getRelationship(accountId, tokenId) {
      const body = (await get(`/accounts/${accountId}/tokens?token.id=${tokenId}`)) as {
        tokens?: Record<string, unknown>[];
      } | null;
      const entry = body?.tokens?.find(t => t.token_id === tokenId);
      if (!entry) return null;
      return {
        balance: bigint(entry.balance),
        freezeStatus: (entry.freeze_status as TokenRelationship["freezeStatus"]) ?? "NOT_APPLICABLE",
        kycStatus: (entry.kyc_status as TokenRelationship["kycStatus"]) ?? "NOT_APPLICABLE",
        automatic: entry.automatic_association === true,
      };
    },

    async getAccount(idOrAddress) {
      const a = (await get(`/accounts/${idOrAddress}?transactions=false`)) as Record<string, unknown> | null;
      if (!a) return null;
      return {
        accountId: String(a.account ?? idOrAddress),
        deleted: a.deleted === true,
        maxAutomaticTokenAssociations: Number(a.max_automatic_token_associations ?? 0),
        evmAddress: typeof a.evm_address === "string" ? a.evm_address.toLowerCase() : null,
      };
    },

    async getContractId(evmAddress) {
      const c = (await get(`/contracts/${evmAddress}`)) as { contract_id?: string } | null;
      return c?.contract_id ?? null;
    },

    async findSettlementTransactions(accountId, eventKey, sinceSeconds) {
      const found: SettlementTransaction[] = [];
      let path: string | null =
        `/transactions?account.id=${accountId}&timestamp=gte:${sinceSeconds}&order=desc&limit=100`;
      for (let page = 0; path && page < 5; page++) {
        const body = (await get(path)) as {
          transactions?: {
            memo_base64?: string;
            transaction_id?: string;
            consensus_timestamp?: string;
            result?: string;
          }[];
          links?: { next?: string | null };
        } | null;
        for (const tx of body?.transactions ?? []) {
          const memo = tx.memo_base64 ? Buffer.from(tx.memo_base64, "base64").toString("utf8") : "";
          const parsed = parseSettlementMemo(memo);
          if (parsed && parsed.eventKey === eventKey.toLowerCase() && tx.transaction_id && tx.consensus_timestamp) {
            found.push({
              step: parsed.step,
              transactionId: tx.transaction_id,
              consensusTimestamp: tx.consensus_timestamp,
              result: tx.result ?? "UNKNOWN",
            });
          }
        }
        // `links.next` is a path that already carries the `/api/v1` prefix.
        path = body?.links?.next ? body.links.next.replace(/^\/api\/v1/, "") : null;
      }
      return found;
    },

    async getTransaction(mirrorTransactionId) {
      const body = (await get(`/transactions/${mirrorTransactionId}`)) as {
        transactions?: { transaction_id?: string; consensus_timestamp?: string; result?: string; name?: string }[];
      } | null;
      const tx = body?.transactions?.[0];
      if (!tx?.transaction_id || !tx.consensus_timestamp) return null;
      return {
        transactionId: tx.transaction_id,
        consensusTimestamp: tx.consensus_timestamp,
        result: tx.result ?? "UNKNOWN",
        name: tx.name ?? "",
      };
    },
  };
}
