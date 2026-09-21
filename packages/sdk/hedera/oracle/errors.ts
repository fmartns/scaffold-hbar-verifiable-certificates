/**
 * Normalized oracle errors. Callers branch on `code`, never on message text or on a provider's own exception type. A real
 * provider (#23) MUST throw or reject with `OracleError` (or let `classifyOracleError` normalize whatever its transport
 * library throws) so the rest of the system never depends on a vendor's error shape.
 */
export type OracleErrorCode =
  /** The request did not complete within `timeoutMs`. The fact may or may not exist upstream; nothing was produced. */
  | "TIMEOUT"
  /** The provider has nothing for this query yet. Expected and distinct from an error: not a "yes" or a failure. */
  | "NO_DATA"
  /** The provider's raw response is not a well-formed observation (missing/wrong-typed fields). */
  | "INVALID_PAYLOAD"
  /** `EventNormalizer.normalize` could not build a draft from an otherwise well-formed observation. */
  | "NORMALIZATION_FAILED"
  /** The normalized draft failed the shared schema (`../hcs/envelope` `validateSettlementEvent`). */
  | "INVALID_EVENT"
  /** The observation is already too old to be worth attesting (adapter-side freshness precheck, ADR §8 "#8"). */
  | "TOO_STALE"
  /** `NormalizeContext.validitySeconds` exceeds the source's configured `maxValidity` (ADR §6.2). */
  | "VALIDITY_WINDOW_TOO_LONG"
  /** The transport could not reach the provider (network, DNS, connection refused). */
  | "PROVIDER_UNAVAILABLE"
  /** The provider answered with an error status of its own. */
  | "PROVIDER_ERROR"
  /** Environment or adapter configuration is missing or inconsistent. */
  | "CONFIG_INVALID"
  /** Signing the attestation failed. */
  | "ATTESTATION_FAILED"
  | "UNEXPECTED_RESPONSE";

export interface OracleFailure {
  code: OracleErrorCode;
  message: string;
  remediation: string;
  /** True when retrying the SAME query is a reasonable next step. The adapter never retries by itself. */
  retryable: boolean;
  query?: string;
  /** Validation issues, for `INVALID_PAYLOAD`, `NORMALIZATION_FAILED` and `INVALID_EVENT`. */
  issues?: { field: string; message: string }[];
  /** The provider's own status/name, when one was recognized (never the raw exception text). */
  providerStatus?: string;
}

/** Thrown by providers and by the adapter's own checks. Carries the same data as the failure. */
export class OracleError extends Error {
  readonly failure: OracleFailure;
  constructor(failure: OracleFailure) {
    super(`[${failure.code}] ${failure.message}`);
    this.name = "OracleError";
    this.failure = failure;
  }
  get code(): OracleErrorCode {
    return this.failure.code;
  }
}

export const isOracleError = (value: unknown): value is OracleError => value instanceof OracleError;

/** Internal deadline marker recognized by {@link classifyOracleError}. */
export class OracleTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timed out after ${timeoutMs} ms`);
    this.name = "OracleTimeoutError";
  }
}

const NETWORK_CODE =
  /(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|fetch failed|network)/i;

/**
 * Maps whatever a provider's transport threw to an {@link OracleFailure}. Passes an {@link OracleError} through unchanged
 * (plus the query, if not already set); classifies a raised `AbortError`/timeout marker as `TIMEOUT`; classifies a
 * network-shaped error as `PROVIDER_UNAVAILABLE`; anything else becomes `UNEXPECTED_RESPONSE`. Never returns the raw
 * error text, so a provider's exception (which may echo request details) cannot leak into a result or a log.
 */
export function classifyOracleError(error: unknown, ctx: { query?: string; timeoutMs?: number } = {}): OracleFailure {
  if (isOracleError(error)) return { ...error.failure, query: error.failure.query ?? ctx.query };

  const name = typeof (error as { name?: unknown } | null)?.name === "string" ? (error as { name: string }).name : "";
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const message = String((error as { message?: unknown } | null)?.message ?? "");

  if (name === "OracleTimeoutError" || name === "AbortError" || code === "ETIMEDOUT" || /timed? ?out/i.test(message)) {
    return {
      code: "TIMEOUT",
      message: `The provider did not answer within ${ctx.timeoutMs ?? "the configured"} ms.`,
      remediation: "Retry, or raise the timeout if the provider is consistently slow.",
      retryable: true,
      query: ctx.query,
    };
  }
  if (NETWORK_CODE.test(code) || NETWORK_CODE.test(message)) {
    return {
      code: "PROVIDER_UNAVAILABLE",
      message: "Could not reach the oracle provider.",
      remediation: "Check connectivity and the provider's configuration, then retry.",
      retryable: true,
      query: ctx.query,
    };
  }
  return {
    code: "UNEXPECTED_RESPONSE",
    message: "The provider failed for a reason that could not be classified.",
    remediation: "Inspect the underlying error in your logs and report it if it persists.",
    retryable: false,
    query: ctx.query,
  };
}
