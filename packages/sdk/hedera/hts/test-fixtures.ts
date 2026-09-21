/**
 * Deterministic fixtures for the HTS adapter tests. NOT exported from the package.
 * `world()` is a small in-memory Hedera: a Mirror Node view and an executor that share state, so operations really change
 * balances, supply and the transactions (with their memos) that reconciliation looks for.
 */
import { NETWORKS } from "../networks";
import type { HederaNetworkName } from "../networks";
import type { HtsAdapterConfig } from "./config";
import { HtsTimeoutError } from "./errors";
import type { HtsExecutor, StepReceipt, StepRequest } from "./executor";
import type { AccountInfo, HtsMirror, SettlementTransaction, TokenInfo, TokenRelationship } from "./mirror";
import { parseSettlementMemo } from "./settlement";
import type { SettlementInput } from "./settlement";
import { toMirrorTransactionId } from "../explorer";

export const OPERATOR = "0.0.1234";
export const TOKEN = "0.0.5555";
export const BENEFICIARY = "0.0.9001";
export const ROUTER_ADDRESS = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
export const ROUTER_CONTRACT = "0.0.7000";
export const OPERATOR_PUBLIC_KEY = "ab".repeat(32);
export const NOW = new Date("2026-01-01T00:00:00.000Z");

const hex32 = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
export const EVENT_KEY = hex32(0xa1);
export const SETTLEMENT_ID = hex32(0xb2);
export const CONTENT_HASH = hex32(0xc3);

export function makeInput(overrides: Partial<SettlementInput> = {}): SettlementInput {
  return {
    eventKey: EVENT_KEY,
    settlementId: SETTLEMENT_ID,
    contentHash: CONTENT_HASH,
    tokenId: TOKEN,
    beneficiary: BENEFICIARY,
    amount: 1000n,
    ...overrides,
  };
}

/** protobuf `Key{ contractID | delegatableContractId }` as Mirror Node shows it, for contract number `num` (< 2^28). */
export function contractKeyHex(num: number, delegatable = false): string {
  const varint: number[] = [];
  let n = num;
  do {
    const byte = n & 0x7f;
    n = Math.floor(n / 128);
    varint.push(n > 0 ? byte | 0x80 : byte);
  } while (n > 0);
  const inner = [0x18, ...varint];
  return Buffer.from([delegatable ? 0x42 : 0x0a, inner.length, ...inner]).toString("hex");
}

export function operatorConfig(
  overrides: Partial<Omit<HtsAdapterConfig, "network">> & { network?: HederaNetworkName } = {},
): HtsAdapterConfig {
  const { network = "testnet", ...rest } = overrides;
  return {
    network: NETWORKS[network],
    tokenId: TOKEN,
    model: "mint-transfer",
    custody: "operator",
    treasuryId: OPERATOR,
    operatorId: OPERATOR,
    ...rest,
  };
}

export function routerConfig(overrides: Partial<HtsAdapterConfig> = {}): HtsAdapterConfig {
  return {
    network: NETWORKS.testnet,
    tokenId: TOKEN,
    model: "mint-transfer",
    custody: "router",
    routerAddress: ROUTER_ADDRESS,
    ...overrides,
  };
}

export function tokenInfo(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    tokenId: TOKEN,
    type: "FUNGIBLE_COMMON",
    deleted: false,
    paused: false,
    supplyType: "INFINITE",
    maxSupply: 0n,
    totalSupply: 0n,
    treasuryAccountId: OPERATOR,
    supplyKey: { type: "ED25519", key: OPERATOR_PUBLIC_KEY },
    kycKey: null,
    freezeKey: null,
    freezeDefault: false,
    decimals: 2,
    symbol: "SETL",
    ...overrides,
  };
}

const relationship = (overrides: Partial<TokenRelationship> = {}): TokenRelationship => ({
  balance: 0n,
  freezeStatus: "NOT_APPLICABLE",
  kycStatus: "NOT_APPLICABLE",
  automatic: false,
  ...overrides,
});
export { relationship };

export interface WorldOptions {
  token?: Partial<TokenInfo> | null;
  /** Accounts that exist; the beneficiary exists (and does not auto-associate) by default. */
  accounts?: Record<string, Partial<AccountInfo>>;
  /** Accounts associated with the token, with their relationship. */
  associated?: Record<string, Partial<TokenRelationship>>;
  contracts?: Record<string, string>;
}

/** Errors the executor should throw, once, on the next call of a step. */
export interface Faults {
  associate?: Error | (() => Error);
  mint?: Error | (() => Error);
  transfer?: Error | (() => Error);
}

