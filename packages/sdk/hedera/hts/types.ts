/** Result types and ports of the HTS adapter. Types only: no behaviour. All results are JSON-safe (strings and numbers). */
import type { Custody } from "./config";
import type { ExpectedEffects, SettlementModel, SettlementStep } from "./settlement";
import type { HtsFailure } from "./errors";
import type { HtsPreflightCheck } from "./preflight";

// ---------------------------------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------------------------------

export interface OperationResult {
  operation: SettlementStep | "associate";
  /** Hedera transaction id (SDK format `0.0.x@sss.nnn`). Persist it. */
  transactionId: string;
  /** Mirror Node REST format of the same id. */
  mirrorTransactionId: string;
  consensusTimestamp: string;
  hashscanUrl: string | null;
}

export interface SettlementAudit {
  schema: "hts-settlement/v1";
  /** What the ledger must show for this settlement (see `expectedEffects`); #9 and #10 compare against it. */
  expectedEffects: ExpectedEffects;
  /** Local clock when the result was built (ISO 8601). Consensus timestamps are authoritative. */
  recordedAt: string;
  /** Ids of the preflight checks that ran and passed, and warnings raised. */
  preflight: { checks: string[]; warnings: string[] };
  /** Router `statusOf` answer when the settlement was found already settled on-chain. */
  routerSettledAt?: string;
}

export interface SettlementSuccess {
  ok: true;
  /**
   * `settled`: this call applied it. `already_settled`: it was complete before this call and NOTHING was sent now.
   * `noop`: a zero amount, which consumes the idempotency key and performs no HTS operation (ADR §4.9).
   */
  status: "settled" | "already_settled" | "noop";
  /** True when nothing was sent because the settlement was already complete. */
  replay: boolean;
  /** Where completion was established: this call, the caller's ledger, the router's `statusOf`, or the network (memo). */
  source: "executed" | "ledger" | "router" | "network";
  /** ADR D4: `eventKey`. */
  idempotencyKey: string;
  settlementId: string;
  contentHash: string;
  network: string;
  tokenId: string;
  model: SettlementModel;
  custody: Custody;
  /** Paying account: the treasury / pool. */
  from: string | null;
  /** Beneficiary account id. */
  to: string;
  /** Amount in the token's smallest unit, decimal string. */
  amount: string;
  /** The mint and/or transfer that credited the beneficiary (this call's, or the earlier ones found). */
  operations: OperationResult[];
  /** Last operation, for quick correlation. */
  transactionId: string | null;
  hashscanUrl: string | null;
  hashscanTokenUrl: string | null;
  audit: SettlementAudit;
}

export interface SettlementFailure {
  ok: false;
  status: "failed";
  failure: HtsFailure;
}

export type SettleResult = SettlementSuccess | SettlementFailure;

export interface AssociationSuccess {
  ok: true;
  /** `already_associated`: nothing was sent. */
  status: "associated" | "already_associated";
  accountId: string;
  tokenId: string;
  network: string;
  operation: OperationResult | null;
  hashscanTokenUrl: string | null;
}

export type AssociateResult = AssociationSuccess | SettlementFailure;

// ---------------------------------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The router's `statusOf(eventKey)` (ADR §6.4): the AUTHORITY on whether an event was settled. Consulted before anything is
 * sent (recovery invariant, ADR §5.5).
 */
export interface SettlementStatusReader {
  statusOf(eventKey: string): Promise<{ settled: boolean; contentHash: string; settledAt: bigint | number }>;
}

export type LedgerState = "in_progress" | "completed" | "failed" | "unknown";

export interface LedgerStep {
  operation: SettlementStep;
  /** `sent`: transaction id known, no answer yet. `rejected`: refused/failed, not applied. */
  state: "sent" | "confirmed" | "unknown" | "rejected";
  transactionId?: string;
  consensusTimestamp?: string;
  /** ISO time the step was sent: lets an `unknown` step be judged expired (valid duration is at most 180 s). */
  sentAt?: string;
}

export interface LedgerRecord {
  idempotencyKey: string;
  settlementId: string;
  contentHash: string;
  state: LedgerState;
  steps: Partial<Record<SettlementStep, LedgerStep>>;
  result?: SettlementSuccess;
  failure?: HtsFailure;
  createdAt: string;
  updatedAt: string;
}

/**
 * OPTIONAL persistence supplied by the caller (the adapter itself holds no state, ADR §6.7). It is a second line of
 * defense for off-chain retries; the router remains the authority. `begin` MUST be atomic (create only if absent).
 */
export interface IdempotencyLedger {
  get(idempotencyKey: string): Promise<LedgerRecord | null>;
  begin(record: LedgerRecord): Promise<{ created: boolean; record: LedgerRecord }>;
  save(record: LedgerRecord): Promise<void>;
}

export type { HtsPreflightCheck };
