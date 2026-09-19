/**
 * Normalized errors of the HCS publisher.
 *
 * Callers branch on `code` and `outcome`, never on message text or on Hedera SDK classes. The messages never contain
 * private keys, secrets or the raw text of SDK errors (which may echo their input).
 */
import type { EnvelopeIssue } from "./envelope";

export type HcsErrorCode =
  /** Environment/configuration is missing or malformed (topic id, router address, timeout, network). */
  | "CONFIG_INVALID"
  /** The person declined the confirmation, or none could be asked (non-interactive without `--yes`). Nothing was sent. */
  | "CANCELLED"
  /** The event or signature failed validation; nothing was sent. */
  | "INVALID_EVENT"
  /** Topic does not exist, was deleted or is not a valid topic id (INVALID_TOPIC_ID). */
  | "TOPIC_INVALID"
  /** The topic exists but the publisher cannot write to it (no `submitKey`, or it is another key). */
  | "TOPIC_NOT_WRITABLE"
  /** No consensus node could be reached, or the network refused the request as busy/unavailable. */
  | "NETWORK_UNAVAILABLE"
  /** The publish did not finish in time. The message MAY still reach consensus. */
  | "TIMEOUT"
  /** The network processed the transaction and returned a failure status (see `hederaStatus`). */
  | "TRANSACTION_FAILED"
  /** The network answered success but the answer lacks what the evidence needs. */
  | "UNEXPECTED_RESPONSE";

/**
 * What is known about the message after a failure.
 * - `not_sent`: rejected locally; the network never saw it.
 * - `rejected`: the network refused it (precheck) or reached consensus with a failure status; it is NOT in the topic.
 * - `unknown`: the outcome cannot be determined; the message MAY be in the topic. Reconcile before deciding
 *   (see `remediation`); a re-publish is at-least-once and benign (consumers dedupe by `attestationDigest`).
 */
export type HcsOutcome = "not_sent" | "rejected" | "unknown";

/** One problem found in the environment configuration. */
export interface ConfigIssue {
  variable: string;
  message: string;
  remediation: string;
}

export interface HcsPublishFailure {
  code: HcsErrorCode;
  outcome: HcsOutcome;
  message: string;
  remediation: string;
  /**
   * True when re-submitting the SAME envelope is a reasonable next step for the caller's policy. The service itself
   * NEVER retries. It is a hint, not a promise of success.
   */
  retryable: boolean;
  /** Hedera response code name, e.g. `INVALID_TOPIC_ID`, when the network returned one. */
  hederaStatus?: string;
  /** Transaction ID (SDK format) when it was already known: use it to look the transaction up on Mirror/HashScan. */
  transactionId?: string;
  topicId?: string;
  /** Identity of the event, when the envelope was built, so failures can be correlated without the payload. */
  eventKey?: string;
  attestationDigest?: string;
  /** Validation problems of the event, for `INVALID_EVENT`. */
  issues?: EnvelopeIssue[];
  /** Configuration problems, for `CONFIG_INVALID`. */
  configIssues?: ConfigIssue[];
}

/** Thrown by construction/configuration paths and by {@link unwrapPublish}. Carries the same data as the failure. */
export class HcsPublishError extends Error {
  readonly failure: HcsPublishFailure;
  constructor(failure: HcsPublishFailure) {
    super(`[${failure.code}] ${failure.message}`);
    this.name = "HcsPublishError";
    this.failure = failure;
  }
  get code(): HcsErrorCode {
    return this.failure.code;
  }
  get outcome(): HcsOutcome {
    return this.failure.outcome;
  }
}

export function isHcsPublishError(value: unknown): value is HcsPublishError {
  return value instanceof HcsPublishError;
}

// ---------------------------------------------------------------------------------------------------------------------
// Classification of transport errors (duck-typed: no import of the Hedera SDK, so it is testable with plain fakes)
// ---------------------------------------------------------------------------------------------------------------------

export interface ClassifyContext {
  topicId?: string;
  transactionId?: string;
  timeoutMs?: number;
  eventKey?: string;
  attestationDigest?: string;
}

const NETWORK_STATUSES = new Set(["BUSY", "PLATFORM_NOT_ACTIVE", "PLATFORM_TRANSACTION_NOT_CREATED", "UNKNOWN"]);
const TOPIC_STATUSES = new Set(["INVALID_TOPIC_ID", "TOPIC_EXPIRED"]);
const NETWORK_CODE =
  /(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|UNAVAILABLE|fetch failed|socket hang up|network)/i;

function statusName(error: unknown): string | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === undefined || status === null) return undefined;
  const text = String(status);
  return /^[A-Z][A-Z0-9_]+$/.test(text) ? text : undefined;
}

function nameOf(error: unknown): string {
  return typeof (error as { name?: unknown } | null)?.name === "string" ? (error as { name: string }).name : "";
}