export function world(options: WorldOptions = {}) {
  let sequence = 0;
  const token: TokenInfo | null = options.token === null ? null : tokenInfo(options.token);
  const accounts: Record<string, AccountInfo> = {};
  const addAccount = (id: string, extra: Partial<AccountInfo> = {}) => {
    accounts[id] = { accountId: id, deleted: false, maxAutomaticTokenAssociations: 0, evmAddress: null, ...extra };
  };
  addAccount(OPERATOR);
  addAccount(BENEFICIARY);
  for (const [id, extra] of Object.entries(options.accounts ?? {})) addAccount(id, extra);
  const relationships = new Map<string, TokenRelationship>();
  const key = (account: string, tokenId = TOKEN) => `${account}|${tokenId}`;
  relationships.set(key(token?.treasuryAccountId ?? OPERATOR), relationship());
  relationships.set(key(BENEFICIARY), relationship());
  for (const [id, extra] of Object.entries(options.associated ?? {})) relationships.set(key(id), relationship(extra));
  // The beneficiary is associated unless a test removes it.
  const contracts = { [ROUTER_ADDRESS]: ROUTER_CONTRACT, ...(options.contracts ?? {}) };

  const transactions: SettlementTransaction[] = [];
  const hidden: SettlementTransaction[] = []; // applied on the ledger, not yet visible on Mirror (lag)
  const calls: { mirror: string[]; executor: string[] } = { mirror: [], executor: [] };
  const state = { mirrorDown: false, lag: false, faults: {} as Faults };

  const mirror: HtsMirror = {
    async getToken(tokenId) {
      calls.mirror.push(`getToken ${tokenId}`);
      if (state.mirrorDown) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return token && tokenId === token.tokenId ? { ...token } : null;
    },
    async getRelationship(accountId, tokenId) {
      calls.mirror.push(`getRelationship ${accountId} ${tokenId}`);
      const r = relationships.get(key(accountId, tokenId));
      return r ? { ...r } : null;
    },
    async getAccount(idOrAddress) {
      calls.mirror.push(`getAccount ${idOrAddress}`);
      const found =
        accounts[idOrAddress] ?? Object.values(accounts).find(a => a.evmAddress === idOrAddress.toLowerCase());
      return found ? { ...found } : null;
    },
    async getContractId(evmAddress) {
      calls.mirror.push(`getContractId ${evmAddress}`);
      return contracts[evmAddress.toLowerCase() as keyof typeof contracts] ?? null;
    },
    async findSettlementTransactions(accountId, eventKey) {
      calls.mirror.push(`findSettlementTransactions ${accountId}`);
      return transactions.filter(t => t.step && `${t.transactionId}`.length > 0 && matches(t, eventKey));
    },
    async getTransaction(id) {
      calls.mirror.push(`getTransaction ${id}`);
      const found = transactions.find(t => t.transactionId === id);
      return found
        ? {
            transactionId: found.transactionId,
            consensusTimestamp: found.consensusTimestamp,
            result: found.result,
            name: "",
          }
        : null;
    },
  };
  // Memos are kept next to the transaction so the fake scan matches like Mirror's memo filter would.
  const memos = new Map<string, string>();
  const matches = (t: SettlementTransaction, eventKey: string) =>
    parseSettlementMemo(memos.get(t.transactionId) ?? "")?.eventKey === eventKey.toLowerCase();

  function record(step: "mint" | "transfer", request: StepRequest): StepReceipt {
    sequence += 1;
    const seconds = 1_767_225_600 + sequence;
    const transactionId = `${OPERATOR}@${seconds}.000000001`;
    const consensusTimestamp = `${seconds}.000000002`;
    request.onTransactionId(transactionId);
    const tx: SettlementTransaction = {
      step,
      transactionId: toMirrorTransactionId(transactionId),
      consensusTimestamp,
      result: "SUCCESS",
    };
    memos.set(tx.transactionId, request.memo);
    (state.lag ? hidden : transactions).push(tx);
    return { transactionId, consensusTimestamp };
  }

  const takeFault = (step: keyof Faults, request: StepRequest) => {
    const fault = state.faults[step];
    if (!fault) return;
    delete state.faults[step];
    // A fault that carries a transaction id was sent before it failed.
    const error = typeof fault === "function" ? fault() : fault;
    const id = (error as { hvsTransactionId?: string }).hvsTransactionId;
    if (id) request.onTransactionId(id);
    throw error;
  };

  const executor: HtsExecutor = {
    async associate(request) {
      calls.executor.push(`associate ${request.accountId}`);
      takeFault("associate", request);
      if (relationships.has(key(request.accountId, request.tokenId))) {
        return { transactionId: "", consensusTimestamp: "", alreadyAssociated: true };
      }
      relationships.set(key(request.accountId, request.tokenId), relationship());
      sequence += 1;
      return {
        transactionId: `${request.accountId}@${1_767_225_600 + sequence}.000000001`,
        consensusTimestamp: `${1_767_225_600 + sequence}.000000002`,
        alreadyAssociated: false,
      };
    },
    async mint(request) {
      calls.executor.push(`mint ${request.amount}`);
      takeFault("mint", request);
      const receipt = record("mint", request);
      if (token) token.totalSupply += request.amount;
      const treasury = relationships.get(key(token?.treasuryAccountId ?? OPERATOR)) as TokenRelationship;
      treasury.balance += request.amount;
      return receipt;
    },
    async transfer(request) {
      calls.executor.push(`transfer ${request.amount} ${request.from}->${request.to}`);
      takeFault("transfer", request);
      const from = relationships.get(key(request.from)) as TokenRelationship;
      const to = relationships.get(key(request.to)) ?? relationship();
      const receipt = record("transfer", request);
      from.balance -= request.amount;
      to.balance += request.amount;
      relationships.set(key(request.to), to);
      return receipt;
    },
  };

  return {
    mirror,
    executor,
    calls,
    state,
    token,
    /** Makes hidden transactions visible on Mirror (the lag ends). */
    flush: () => {
      transactions.push(...hidden.splice(0));
    },
    balanceOf: (account: string) => relationships.get(key(account))?.balance ?? null,
    isAssociated: (account: string) => relationships.has(key(account)),
    removeAssociation: (account: string) => relationships.delete(key(account)),
    setRelationship: (account: string, extra: Partial<TokenRelationship>) =>
      relationships.set(key(account), relationship(extra)),
    addAccount,
    transactions,
  };
}

/** An error shaped like the Hedera SDK's, without importing it. */
export function hederaError(name: string, status?: string, message = "hedera error") {
  const error = new Error(message) as Error & { status?: { toString(): string } };
  error.name = name;
  if (status) error.status = { toString: () => status };
  return error;
}

export const timeout = () => new HtsTimeoutError(30_000);
