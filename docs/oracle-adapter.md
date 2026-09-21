# Oracle provider interface and deterministic mock

Status: **interface + mock implemented in issue #8**; consumed by #9 (`SettlementRouter`), #13 (automated tests), #15 (E2E).
Normative source: [ADR-001](architecture.md) §6.9 ("Oracle adapter contract"), §4.4 (identity rules R1–R6), §8 "#8".
Code: [`packages/sdk/hedera/oracle/`](../packages/sdk/hedera/oracle/), re-exported from `@sh/sdk`.

> **This is not production/demo oracle integration.** Selecting a real provider (or an on-chain feed) and wiring it into
> the flow is **issue #23**. This issue defines the contract every provider must satisfy and ships a deterministic mock
> for tests, CI and local development. If the final submission's demo runs only on this mock, oracle integration is
> decorative — #23 is what makes it load-bearing. See ADR-001 §6.9 "Provider modes for #23" and §8's note on #23.

## 1. Why three interfaces, not one

The adapter separates three concerns (ADR §6.9), so a real provider only ever has to implement the first one:

| Piece | Vendor-specific? | Who implements it |
|---|---|---|
| `OracleProvider` | **Yes — the only vendor-specific surface** | The mock (`./mock.ts`, this issue) and any real provider (#23) |
| `EventNormalizer` | No — pure, generic | A reference implementation (`normalizeObservation`) shared by every provider; a provider with richer facts may supply its own |
| `Attestor` | No — generic over the signing key | A reference implementation (`createSigningAttestor`) shared by every provider |

Nothing above `OracleProvider` ever depends on a vendor. `createOracleAdapter` composes the three into the flow every
caller uses: **fetch → normalize → validate → freshness precheck → attest**.

## 2. `OracleProvider` — the contract a real provider (#23) implements

```ts
interface OracleProvider {
  readonly eventSource: Hex;                                       // keccak256(bytes(<lowercase source name>)), ADR R6
  fetch(query: OracleQuery, options: FetchOptions): Promise<RawObservation>;
}
interface OracleQuery { ref: string; streamSeq?: bigint; params?: Record<string, unknown>; }
interface FetchOptions { signal: AbortSignal; timeoutMs: number; }
interface RawObservation {
  providerRef?: string;        // the provider's own record id (required by the reference normalizer, see §4)
  observedAt: number;          // unix seconds
  data?: Hex | bigint | number | null;
  rawRef?: string;              // opaque provenance reference, never signed
  eventType?: string;           // namespaces the identity (ADR R5)
}
```

**Timeout.** The caller (`createOracleAdapter`) constructs the `AbortController`, passes `{signal, timeoutMs}` in, and
independently races its own deadline. A provider MUST reject promptly once `signal` aborts (matching the `fetch()`
convention: reject with an error named `AbortError`). A provider that ignores the signal still gets timed out by the
adapter, but its own promise may go on running in the background — implementations should still respect it to avoid
wasted work and dangling requests.

**"No data available" is not silence.** A provider with nothing for a query MUST reject with `OracleError({ code:
"NO_DATA", retryable: true, ... })`, never resolve with `null`/`undefined` and never resolve with a placeholder. Callers
distinguish "nothing yet" (`NO_DATA`, expected) from every other failure.

**Error propagation.** A provider throws or rejects with an `OracleError` (see `./errors.ts`) for anything else:
`TIMEOUT`, `INVALID_PAYLOAD`, `PROVIDER_UNAVAILABLE`, `PROVIDER_ERROR`, `CONFIG_INVALID`, or lets `classifyOracleError`
normalize whatever its HTTP/SDK client threw (network errors, non-2xx statuses). **No vendor exception type or raw error
text is allowed to leak** past the provider boundary; the rest of the system depends only on `OracleFailure.code`.

**Payload validation.** A provider MUST validate its own upstream response before returning a `RawObservation` (structural
checks: required fields present, correctly typed) and reject with `INVALID_PAYLOAD` otherwise — see
`validateRawObservation` in `./mock.ts` for the minimal shape every provider's raw answer is expected to satisfy.

## 3. Identity (ADR §4.4, rules R1–R6) — `./identity.ts`

Every provider MUST derive `externalEventId` as **a deterministic function of the fields that identify the event, and of
nothing else** — never `observedAt`, a price at read time, a transport id, or an HCS sequence (R1–R3). Helpers:

| Helper | When to use it |
|---|---|
| `eventSourceOf(name)` | Always, once per provider: `eventSource = keccak256(bytes(lowercase(name)))` (R6) |
| `externalEventIdFromRef(providerRef, eventType?)` | The provider has a native unique id (R4); namespace by `eventType` when one source emits several kinds of event (R5) |
| `externalEventIdFromFeedRound(feedId, roundId)` | On-chain feed providers (R6: `keccak256(abi.encode(feedId, roundId))`) |
| `externalEventIdFromFields(fields)` | No native id: hash a **fixed tuple** of identity fields — never JSON (R4) |

## 4. `EventNormalizer` — pure, and the reference implementation's conventions

```ts
interface EventNormalizer { normalize(raw: RawObservation, ctx: NormalizeContext): NormalizeResult; }
interface NormalizeContext {
  eventSource: Hex; policyId: Hex; streamId?: Hex; streamSeq?: bigint; submitter?: Hex; validitySeconds: number;
}
type NormalizeResult = { ok: true; value: SettlementEventDraft } | { ok: false; issues: { field: string; message: string }[] };
```

`SettlementEventDraft` **is** `SettlementEvent` from [`hedera/hcs/envelope.ts`](../packages/sdk/hedera/hcs/envelope.ts)
(#6/#3) — the oracle produces no format of its own; there is exactly one event schema in the project. `normalize` MUST be
**pure**: same `RawObservation` + `NormalizeContext` ⇒ byte-identical draft, always (no clock, no I/O, no randomness).

The reference normalizer (`normalizeObservation`, used by the mock) requires `raw.providerRef` and accepts `raw.data` as
either already-encoded bytes (`` `0x${string}` ``, the recommended path for anything beyond a single amount), a
`bigint`/safe `number` (encoded `abi.encode(["uint256"], [value])`), or omitted. A provider whose raw shape does not fit
this may supply its own `EventNormalizer` — the contract is the interface, not this specific function.

**Every draft is validated against the shared schema** (`validateSettlementEvent` from `../hcs/envelope`) before it is
signed or handed anywhere else — this is the single point where "payload respects the trust model and schema" is
enforced, reused rather than re-implemented per provider.

## 5. `Attestor` — signs with the exact EIP-712 contract the router expects

```ts
interface Attestor { attest(draft: SettlementEventDraft, domain: AttestationDomain): Promise<Attestation>; }
interface AttestationDomain { chainId: bigint | number; verifyingContract: string; }  // the deployed SettlementRouter
interface Attestation { event: SettlementEvent; signature: Hex; }                      // 65-byte r||s||v, low-s
```

`createSigningAttestor(signer)` (any `{ address, signTypedData }`, e.g. an `ethers` `Wallet`) signs with
`SETTLEMENT_EVENT_TYPES`/`eip712Domain` from `../hcs/envelope` — the exact types #6's publisher and #9's router use. It
re-validates the draft before signing (defense in depth) and normalizes a signer failure to `ATTESTATION_FAILED`.

## 6. The composed adapter — `createOracleAdapter`

```ts
const adapter = createOracleAdapter({ provider, normalizer, attestor, timeoutMs, maxAgeSeconds, defaultValiditySeconds });
const result = await adapter.observe({ query, context, domain });
// { ok: true, raw, draft, event, signature } | { ok: false, failure: OracleFailure }
```

Steps, each independently testable: **(1) fetch** the raw observation (timed out and abortable); **(2) normalize** (pure);
**(3) validate** against the shared schema; **(4) freshness precheck** — reject an observation older than `maxAgeSeconds`
(default 300s, ADR `maxAge` starting point) or with a runaway `validitySeconds` **before spending a signature on it**;
**(5) attest**. Never throws for an expected failure; never retries by itself (a retry policy is the caller's, exactly
like the HCS publisher, #6, and the HTS adapter, #7).

## 7. Configuration — `./config.ts`

| Variable | Meaning |
|---|---|
| `ORACLE_PROVIDER` | `mock` (default) or a name a real provider registers in #23 |
| `ORACLE_TIMEOUT_MS` | Deadline of one `fetch`. Default 10000 |
| `ORACLE_MAX_AGE_SECONDS` | Freshness precheck window. Default 300 |
| `ORACLE_VALIDITY_SECONDS` | Default attestation lifetime. Default 900 |
| `ORACLE_BASE_URL`, `ORACLE_API_KEY` | Generic HTTP config a real provider may use; the mock ignores them |

**Selection is by configuration** (`createOracleAdapterFromEnv`, `./factory.ts`), never a conditional scattered through
consumer code:

```ts
import { createOracleAdapterFromEnv } from "@sh/sdk";
const oracle = createOracleAdapterFromEnv(process.env);   // "mock" by default; throws CONFIG_INVALID for an unknown name
```

`ORACLE_PROVIDERS` is a name → factory registry with only `"mock"` today. **#23 registers its real provider here** (or
supplies its own registry via `createOracleAdapterFromEnv(env, { registry })`), implementing only `OracleProvider`.
Requesting an unregistered name is a clear `CONFIG_INVALID` naming the provider and pointing to #23 — never a silent
fallback to the mock.

## 8. The mock — `./mock.ts`

`createMockOracleProvider` implements exactly `OracleProvider`; `createMockOracleAdapter` composes it with the reference
normalizer and a **fixed test signer** (`MOCK_ORACLE_SIGNER`, a well-known key that controls nothing real) into a ready
`OracleAdapter`. **It is labelled**: `eventSource` is always `eventSourceOf("mock-oracle")` (or a name you choose, as long
as you keep "mock" in it), so the console (#12) and audit (#10) can never mistake it for a real integration
(ADR REQ-12-08).

**Determinism.** A fixture is keyed by `query.ref` and always returns the exact same `RawObservation`. No wall-clock, no
`Math.random`, unless the caller injects its own `now`. This means:

- the same ref twice = the same event twice (ADR replay class A/C — useful for testing idempotency and duplicate
  detection downstream, in #9's router or #7's HTS adapter);
- two refs sharing `providerRef` but different `eventType` = two distinct events from one entity (R5);
- a fixture with `streamSeq` set out of sequence = an out-of-order stream arrival for #9's `OutOfOrder` handling;
- a fixture with unusual field types = inconsistent/malformed data.

**Scenarios**, one `MockFixture` variant each:

| `kind` | Simulates | Result |
|---|---|---|
| `"observation"` | A valid event | `observe()` succeeds |
| (no fixture) / `"no-data"` | Nothing available yet | `NO_DATA`, `retryable: true` |
| `"timeout"` | The provider hangs | Never resolves on its own; ends via the adapter's `timeoutMs` or an external abort |
| `"invalid-payload"` | A malformed upstream response | `INVALID_PAYLOAD`, via `validateRawObservation` |
| `"error"` | Any other provider failure, by code | That `OracleErrorCode`, with the given `retryable` |

```ts
import { createMockOracleAdapter, makeFixture } from "@sh/sdk";
const adapter = createMockOracleAdapter({
  fixtures: { "order-42": { kind: "observation", value: makeFixture({ providerRef: "order-42", observedAt: 1_700_000_000, data: 1_000n }) } },
});
const result = await adapter.observe({ query: { ref: "order-42" }, context: { eventSource: adapter.eventSource, policyId, validitySeconds: 900 }, domain });
```

The mock never touches the network, an env var, or a credential (see `mock.test.ts` "never touches the network or
credentials"). `hedera/oracle/oracle-to-hcs.test.ts` shows it feeding the real HCS publisher (#6) end to end, with no
network — the shape #9's relayer, #13's tests and #15's E2E reuse.

## 9. Contract for #9, #13, #15, #23

- **#9 (`SettlementRouter`)**: consumes `Attestation.event`/`signature` exactly as `../hcs/envelope`'s
  `SETTLEMENT_EVENT_TYPES`/domain define them (the attestor signs with that exact code) — no adaptation needed.
- **#13 (automated tests)** and **#15 (E2E)**: use `createMockOracleAdapter` (or `createOracleAdapterFromEnv` with
  `ORACLE_PROVIDER` unset/`"mock"`) to run the full settlement flow without credentials; use `MockFixture` variants to
  drive the failure-scenario matrix (ADR T-13/T-14 and the replay classes of §4.7).
- **#23 (real provider)**: implement `OracleProvider` only (§2), decide the identity strategy from §3 (state which R4–R6
  rule applies, e.g. native id vs on-chain feed round), and register it in `ORACLE_PROVIDERS` or pass a custom registry.
  Reuse the reference `EventNormalizer`/`Attestor` unless the vendor's raw shape needs a different normalizer. #23 also
  chooses between ADR §6.9's **signed-fact mode** (default; the adapter's signer is the trust anchor) and **on-chain feed
  mode** (an `IAttestationVerifier` reads a Chainlink/Supra/Pyth-style feed; the router still requires the same
  `SettlementEvent` fields and idempotency).

## 10. Tests

| Suite | Command | Network |
|---|---|---|
| Unit: identity, normalize (T-13 determinism), attest, adapter (composed flow, timeout, freshness), mock (scenarios, labelling, no-network), config, factory (selection, unknown-provider) | `yarn test` | none |
| `oracle-to-hcs.test.ts`: the mock feeding the real HCS publisher end to end | `yarn test` | none (fake HCS transport) |

No integration test against a real provider exists here: there is no real provider yet — that is #23's deliverable, with
its own test plan.
