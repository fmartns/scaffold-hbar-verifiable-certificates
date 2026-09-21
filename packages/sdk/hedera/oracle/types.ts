/**
 * The oracle adapter contract (issue #8; ADR-001 §6.9, §8 "#8 — oracle interface + deterministic mock").
 *
 * The adapter separates three concerns, exactly as the ADR prescribes, so a real provider (#23) only ever needs to
 * implement `OracleProvider` — the other two pieces (`EventNormalizer`, `Attestor`) are reference implementations shared
 * by every provider, mock or real:
 *
 *   OracleProvider   — vendor-specific I/O: fetches ONE raw observation. This is the only vendor-specific surface.
 *   EventNormalizer  — PURE: RawObservation -> SettlementEventDraft. Same input, same eventKey/contentHash (ADR T-13).
 *   Attestor         — signs a draft into a `SettlementEvent` + EIP-712 signature, ready for the HCS publisher (#6).
 *
 * `SettlementEventDraft` is exactly the `SettlementEvent` shape from `../hcs/envelope` (issue #6/#3): the oracle produces
 * no format of its own. Reusing that module's `validateSettlementEvent` is how a normalized draft is validated before it
 * is signed or handed to `../hcs`, `../hts` or the router (#9) — there is exactly one schema for this data, defined once.
 *
 * Nothing here is production/demo oracle integration: that is issue #23, which chooses a real provider (or an on-chain
 * feed) and implements `OracleProvider` for it. This module and its mock (`./mock.ts`) exist to make the settlement flow
 * runnable and testable (#13, #15) without credentials or a third party. See `../../../docs/oracle-adapter.md`.
 */
import type { Hex, SettlementEvent } from "../hcs/envelope";
import type { OracleFailure } from "./errors";

/** Pre-signature form of a settlement event: the normalizer's output, before `Attestor.attest`. */
export type SettlementEventDraft = SettlementEvent;

// ---------------------------------------------------------------------------------------------------------------------
// OracleProvider — the ONLY vendor-specific surface (#23 implements this for a real vendor)
// ---------------------------------------------------------------------------------------------------------------------

export interface OracleQuery {
  /** Provider-specific identifier of what to fetch (an order id, a feed round, ...). Opaque to the adapter. */
  ref: string;
  /** For an ordered stream (ADR §4.9): the position being requested. Omitted for unordered sources. */
  streamSeq?: bigint;
  /** Extra provider-specific parameters. Opaque to the adapter and to `EventNormalizer`; a provider defines its own shape. */
  params?: Record<string, unknown>;
}

/** What a provider returns for one query, before normalization. Provider-specific in `data`; the rest is generic. */
export interface RawObservation {
  /** The provider's own record id, when it has one (ADR R4: hashed into `externalEventId` when present). */
  providerRef?: string;
  /** Unix seconds the provider recorded or observed the fact (ADR §5.2 step 1). */
  observedAt: number;
  /** Policy-specific facts, in the convention the reference `EventNormalizer` accepts (see `./normalize`). */
  data?: Hex | bigint | number | null;
  /** Opaque reference to the raw provider response, for audit provenance (ADR §5.2 step 1 `rawRef`). Never signed. */
  rawRef?: string;
  /** Namespaces the identity when one source emits several kinds of event for one entity (ADR §4.4 R5). */
  eventType?: string;
}

export interface FetchOptions {
  /** Aborts the request. A provider MUST stop and reject promptly when this fires. */
  signal: AbortSignal;
  /** Same deadline `signal` will abort at, in case a provider needs the raw number (e.g. for an upstream request timeout). */
  timeoutMs: number;
}

/**
 * A source of external facts. The single interface every real provider (#23) and the mock (`./mock.ts`) implement, so the
 * rest of the system never depends on a specific vendor.
 */
export interface OracleProvider {
  /** Namespace of this source (ADR §4.4 R6): `keccak256(bytes(<lowercase ASCII source name>))`. Use `eventSourceOf`. */
  readonly eventSource: Hex;
  /**
   * Fetches one observation.
   * - Resolves with a `RawObservation` when data is available.
   * - Rejects with an `OracleError` (see `./errors`) for every other outcome, INCLUDING "no data available yet": that is
   *   not silence or a null return, it is `code: "NO_DATA"`, so callers cannot mistake it for a fetch that never happened.
   * - MUST reject once `options.signal` aborts, and MUST NOT resolve or reject twice.
   */
  fetch(query: OracleQuery, options: FetchOptions): Promise<RawObservation>;
}