function base(ctx: ClassifyContext) {
  return {
    ...(ctx.topicId && { topicId: ctx.topicId }),
    ...(ctx.transactionId && { transactionId: ctx.transactionId }),
    ...(ctx.eventKey && { eventKey: ctx.eventKey }),
    ...(ctx.attestationDigest && { attestationDigest: ctx.attestationDigest }),
  };
}

const RECONCILE =
  "The message may or may not have reached consensus. Before retrying, look the transaction up on Mirror Node / HashScan by transactionId (or scan the topic for the attestationDigest). Re-publishing is at-least-once and benign because consumers deduplicate by attestationDigest.";

/**
 * Maps whatever a transport threw to a {@link HcsPublishFailure}. Never returns the raw error text.
 * Recognizes Hedera SDK errors by name/shape: `PrecheckStatusError`, `ReceiptStatusError`, `StatusError`,
 * `MaxAttemptsOrTimeoutError`, gRPC/Node network errors and this module's own timeout.
 */
export function classifyPublishError(error: unknown, ctx: ClassifyContext = {}): HcsPublishFailure {
  if (isHcsPublishError(error)) return { ...base(ctx), ...error.failure };

  const name = nameOf(error);
  const status = statusName(error);
  const message = String((error as { message?: unknown } | null)?.message ?? "");
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const common = base(ctx);

  if (name === "HcsTimeoutError") {
    return {
      code: "TIMEOUT",
      outcome: "unknown",
      message: `Publishing did not complete within ${ctx.timeoutMs ?? "the configured"} ms.`,
      remediation: RECONCILE,
      retryable: true,
      ...common,
    };
  }

  if (status !== undefined) {
    // A status error is a definitive answer from the network. `PrecheckStatusError`: refused before consensus.
    // `ReceiptStatusError`/`StatusError`: consensus reached with a failure status. Either way it is not in the topic.
    if (TOPIC_STATUSES.has(status)) {
      return {
        code: "TOPIC_INVALID",
        outcome: "rejected",
        message: `The topic${ctx.topicId ? ` ${ctx.topicId}` : ""} does not exist, was deleted or is not a valid topic (${status}).`,
        remediation:
          "Check HEDERA_HCS_TOPIC_ID and HEDERA_NETWORK: topic ids are per network. Create a topic with a submitKey on the selected network and set its id in .env.",
        retryable: false,
        hederaStatus: status,
        ...common,
      };
    }
    if (NETWORK_STATUSES.has(status)) {
      return {
        code: "NETWORK_UNAVAILABLE",
        outcome: name === "PrecheckStatusError" ? "rejected" : "unknown",
        message: `The Hedera network could not process the request right now (${status}).`,
        remediation:
          name === "PrecheckStatusError"
            ? "The node refused the transaction before consensus. Retry later; nothing was published."
            : RECONCILE,
        retryable: true,
        hederaStatus: status,
        ...common,
      };
    }
    const signatureProblem = status === "INVALID_SIGNATURE";
    return {
      code: "TRANSACTION_FAILED",
      outcome: "rejected",
      message: `Hedera rejected the topic message transaction (${status}).`,
      remediation: signatureProblem
        ? "The operator key did not authorize the message. The topic's submitKey must be the publisher (operator) key."
        : status.startsWith("INSUFFICIENT") ||
            status === "PAYER_ACCOUNT_NOT_FOUND" ||
            status === "INVALID_PAYER_ACCOUNT_ID"
          ? "The operator account cannot pay for the transaction. Run `yarn setup` and fund the account."
          : "See the Hedera response code documentation for this status and fix the cause before publishing again.",
      retryable: false,
      hederaStatus: status,
      ...common,
    };
  }

  if (name === "MaxAttemptsOrTimeoutError" || /timed? ?out|deadline/i.test(message) || code === "ETIMEDOUT") {
    return {
      code: "TIMEOUT",
      outcome: "unknown",
      message: "The Hedera network did not answer in time.",
      remediation: RECONCILE,
      retryable: true,
      ...common,
    };
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
      message: "Could not reach the Hedera network.",
      remediation: ctx.transactionId
        ? RECONCILE
        : "Check your connection and HEDERA_NETWORK, then retry. The request did not reach a consensus node.",
      retryable: true,
      ...common,
    };
  }

  return {
    code: "UNEXPECTED_RESPONSE",
    outcome: ctx.transactionId ? "unknown" : "not_sent",
    message: "Publishing failed for a reason that could not be classified.",
    remediation: ctx.transactionId
      ? RECONCILE
      : "Inspect the underlying error in your logs and report it if it persists.",
    retryable: false,
    ...common,
  };
}

/** Internal timeout marker recognized by {@link classifyPublishError}. */
export class HcsTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timed out after ${timeoutMs} ms`);
    this.name = "HcsTimeoutError";
  }
}
