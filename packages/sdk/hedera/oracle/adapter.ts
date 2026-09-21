/**
 * The composed oracle adapter (ADR §6.9): `fetch` (provider) -> `normalize` (pure) -> validate (shared schema,
 * `../hcs/envelope`) -> freshness precheck (ADR §8 "#8") -> `attest`. This is what #9's relayer, #13's tests and #15's
 * E2E call; mock (`./mock.ts`) and real (#23) providers plug in underneath without changing this flow.
 *
 * Never throws for an expected failure: every outcome is an `ObserveResult`. Never retries by itself — a retry policy
 * belongs to the caller, exactly like the HCS publisher (#6) and the HTS adapter (#7).
 */
import { validateSettlementEvent } from "../hcs/envelope";
import { OracleTimeoutError, classifyOracleError } from "./errors";
import type { OracleFailure } from "./errors";
import type {
  Attestor,
  EventNormalizer,
  ObserveRequest,
  ObserveResult,
  OracleAdapter,
  OracleProvider,
  RawObservation,
} from "./types";

export interface CreateOracleAdapterOptions {
  provider: OracleProvider;
  normalizer: EventNormalizer;
  attestor: Attestor;
  /** Deadline of one `fetch` call. Default 10 000 ms. */
  timeoutMs?: number;
  /** Freshness precheck: reject an observation older than this before spending a signature on it. Default 300 s. */
  maxAgeSeconds?: number;
  /** Default `NormalizeContext.validitySeconds` when a request omits one. Default 900 s. */
  defaultValiditySeconds?: number;
  now?: () => Date;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject BEFORE aborting: abort() fires the provider's own 'abort' listener synchronously, which may reject
      // `promise` with a provider-specific error. Rejecting `deadline` first makes Promise.race settle to OUR
      // OracleTimeoutError deterministically, regardless of how (or whether) the provider reacts to the abort.
      reject(new OracleTimeoutError(timeoutMs));
      controller.abort();
    }, timeoutMs);
  });
  promise.catch(() => undefined); // the provider may keep running after a timeout; never an unhandled rejection
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const fail = (failure: OracleFailure): ObserveResult => ({ ok: false, failure });

export function createOracleAdapter(options: CreateOracleAdapterOptions): OracleAdapter {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxAgeSeconds = options.maxAgeSeconds ?? 300;
  const defaultValiditySeconds = options.defaultValiditySeconds ?? 900;
  const now = options.now ?? (() => new Date());

  return {
    eventSource: options.provider.eventSource,

    async observe(request: ObserveRequest): Promise<ObserveResult> {
      const query = request.query.ref;

      // 1. fetch
      let raw: RawObservation;
      const controller = new AbortController();
      try {
        raw = await withTimeout(
          options.provider.fetch(request.query, { signal: controller.signal, timeoutMs }),
          timeoutMs,
          controller,
        );
      } catch (error) {
        return fail(classifyOracleError(error, { query, timeoutMs }));
      }

      // 2. normalize (pure)
      const context = {
        ...request.context,
        validitySeconds: request.context.validitySeconds ?? defaultValiditySeconds,
      };
      const normalized = options.normalizer.normalize(raw, context);
      if (!normalized.ok) {
        return fail({
          code: "NORMALIZATION_FAILED",
          message: `The observation could not be normalized: ${normalized.issues.map(i => `${i.field}: ${i.message}`).join(" ")}`,
          remediation: "Fix the provider's raw observation or the normalize context. Nothing was signed.",
          retryable: false,
          query,
          issues: normalized.issues,
        });
      }
      const draft = normalized.value;

      // 3. validate against the shared schema (one schema for the whole project, ADR §6.1/§3)
      const validated = validateSettlementEvent(draft);
      if (!validated.ok) {
        return fail({
          code: "INVALID_EVENT",
          message: `The normalized draft is invalid: ${validated.issues.map(i => `${i.field}: ${i.message}`).join(" ")}`,
          remediation: "Fix the normalizer output. Nothing was signed.",
          retryable: false,
          query,
          issues: validated.issues,
        });
      }

      // 4. freshness precheck (ADR §8 "#8"): do not spend a signature on data the router would reject anyway.
      const nowSeconds = BigInt(Math.floor(now().getTime() / 1000));
      const age = nowSeconds - validated.value.observedAt;
      if (age > BigInt(maxAgeSeconds)) {
        return fail({
          code: "TOO_STALE",
          message: `The observation is ${age}s old, which exceeds the ${maxAgeSeconds}s freshness window.`,
          remediation:
            "Fetch a fresher observation. An attestation this old would be rejected by the router (ADR maxAge).",
          retryable: true,
          query,
        });
      }
      const validityWindow = validated.value.validUntil - validated.value.observedAt;
      if (validityWindow > BigInt(defaultValiditySeconds) * 2n) {
        // Generous slack: `defaultValiditySeconds` is this adapter's own default, not necessarily the source's
        // configured `maxValidity` (which lives in the router). This only catches a clearly runaway context value.
        return fail({
          code: "VALIDITY_WINDOW_TOO_LONG",
          message: `The attestation's validity window (${validityWindow}s) is unusually long.`,
          remediation:
            "Lower NormalizeContext.validitySeconds to match the source's configured maxValidity (ADR §6.2).",
          retryable: false,
          query,
        });
      }

      // 5. attest
      try {
        const { event, signature } = await options.attestor.attest(draft, request.domain);
        return { ok: true, raw, draft, event, signature };
      } catch (error) {
        return fail(classifyOracleError(error, { query }));
      }
    },
  };
}
