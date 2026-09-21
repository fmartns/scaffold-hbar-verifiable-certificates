/**
 * The settlement as the HTS adapter sees it: input, validation, the ordered HTS operations the ADR prescribes, and the
 * effects an auditor should find on the ledger. Pure: no I/O.
 *
 * Coordination with ADR-001 and the router (#9):
 *  - `eventKey` IS the idempotency key (ADR D4): permanent, independent of timing and of the deployment. `settlementId`
 *    (bound to chain and router) travels with it for correlation, and `contentHash` detects different facts for one key.
 *  - They arrive from the same envelope the router settles (`settlementInputFromEnvelope`), computed by the shared
 *    envelope code, so the adapter and the router can never disagree about which settlement this is.
 *  - `mint-transfer` is the ADR v1 model (mint `amount`, then transfer it from the treasury to the beneficiary);
 *    `pool-transfer` is the documented alternative (transfer from a pre-funded treasury only). `amount == 0` is the
 *    ADR's valid no-op: it consumes the key and performs no HTS operation.
 */
import { isHexString } from "ethers";
import type { HcsEnvelope, Hex } from "../hcs/envelope";

export type SettlementModel = "mint-transfer" | "pool-transfer";
export type SettlementStep = "mint" | "transfer";

/** HTS amounts are int64 (ADR §6.2 `MAX_AMOUNT`). */
export const INT64_MAX = (1n << 63n) - 1n;

export interface SettlementInput {
  /** Idempotency key (ADR D4). 32 bytes, hex. */
  eventKey: string;
  /** Global settlement id (chain- and router-bound). Correlation only. */
  settlementId: string;
  /** Detects different facts for the same `eventKey`. */
  contentHash: string;
  /** HTS token id `0.0.x`. */
  tokenId: string;
  /** Beneficiary: an account id `0.0.x`, or an EVM address (resolved through Mirror Node). */
  beneficiary: string;
  /** Amount in the token's smallest unit: bigint, safe-integer number or decimal string. */
  amount: bigint | number | string;
}

export interface NormalizedSettlement {
  eventKey: Hex;
  settlementId: Hex;
  contentHash: Hex;
  tokenId: string;
  /** As given: an account id or an EVM address. */
  beneficiary: string;
  amount: bigint;
}

export interface InputIssue {
  field: string;
  code: "REQUIRED" | "INVALID_FORMAT" | "OUT_OF_RANGE";
  message: string;
}

export type InputResult = { ok: true; value: NormalizedSettlement } | { ok: false; issues: InputIssue[] };

const ENTITY_ID = /^\d+\.\d+\.\d+$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const isEntityId = (value: string): boolean => ENTITY_ID.test(value) && Number(value.split(".")[2]) > 0;
export const isEvmAddress = (value: string): boolean => EVM_ADDRESS.test(value);

/** Validates and normalizes a settlement input. Reports every problem at once, by field. */
export function validateSettlementInput(input: unknown): InputResult {
  const issues: InputIssue[] = [];
  if (typeof input !== "object" || input === null) {
    return {
      ok: false,
      issues: [{ field: "input", code: "REQUIRED", message: "The settlement input must be an object." }],
    };
  }
  const i = input as Record<string, unknown>;

  const bytes32 = (field: string): Hex => {
    const value = i[field];
    if (typeof value !== "string" || !isHexString(value, 32)) {
      issues.push({
        field,
        code: value === undefined ? "REQUIRED" : "INVALID_FORMAT",
        message: `${field} must be a 32-byte hex string (0x + 64 hex characters).`,
      });
      return `0x${"00".repeat(32)}`;
    }
    if (/^0x0+$/.test(value)) {
      issues.push({ field, code: "OUT_OF_RANGE", message: `${field} must not be zero.` });
    }
    return value.toLowerCase() as Hex;
  };
  const eventKey = bytes32("eventKey");
  const settlementId = bytes32("settlementId");
  const contentHash = bytes32("contentHash");

  const tokenId = i.tokenId;
  if (typeof tokenId !== "string" || !isEntityId(tokenId)) {
    issues.push({
      field: "tokenId",
      code: tokenId === undefined ? "REQUIRED" : "INVALID_FORMAT",
      message: "tokenId must be a token id such as 0.0.1234.",
    });
  }

  const beneficiary = i.beneficiary;
  if (typeof beneficiary !== "string" || !(isEntityId(beneficiary) || isEvmAddress(beneficiary))) {
    issues.push({
      field: "beneficiary",
      code: beneficiary === undefined ? "REQUIRED" : "INVALID_FORMAT",
      message: "beneficiary must be an account id such as 0.0.1234 or an EVM address.",
    });
  } else if (/^0x0{40}$/.test(beneficiary)) {
    issues.push({ field: "beneficiary", code: "OUT_OF_RANGE", message: "beneficiary must not be the zero address." });
  }

  let amount = 0n;
  const raw = i.amount;
  if (typeof raw === "bigint") amount = raw;
  else if (typeof raw === "number" && Number.isSafeInteger(raw)) amount = BigInt(raw);
  else if (typeof raw === "string" && /^\d+$/.test(raw)) amount = BigInt(raw);
  else {
    issues.push({
      field: "amount",
      code: raw === undefined ? "REQUIRED" : "INVALID_FORMAT",
      message:
        "amount must be a non-negative integer (bigint, safe-integer number or decimal string) in the token's smallest unit.",
    });
  }
  if (amount < 0n || amount > INT64_MAX) {
    issues.push({ field: "amount", code: "OUT_OF_RANGE", message: `amount must fit HTS's int64 (0 to ${INT64_MAX}).` });
    amount = 0n;
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      eventKey,
      settlementId,
      contentHash,
      tokenId: tokenId as string,
      beneficiary: beneficiary as string,
      amount,
    },
  };
}