// ---------------------------------------------------------------------------------------------------------------------
// EventNormalizer — pure, deterministic, shared by every provider
// ---------------------------------------------------------------------------------------------------------------------

export interface NormalizeContext {
  eventSource: Hex;
  /** Policy (and version) that will interpret `data` (ADR §6.1 `policyId`). Decided by the caller, not the provider. */
  policyId: Hex;
  /** `0x00…00` = unordered (ADR §4.9 default). */
  streamId?: Hex;
  /** Position in the stream; required (`>= 1`) when `streamId` is set. */
  streamSeq?: bigint;
  /** `0x00…00` = any caller may submit (ADR §6.1). */
  submitter?: Hex;
  /** Attestation lifetime in seconds from `observedAt`. Must not exceed the source's `maxValidity` (ADR §6.2). */
  validitySeconds: number;
}

/**
 * Turns a raw observation into a draft event. MUST be a pure function: the same `RawObservation` and `NormalizeContext`
 * always produce the same `externalEventId`, `eventKey` and `contentHash` (ADR T-13) — no clock, no randomness, no I/O.
 * Identity (ADR §4.4 R1–R6) MUST depend only on the fields that identify the event, never on `observedAt` or any other
 * volatile/observational field.
 */
export interface EventNormalizer {
  normalize(raw: RawObservation, ctx: NormalizeContext): NormalizeResult;
}

export type NormalizeResult = { ok: true; value: SettlementEventDraft } | { ok: false; issues: NormalizeIssue[] };

export interface NormalizeIssue {
  field: string;
  message: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Attestor — signs a draft; generic over the signing key
// ---------------------------------------------------------------------------------------------------------------------

/** What `attest` needs to sign: an EIP-712 typed-data signer (an `ethers` `Wallet`/`Signer` satisfies this). */
export interface TypedDataSigner {
  readonly address: string;
  signTypedData(
    domain: { name: string; version: string; chainId: bigint | number; verifyingContract: string },
    types: Record<string, { name: string; type: string }[]>,
    value: Record<string, unknown>,
  ): Promise<string>;
}

export interface AttestationDomain {
  chainId: bigint | number;
  /** The deployed `SettlementRouter` address (ADR §6.1 domain `verifyingContract`). */
  verifyingContract: string;
}

export interface Attestation {
  event: SettlementEvent;
  /** 65-byte `r || s || v` EIP-712 signature, low-`s` (ADR §4.8). */
  signature: Hex;
}

/** Signs a validated draft. Does not validate: callers MUST validate the draft first (see `../hcs/envelope`). */
export interface Attestor {
  attest(draft: SettlementEventDraft, domain: AttestationDomain): Promise<Attestation>;
}

// ---------------------------------------------------------------------------------------------------------------------
// OracleAdapter — the composed reference flow: fetch -> normalize -> validate -> freshness -> attest
// ---------------------------------------------------------------------------------------------------------------------

export interface ObserveRequest {
  query: OracleQuery;
  context: NormalizeContext;
  domain: AttestationDomain;
}

export interface ObserveSuccess {
  ok: true;
  raw: RawObservation;
  draft: SettlementEventDraft;
  event: SettlementEvent;
  signature: Hex;
}

export interface ObserveFailureResult {
  ok: false;
  failure: OracleFailure;
}

export type ObserveResult = ObserveSuccess | ObserveFailureResult;

/**
 * The composed reference flow. Fetches, normalizes, validates against the shared schema (`../hcs/envelope`), pre-checks
 * freshness (ADR §8 "#8": `MAX_DATA_LEN`, `maxValidity`) and signs. Never throws for an expected failure; every outcome is
 * `ObserveResult`. This is what #9's relayer, #13's tests and #15's E2E call — mock and real providers plug in underneath.
 */
export interface OracleAdapter {
  readonly eventSource: Hex;
  observe(request: ObserveRequest): Promise<ObserveResult>;
}
