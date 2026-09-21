/**
 * Normalized HTS errors. Callers branch on `code` and `outcome`, never on message text or on Hedera SDK classes. Messages
 * never contain private keys or the raw text of SDK errors (which may echo their input).
 */
import { Interface } from "ethers";

export type HtsErrorCode =
  /** Environment or adapter configuration is missing or inconsistent (token, model, custody, router, network). */
  | "CONFIG_INVALID"
  /** The person declined a confirmation (e.g. `yarn hts:token`), or none could be asked. Nothing was sent. */
  | "CANCELLED"
  /** The settlement input failed validation; nothing was sent. */
  | "INVALID_SETTLEMENT"
  /** `amount` does not fit HTS's int64 or is otherwise not a valid token amount. */
  | "AMOUNT_OUT_OF_RANGE"
  /** The token does not exist on the selected network (INVALID_TOKEN_ID), or the id is wrong for this network. */
  | "TOKEN_NOT_FOUND"
  /** The token exists but cannot be used: deleted, not fungible, or otherwise unusable. */
  | "TOKEN_INVALID"
  | "TOKEN_PAUSED"
  | "ACCOUNT_NOT_FOUND"
  /** The account is not associated with the token (TOKEN_NOT_ASSOCIATED_TO_ACCOUNT). */
  | "NOT_ASSOCIATED"
  | "ACCOUNT_FROZEN"
  | "KYC_NOT_GRANTED"
  | "INSUFFICIENT_BALANCE"
  /** Only for flows that use allowances; neither settlement model of ADR-001 does. Kept so the code is never generic. */
  | "INSUFFICIENT_ALLOWANCE"
  /** No supply key, or the configured custodian does not hold it (TOKEN_HAS_NO_SUPPLY_KEY, INVALID_SUPPLY_KEY, ...). */
  | "NO_MINT_PERMISSION"
  | "SUPPLY_EXCEEDED"
  /** The account's own key is needed to associate it and this process does not hold it. */
  | "ASSOCIATION_NOT_AUTHORIZED"
  /** Same `eventKey` with a different `contentHash`: different facts for one settlement. Never executed. */
  | "CONFLICTING_SETTLEMENT"
  /** A previous attempt for this `eventKey` has an unknown outcome that cannot be resolved yet. Not executed again. */
  | "SETTLEMENT_IN_PROGRESS"
  | "NETWORK_UNAVAILABLE"
  | "TIMEOUT"
  /** The network processed the transaction and returned another failure status (see `hederaStatus`). */
  | "TRANSACTION_FAILED"
  | "UNEXPECTED_RESPONSE";

/**
 * What is known about the effect on the ledger after a failure.
 * - `not_sent`: nothing reached the network.
 * - `rejected`: the network refused it or it failed at consensus; nothing was applied by that operation.
 * - `unknown`: it may or may not have been applied. Reconcile before deciding; do not resend blindly.
 * - `partial`: an earlier operation of the settlement was applied and a later one was not (supply grew, beneficiary not
 *   credited). `code` still names the cause; `appliedTransactions` lists what was applied. Resume, do not restart.
 */
export type HtsOutcome = "not_sent" | "rejected" | "unknown" | "partial";

export type HtsOperation = "preflight" | "associate" | "mint" | "transfer" | "settle";

export interface HtsFailure {
  code: HtsErrorCode;
  outcome: HtsOutcome;
  operation: HtsOperation;
  message: string;
  remediation: string;
  /** True when the same input can reasonably succeed after the caller acts (or waits). The adapter never retries. */
  retryable: boolean;
  /** Hedera response code name, e.g. `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`. */
  hederaStatus?: string;
  /** Numeric response code, when it came from `HtsFailed(op, code)`. */
  hederaCode?: number;
  transactionId?: string;
  idempotencyKey?: string;
  settlementId?: string;
  tokenId?: string;
  accountId?: string;
  /** Preflight checks that were evaluated, when the failure came from preflight. */
  checks?: { id: string; ok: boolean; severity: "error" | "warning" | "info"; code?: HtsErrorCode; message: string }[];
  /** Transactions of this settlement that WERE applied, for `outcome: "partial"` (e.g. the mint). Resume; do not restart. */
  appliedTransactions?: string[];
  /** Validation problems of the settlement input, for `INVALID_SETTLEMENT`. */
  issues?: { field: string; code: string; message: string }[];
  /** Configuration problems, for `CONFIG_INVALID`. */
  configIssues?: { variable: string; message: string; remediation: string }[];
}