/**
 * Builds the settlement input from the envelope the router will settle (#6) and the outcome of the settlement policy
 * (ADR §6.6): the identifiers come from the shared envelope code, the token, beneficiary and amount from the policy.
 */
export function settlementInputFromEnvelope(
  envelope: Pick<HcsEnvelope, "derived">,
  outcome: { tokenId: string; beneficiary: string; amount: bigint | number | string },
): SettlementInput {
  return {
    eventKey: envelope.derived.eventKey,
    settlementId: envelope.derived.settlementId,
    contentHash: envelope.derived.contentHash,
    ...outcome,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The plan: which HTS operations, in which order
// ---------------------------------------------------------------------------------------------------------------------

export interface PlannedOperation {
  step: SettlementStep;
  tokenId: string;
  amount: bigint;
  /** Transfer only. */
  from?: string;
  to?: string;
}

/**
 * The ordered HTS operations of a settlement (ADR §6.7): `mint-transfer` mints `amount` to the treasury and transfers it
 * to the beneficiary; `pool-transfer` only transfers. A zero amount is a valid no-op with no operations.
 */
export function planOperations(
  model: SettlementModel,
  settlement: { tokenId: string; treasury: string; beneficiary: string; amount: bigint },
): PlannedOperation[] {
  if (settlement.amount === 0n) return [];
  const transfer: PlannedOperation = {
    step: "transfer",
    tokenId: settlement.tokenId,
    amount: settlement.amount,
    from: settlement.treasury,
    to: settlement.beneficiary,
  };
  return model === "mint-transfer"
    ? [{ step: "mint", tokenId: settlement.tokenId, amount: settlement.amount }, transfer]
    : [transfer];
}

export interface ExpectedEffects {
  /** Change in the token's total supply, as a decimal string. */
  supplyDelta: string;
  /** Net change of each account's balance, as decimal strings (may be negative). */
  balanceDeltas: Record<string, string>;
}

/**
 * What the ledger must show once the settlement is applied, whichever party executed it. The router (#9) must produce
 * exactly this, and the Mirror audit (#10) compares child records against it (`HTS_MISMATCH`).
 * ADR audit invariant: `totalSupply(token) = Σ amount` of the settlements (plus the initial supply).
 */
export function expectedEffects(
  model: SettlementModel,
  settlement: { treasury: string; beneficiary: string; amount: bigint },
): ExpectedEffects {
  if (settlement.amount === 0n) return { supplyDelta: "0", balanceDeltas: {} };
  const amount = settlement.amount;
  return {
    supplyDelta: model === "mint-transfer" ? amount.toString() : "0",
    // Mint credits the treasury and the transfer debits it again, so its net change is zero; the pool model debits it.
    balanceDeltas: {
      [settlement.beneficiary]: amount.toString(),
      ...(model === "pool-transfer" && { [settlement.treasury]: (-amount).toString() }),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Memo: the settlement's fingerprint on the ledger
// ---------------------------------------------------------------------------------------------------------------------

/** `hvs:1:<eventKey>:<step>` (81 bytes at most, under Hedera's 100-byte memo limit). */
export function settlementMemo(eventKey: string, step: SettlementStep): string {
  return `hvs:1:${eventKey.toLowerCase()}:${step}`;
}

export function parseSettlementMemo(memo: string): { eventKey: Hex; step: SettlementStep } | null {
  const match = /^hvs:1:(0x[0-9a-f]{64}):(mint|transfer)$/.exec(memo);
  return match ? { eventKey: match[1] as Hex, step: match[2] as SettlementStep } : null;
}
