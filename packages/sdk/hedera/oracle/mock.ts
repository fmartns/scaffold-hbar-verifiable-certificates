/**
 * Deterministic mock `OracleProvider` (issue #8; ADR §8 "#8"). Exists exclusively for unit tests, integration tests, the
 * E2E flow (#15), automated tests (#13) and local development without credentials. It is deliberately labelled as a mock
 * (`eventSource` name always contains "mock", ADR REQ-12-08) so nothing downstream — the console (#12), the audit (#10),
 * a demo — can mistake it for a real integration.
 *
 * THIS IS NOT PRODUCTION/DEMO ORACLE INTEGRATION. Selecting and wiring a real provider (or an on-chain feed) is issue
 * #23; this mock alone does not satisfy that requirement. See ../../../docs/oracle-adapter.md.
 *
 * Determinism: a fixture keyed by `query.ref` always returns the same `RawObservation` (byte-for-byte), so the same
 * query always produces the same `externalEventId`/`eventKey`/`contentHash` — calling `observe` twice with the same ref
 * is, by construction, the "duplicate event" scenario (ADR replay class A/C), and two refs that share identity fields
 * (`providerRef`, `eventType`) but differ elsewhere are "out of order" or "conflicting content" depending on what differs.
 * No wall-clock and no `Math.random` are used unless the caller supplies its own `now`.
 */
import { Wallet } from "ethers";
import { OracleError } from "./errors";
import { eventSourceOf } from "./identity";
import { normalizeObservation } from "./normalize";
import { createSigningAttestor } from "./attest";
import { createOracleAdapter } from "./adapter";
import type { CreateOracleAdapterOptions } from "./adapter";
import type { FetchOptions, OracleAdapter, OracleProvider, OracleQuery, RawObservation } from "./types";

/** A fixed, well-known test key. Controls nothing real; exists only so mock signatures are deterministic. */
export const MOCK_ORACLE_SIGNER_KEY = `0x${"0f".repeat(32)}`;
export const MOCK_ORACLE_SIGNER = new Wallet(MOCK_ORACLE_SIGNER_KEY);
export const MOCK_EVENT_SOURCE_NAME = "mock-oracle";

export type MockFixture =
  | { kind: "observation"; value: RawObservation }
  /** The provider legitimately has nothing for this query yet (ADR: expected, not an error). */
  | { kind: "no-data" }
  /** Never resolves before the caller's timeout, to exercise the TIMEOUT path deterministically. */
  | { kind: "timeout" }
  /** Resolves, but with a shape `INVALID_PAYLOAD`-checkable by the normalizer/validator (missing/wrong-typed fields). */
  | { kind: "invalid-payload"; value: unknown }
  /** Rejects with a specific normalized failure, to exercise a chosen error path deterministically. */
  | { kind: "error"; code: import("./errors").OracleErrorCode; message?: string };

export interface MockOracleProviderOptions {
  eventSource?: string;
  /** Fixtures keyed by `query.ref`. A ref with no fixture is `NO_DATA` (ADR: absence is not silence). */
  fixtures?: Record<string, MockFixture>;
  /** Called for every `fetch`, in order — lets a test assert what was actually requested. */
  onFetch?: (query: OracleQuery) => void;
}

/** Deterministic, reproducible fixture builder: same inputs, same `RawObservation`, every time (no clock, no randomness). */
export function makeFixture(input: {
  providerRef: string;
  observedAt: number;
  data?: RawObservation["data"];
  eventType?: string;
  rawRef?: string;
}): RawObservation {
  return {
    providerRef: input.providerRef,
    observedAt: input.observedAt,
    data: input.data ?? null,
    eventType: input.eventType,
    rawRef: input.rawRef ?? `mock:${input.providerRef}`,
  };
}

/** Structurally invalid payloads, for the `INVALID_PAYLOAD` scenario. Each is missing or mistypes a required field. */
export const INVALID_PAYLOAD_SAMPLES = {
  missingObservedAt: { providerRef: "bad-1" },
  wrongTypeObservedAt: { providerRef: "bad-2", observedAt: "not-a-number" },
  negativeObservedAt: { providerRef: "bad-3", observedAt: -1 },
  nullPayload: null,
  arrayPayload: [1, 2, 3],
} as const;