/** Thrown by construction/configuration paths and by Mirror reads. Carries the same data as the failure. */
export class HtsError extends Error {
  readonly failure: HtsFailure;
  constructor(failure: HtsFailure) {
    super(`[${failure.code}] ${failure.message}`);
    this.name = "HtsError";
    this.failure = failure;
  }
  get code(): HtsErrorCode {
    return this.failure.code;
  }
  get outcome(): HtsOutcome {
    return this.failure.outcome;
  }
}

export const isHtsError = (value: unknown): value is HtsError => value instanceof HtsError;

/** Internal deadline marker recognized by {@link classifyHtsError}. */
export class HtsTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timed out after ${timeoutMs} ms`);
    this.name = "HtsTimeoutError";
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Response codes (the numeric values are the Hedera `ResponseCodeEnum`; a test pins them to the SDK's own table)
// ---------------------------------------------------------------------------------------------------------------------

export const HTS_SUCCESS = 22;

export const HTS_RESPONSE_CODES: Readonly<Record<number, string>> = {
  4: "TRANSACTION_EXPIRED",
  7: "INVALID_SIGNATURE",
  10: "INSUFFICIENT_PAYER_BALANCE",
  11: "DUPLICATE_TRANSACTION",
  12: "BUSY",
  15: "INVALID_ACCOUNT_ID",
  22: "SUCCESS",
  30: "INSUFFICIENT_GAS",
  33: "CONTRACT_REVERT_EXECUTED",
  67: "PLATFORM_NOT_ACTIVE",
  72: "ACCOUNT_DELETED",
  101: "AUTHORIZATION_FAILED",
  165: "ACCOUNT_FROZEN_FOR_TOKEN",
  166: "TOKENS_PER_ACCOUNT_LIMIT_EXCEEDED",
  167: "INVALID_TOKEN_ID",
  173: "TRANSFERS_NOT_ZERO_SUM_FOR_TOKEN",
  176: "ACCOUNT_KYC_NOT_GRANTED_FOR_TOKEN",
  178: "INSUFFICIENT_TOKEN_BALANCE",
  179: "TOKEN_WAS_DELETED",
  180: "TOKEN_HAS_NO_SUPPLY_KEY",
  182: "INVALID_TOKEN_MINT_AMOUNT",
  184: "TOKEN_NOT_ASSOCIATED_TO_ACCOUNT",
  189: "INVALID_SUPPLY_KEY",
  193: "TOKEN_IS_IMMUTABLE",
  194: "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT",
  236: "TOKEN_MAX_SUPPLY_REACHED",
  265: "TOKEN_IS_PAUSED",
  292: "SPENDER_DOES_NOT_HAVE_ALLOWANCE",
  293: "AMOUNT_EXCEEDS_ALLOWANCE",
  294: "MAX_ALLOWANCES_EXCEEDED",
  328: "MAX_CHILD_RECORDS_EXCEEDED",
};

export const htsStatusName = (code: number): string | undefined => HTS_RESPONSE_CODES[code];

// ---------------------------------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------------------------------

export interface HtsErrorContext {
  operation: HtsOperation;
  tokenId?: string;
  accountId?: string;
  amount?: string;
  transactionId?: string;
  idempotencyKey?: string;
  settlementId?: string;
  timeoutMs?: number;
}

const NETWORK_STATUSES = new Set(["BUSY", "PLATFORM_NOT_ACTIVE", "PLATFORM_TRANSACTION_NOT_CREATED", "UNKNOWN"]);
const NETWORK_CODE =
  /(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|UNAVAILABLE|fetch failed|socket hang up|network)/i;

const RECONCILE =
  "The operation may or may not have been applied. Do not resend it blindly: call settle again with the same input after a few minutes (the adapter reconciles by the settlement memo on Mirror Node), or check the transaction on HashScan.";

function ids(ctx: HtsErrorContext) {
  return {
    ...(ctx.transactionId && { transactionId: ctx.transactionId }),
    ...(ctx.idempotencyKey && { idempotencyKey: ctx.idempotencyKey }),
    ...(ctx.settlementId && { settlementId: ctx.settlementId }),
    ...(ctx.tokenId && { tokenId: ctx.tokenId }),
    ...(ctx.accountId && { accountId: ctx.accountId }),
  };
}

const who = (ctx: HtsErrorContext) => (ctx.accountId ? `Account ${ctx.accountId}` : "The account");
const what = (ctx: HtsErrorContext) => (ctx.tokenId ? `token ${ctx.tokenId}` : "the token");

/**
 * Maps a Hedera response-code NAME to a normalized failure. `refused` is true when the network refused the transaction
 * before consensus (nothing applied) and false when it reached consensus with a failure status; both leave the ledger
 * unchanged for that operation, so the outcome is `rejected` either way.
 */
export function classifyHtsStatus(status: string, ctx: HtsErrorContext): HtsFailure {
  const base = { operation: ctx.operation, hederaStatus: status, outcome: "rejected" as HtsOutcome, ...ids(ctx) };
  const failure = (code: HtsErrorCode, message: string, remediation: string, retryable: boolean): HtsFailure => ({
    ...base,
    code,
    message,
    remediation,
    retryable,
  });

  switch (status) {
    case "TOKEN_NOT_ASSOCIATED_TO_ACCOUNT":
      return failure(
        "NOT_ASSOCIATED",
        `${who(ctx)} is not associated with ${what(ctx)}, so it cannot receive it.`,
        "The account owner must associate the account with the token (a TokenAssociateTransaction signed by that account, or from its wallet). Nothing was applied, so the same settlement can be submitted again afterwards.",
        true,
      );
    case "INVALID_TOKEN_ID":
      return failure(
        "TOKEN_NOT_FOUND",
        `${what(ctx)[0].toUpperCase()}${what(ctx).slice(1)} does not exist on this network.`,
        "Check HEDERA_HTS_TOKEN_ID and HEDERA_NETWORK: token ids are per network.",
        false,
      );
    case "TOKEN_WAS_DELETED":
    case "TOKEN_IS_IMMUTABLE":
      return failure(
        "TOKEN_INVALID",
        status === "TOKEN_WAS_DELETED"
          ? `${what(ctx)} was deleted.`
          : `${what(ctx)} is immutable and cannot be changed.`,
        "Create a new settlement token and update HEDERA_HTS_TOKEN_ID.",
        false,
      );
    case "TOKEN_IS_PAUSED":
      return failure(
        "TOKEN_PAUSED",
        `${what(ctx)} is paused, so it cannot be transferred or minted.`,
        "Unpause the token with its pause key, then submit the same settlement again.",
        true,
      );
    case "INSUFFICIENT_TOKEN_BALANCE":
      return failure(
        "INSUFFICIENT_BALANCE",
        `The paying account does not hold enough of ${what(ctx)}${ctx.amount ? ` to settle ${ctx.amount}` : ""}.`,
        "Fund the treasury/pool with more of the token (or use the mint-transfer model), then submit the same settlement again.",
        true,
      );
    case "SPENDER_DOES_NOT_HAVE_ALLOWANCE":
    case "AMOUNT_EXCEEDS_ALLOWANCE":
    case "MAX_ALLOWANCES_EXCEEDED":
      return failure(
        "INSUFFICIENT_ALLOWANCE",
        "The spender does not have enough token allowance for this settlement.",
        "Approve a larger allowance to the spender (CryptoApproveAllowance), then submit the same settlement again.",
        true,
      );
    case "TOKEN_HAS_NO_SUPPLY_KEY":
    case "INVALID_SUPPLY_KEY":
      return failure(
        "NO_MINT_PERMISSION",
        `${what(ctx)} cannot be minted: it has no usable supply key.`,
        "Create the token with the settlement custodian (the SettlementRouter, or the operator in dev) as its supply key, or switch to the pool-transfer model.",
        false,
      );
    case "TOKEN_MAX_SUPPLY_REACHED":
      return failure(
        "SUPPLY_EXCEEDED",
        `Minting ${ctx.amount ?? "this amount"} would exceed the maximum supply of ${what(ctx)}.`,
        "Reduce the amount, or use a token with a higher maximum supply.",
        false,
      );
    case "ACCOUNT_FROZEN_FOR_TOKEN":
      return failure(
        "ACCOUNT_FROZEN",
        `${who(ctx)} is frozen for ${what(ctx)}.`,
        "Unfreeze the account with the token's freeze key, then submit the same settlement again.",
        true,
      );
    case "ACCOUNT_KYC_NOT_GRANTED_FOR_TOKEN":
      return failure(
        "KYC_NOT_GRANTED",
        `${who(ctx)} has not been granted KYC for ${what(ctx)}.`,
        "Grant KYC with the token's KYC key, then submit the same settlement again.",
        true,
      );
    case "INVALID_ACCOUNT_ID":
    case "ACCOUNT_DELETED":
      return failure(
        "ACCOUNT_NOT_FOUND",
        `${who(ctx)} does not exist or was deleted.`,
        "Check the beneficiary account id and the selected network.",
        false,
      );
    case "INVALID_TOKEN_MINT_AMOUNT":
    case "INVALID_TOKEN_TRANSFER_AMOUNT":
      return failure(
        "AMOUNT_OUT_OF_RANGE",
        `The amount${ctx.amount ? ` ${ctx.amount}` : ""} is not valid for ${what(ctx)}.`,
        "Use a positive integer amount in the token's smallest unit that fits int64.",
        false,
      );
    case "INVALID_SIGNATURE":
    case "AUTHORIZATION_FAILED":
      return ctx.operation === "mint"
        ? failure(
            "NO_MINT_PERMISSION",
            `The operator is not authorized to mint ${what(ctx)}: it does not hold the supply key.`,
            "Mint with the key that is the token's supply key. With router custody only the SettlementRouter can mint, on-chain.",
            false,
          )
        : failure(
            "TRANSACTION_FAILED",
            `The network rejected the ${ctx.operation} because the required signature is missing (${status}).`,
            ctx.operation === "associate"
              ? "The account's own key must sign the association."
              : "The operator must hold the key of the paying account (the token treasury).",
            false,
          );
    case "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT":
      return failure(
        "TRANSACTION_FAILED",
        `${who(ctx)} is already associated with ${what(ctx)}.`,
        "Nothing to do: the account can already receive the token.",
        false,
      );
    default:
      if (NETWORK_STATUSES.has(status)) {
        return {
          ...base,
          code: "NETWORK_UNAVAILABLE",
          message: `The Hedera network could not process the request right now (${status}).`,
          remediation: "Retry later. If the transaction id is set, look it up first.",
          retryable: true,
        };
      }
      return failure(
        "TRANSACTION_FAILED",
        `Hedera rejected the ${ctx.operation} (${status}).`,
        "See the Hedera response code documentation for this status and fix the cause before submitting again.",
        false,
      );
  }
}

/** Interprets a numeric response code, e.g. the `code` of the router's `HtsFailed(op, code)`. */
export function interpretHtsResponseCode(code: number, ctx: HtsErrorContext): HtsFailure {
  const name = HTS_RESPONSE_CODES[code];
  if (name === "SUCCESS") {
    return {
      code: "UNEXPECTED_RESPONSE",
      outcome: "not_sent",
      operation: ctx.operation,
      message: "A success code (22) was reported as a failure.",
      remediation: "This is a bug in the caller: only non-success codes are failures.",
      retryable: false,
      hederaCode: code,
      ...ids(ctx),
    };
  }
  if (!name) {
    return {
      code: "TRANSACTION_FAILED",
      outcome: "rejected",
      operation: ctx.operation,
      message: `Hedera returned the response code ${code}, which this adapter does not know.`,
      remediation: "Look the code up in the Hedera ResponseCodeEnum and fix the cause before submitting again.",
      retryable: false,
      hederaCode: code,
      ...ids(ctx),
    };
  }
  return { ...classifyHtsStatus(name, ctx), hederaCode: code };
}

const HTS_FAILED = new Interface(["error HtsFailed(uint8 op, int64 responseCode)"]);

/**
 * Decodes the revert data of `SettlementRouter.settle` when it reverted with `HtsFailed(op, responseCode)` (ADR-001 §6.5;
 * op 1 = mint, 2 = transfer) into a normalized failure. Returns null for any other revert.
 */
export function decodeHtsFailed(revertData: string, ctx: Omit<HtsErrorContext, "operation"> = {}): HtsFailure | null {
  let parsed;
  try {
    parsed = HTS_FAILED.parseError(revertData);
  } catch {
    return null;
  }
  if (!parsed || parsed.name !== "HtsFailed") return null;
  const op = Number(parsed.args[0]);
  const code = Number(parsed.args[1]);
  const operation: HtsOperation = op === 1 ? "mint" : op === 2 ? "transfer" : "settle";
  return interpretHtsResponseCode(code, { ...ctx, operation });
}

/**
 * Maps whatever an executor or the SDK threw to a {@link HtsFailure}. Recognizes Hedera SDK errors by name and shape
 * (`PrecheckStatusError`, `ReceiptStatusError`, `StatusError`, `MaxAttemptsOrTimeoutError`), gRPC/Node network errors and
 * this module's own timeout. Never returns the raw error text.
 */
export function classifyHtsError(error: unknown, ctx: HtsErrorContext): HtsFailure {
  if (isHtsError(error))
    return {
      ...error.failure,
      ...ids(ctx),
      ...(error.failure.transactionId && { transactionId: error.failure.transactionId }),
    };

  const name = typeof (error as { name?: unknown } | null)?.name === "string" ? (error as { name: string }).name : "";
  const message = String((error as { message?: unknown } | null)?.message ?? "");
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const statusRaw = (error as { status?: unknown } | null)?.status;
  const status =
    statusRaw !== undefined && statusRaw !== null && /^[A-Z][A-Z0-9_]+$/.test(String(statusRaw))
      ? String(statusRaw)
      : undefined;

  if (
    name === "HtsTimeoutError" ||
    name === "MaxAttemptsOrTimeoutError" ||
    /timed? ?out|deadline/i.test(message) ||
    code === "ETIMEDOUT"
  ) {
    return {
      code: "TIMEOUT",
      outcome: "unknown",
      operation: ctx.operation,
      message: `The ${ctx.operation} did not complete${ctx.timeoutMs ? ` within ${ctx.timeoutMs} ms` : " in time"}.`,
      remediation: RECONCILE,
      retryable: true,
      ...ids(ctx),
    };
  }

  if (status !== undefined) {
    const failure = classifyHtsStatus(status, ctx);
    // A busy/unavailable network answering AFTER consensus is not a refusal: the outcome is unknown.
    if (failure.code === "NETWORK_UNAVAILABLE" && name !== "PrecheckStatusError") {
      return { ...failure, outcome: "unknown", remediation: RECONCILE };
    }
    return failure;
  }

  if (
    NETWORK_CODE.test(code) ||
    NETWORK_CODE.test(message) ||
    name === "GrpcServiceError" ||
    name === "GrpcStatusError"
  ) {
    return {
      code: "NETWORK_UNAVAILABLE",
      outcome: ctx.transactionId ? "unknown" : "not_sent",
      operation: ctx.operation,
      message: "Could not reach the Hedera network.",
      remediation: ctx.transactionId
        ? RECONCILE
        : "Check your connection and HEDERA_NETWORK, then retry. The request did not reach a consensus node.",
      retryable: true,
      ...ids(ctx),
    };
  }

  return {
    code: "UNEXPECTED_RESPONSE",
    outcome: ctx.transactionId ? "unknown" : "not_sent",
    operation: ctx.operation,
    message: `The ${ctx.operation} failed for a reason that could not be classified.`,
    remediation: ctx.transactionId
      ? RECONCILE
      : "Inspect the underlying error in your logs and report it if it persists.",
    retryable: false,
    ...ids(ctx),
  };
}