/** Structural validation the reference normalizer relies on: catches malformed provider payloads before they are used. */
export function validateRawObservation(
  value: unknown,
): { ok: true; value: RawObservation } | { ok: false; message: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, message: "the observation must be a plain object." };
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.observedAt !== "number" ||
    !Number.isFinite(v.observedAt) ||
    !Number.isSafeInteger(v.observedAt) ||
    v.observedAt < 0
  ) {
    return { ok: false, message: "observedAt must be a non-negative safe integer (unix seconds)." };
  }
  if (v.providerRef !== undefined && typeof v.providerRef !== "string") {
    return { ok: false, message: "providerRef must be a string when present." };
  }
  return { ok: true, value: v as unknown as RawObservation };
}

/**
 * The mock `OracleProvider`: implements exactly `OracleProvider` (see `./types`), so it is interchangeable with a real
 * provider (#23) purely by configuration/DI — see `./factory`. No network, no credentials.
 */
export function createMockOracleProvider(options: MockOracleProviderOptions = {}): OracleProvider {
  const eventSource = eventSourceOf(options.eventSource ?? MOCK_EVENT_SOURCE_NAME);
  const fixtures = options.fixtures ?? {};

  return {
    eventSource,
    async fetch(query: OracleQuery, fetchOptions: FetchOptions): Promise<RawObservation> {
      options.onFetch?.(query);
      const fixture = fixtures[query.ref];

      if (!fixture || fixture.kind === "no-data") {
        throw new OracleError({
          code: "NO_DATA",
          message: `No observation is available yet for "${query.ref}".`,
          remediation: "This is expected when the fact has not happened yet; query again later.",
          retryable: true,
          query: query.ref,
        });
      }

      if (fixture.kind === "timeout") {
        // Never resolves on its own; only the adapter's timeout (or an external abort) ends this.
        return new Promise<RawObservation>((_, reject) => {
          fetchOptions.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        });
      }

      if (fixture.kind === "error") {
        throw new OracleError({
          code: fixture.code,
          message: fixture.message ?? `Mock-configured failure (${fixture.code}) for "${query.ref}".`,
          remediation: "Configure a different fixture for this query to get a different outcome.",
          retryable: fixture.code === "PROVIDER_UNAVAILABLE" || fixture.code === "TIMEOUT",
          query: query.ref,
        });
      }

      if (fixture.kind === "invalid-payload") {
        const checked = validateRawObservation(fixture.value);
        if (!checked.ok) {
          throw new OracleError({
            code: "INVALID_PAYLOAD",
            message: `The provider's response is not a valid observation: ${checked.message}`,
            remediation:
              "This scenario is intentional (a malformed upstream payload); a real provider must be validated the same way.",
            retryable: false,
            query: query.ref,
          });
        }
        // The fixture claimed to be invalid but happened to pass structural validation; that is a test-authoring bug.
        return checked.value;
      }

      return fixture.value;
    },
  };
}

export interface MockOracleAdapterOptions
  extends
    MockOracleProviderOptions,
    Pick<CreateOracleAdapterOptions, "timeoutMs" | "maxAgeSeconds" | "defaultValiditySeconds" | "now"> {
  /** Overrides the fixed test signer's raw private key (rarely needed; determinism does not require it). */
  signer?: string;
}

/**
 * A ready-to-use mock `OracleAdapter`: the mock provider, the reference normalizer and a fixed-key signing attestor,
 * composed exactly like a real deployment would compose its own provider (ADR §6.9). MOCK ORACLE — see the module doc.
 */
export function createMockOracleAdapter(options: MockOracleAdapterOptions = {}): OracleAdapter {
  const signer = options.signer ? new Wallet(options.signer) : MOCK_ORACLE_SIGNER;
  return createOracleAdapter({
    provider: createMockOracleProvider(options),
    normalizer: { normalize: normalizeObservation },
    attestor: createSigningAttestor(signer),
    timeoutMs: options.timeoutMs,
    maxAgeSeconds: options.maxAgeSeconds,
    defaultValiditySeconds: options.defaultValiditySeconds,
    now: options.now,
  });
}
