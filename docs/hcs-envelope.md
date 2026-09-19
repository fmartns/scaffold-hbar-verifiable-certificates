# HCS evidence envelope and publisher

Status: **stable interface, envelope v1** — implemented in issue #6, consumed by #10 (Mirror audit) and #12 (console).
Normative source: [ADR-001](architecture.md) §4.3 (identifiers), §6.1 (`SettlementEvent`), §6.3 (message format), §8 (#6).
Code: [`packages/sdk/hedera/hcs/`](../packages/sdk/hedera/hcs/), re-exported from `@sh/sdk`.

HCS is the **evidence trail** between the oracle and the `SettlementRouter`. It is not the source of truth: being in the topic does not make an event valid (ADR D3). Validity is decided only by the router.

**Rule for every other issue:** build, encode and decode the message with `envelope.ts` only. Do not write a second parser, a JSON variant or your own identifier formulas.

## 1. Wire format

```
message = 0x01 || abi.encode(SettlementEvent) || signature      (binary; no JSON, no canonicalization)
```

| Part | Size | Content |
|---|---|---|
| Format version | 1 byte | `0x01`. Version of the *message format*, not of the event. |
| Event | `32 + 320 + 32 + pad32(len(data))` | `abi.encode` of the `SettlementEvent` struct: offset word, ten head words, `data` length word, `data` padded to 32 bytes. Exactly what the signer signed and what `settle` receives. |
| Signature | 65 bytes | `r ‖ s ‖ v`, secp256k1, `v ∈ {27, 28}`, low-`s`. |

Total size is `450 + pad32(len(data))` bytes: **482** for a 32-byte `data`, **962** at the maximum `MAX_DATA_LEN = 512`, under the 1024-byte HCS limit. Chunking is never used.

**Nothing derived is in the message.** `eventKey`, `settlementId`, `contentHash`, `attestationDigest` and `signer` are recomputed by every reader, so the message cannot contradict itself. Readability in HashScan was traded for verifiability; the console (#12) decodes it.

Decoding is **strict**: `decodeMessage` re-encodes what it parsed and requires byte-for-byte equality, so trailing bytes and non-canonical offsets are rejected.

## 2. The event (`SettlementEvent`)

| Field | Type | Rule enforced before publishing | Purpose |
|---|---|---|---|
| `version` | `uint16` | must be `1` | Event schema version |
| `eventSource` | `bytes32` | non-zero | Namespace of the provider (`keccak256(lowercase ASCII name)`) |
| `externalEventId` | `bytes32` | non-zero | Identity inside the source (rules R1–R6 of the ADR) |
| `streamId` | `bytes32` | zero = unordered | Optional ordered stream |
| `streamSeq` | `uint64` | `0` iff `streamId` is zero, else `≥ 1` | Position in the stream |
| `observedAt` | `uint64` | fits uint64 | Unix seconds the oracle observed the fact |
| `validUntil` | `uint64` | `> observedAt` | Unix seconds the attestation expires |
| `submitter` | `address` | valid address (EIP-55 if mixed case) | `0x0…0` = any caller may submit |
| `policyId` | `bytes32` | non-zero | Policy (with version) that interprets `data` |
| `data` | `bytes` | even-length hex, `≤ 512` bytes | Policy-specific facts |

`validateSettlementEvent` reports **every** problem at once, by field, with a code (`REQUIRED`, `INVALID_FORMAT`, `OUT_OF_RANGE`, `ZERO_NOT_ALLOWED`, `UNSUPPORTED_VERSION`, `TOO_LONG`, `INCONSISTENT`, `MALLEABLE_SIGNATURE`, `SIGNER_MISMATCH`).

Inputs are normalized: `uint64` accepts `bigint`, safe-integer `number` or decimal `string`; hex is lowercased. The same logical event always yields the same bytes.

The publisher checks **structure**, not policy: freshness (`maxAge`, `maxValidity`), the registered signer and uniqueness are the router's job (ADR §6.4). Freshness should also be pre-checked before signing (#8).

## 3. Identifiers derived from the message (ADR §4.3)

| Value | Formula | Bound to chain/router? | Use |
|---|---|---|---|
| `eventKey` | `keccak256(abi.encode(EVENT_KEY_TAG, eventSource, externalEventId))` | No | **Idempotency key**; join key across networks |
| `settlementId` | `keccak256(abi.encode(SETTLEMENT_TAG, chainId, router, eventKey))` | Yes | Global id in audit and logs |
| `contentHash` | `keccak256(abi.encode(CONTENT_TYPEHASH, eventSource, externalEventId, streamId, streamSeq, policyId, keccak256(data)))` | No | Detects *different facts for the same event* |
| `attestationDigest` | EIP-712 digest of the event (below) | Yes (domain) | What was signed; **deduplication key of HCS messages** |
| `signer` | `ecrecover(attestationDigest, signature)` | — | Recovered signer; the router decides if it is the registered one |

`abi.encode` of static words is plain concatenation, so the encoding is injective. Tags: `EVENT_KEY_TAG = keccak256("hedera-verifiable-settlement.event.v1")`, `SETTLEMENT_TAG = keccak256("hedera-verifiable-settlement.settlement.v1")`.

> **Gap to close in #9.** ADR §4.3 names `CONTENT_TYPEHASH` but does not give its string. This SDK defines it as
> `SettlementContent(bytes32 eventSource,bytes32 externalEventId,bytes32 streamId,uint64 streamSeq,bytes32 policyId,bytes32 dataHash)`
> (`CONTENT_TYPE_STRING`). The router must use the same string, or this one constant changes. It does not affect the wire message (which carries no `contentHash`), only the value the publisher reports and the router stores.

### Signing (EIP-712)

- Types: `SettlementEvent(uint16 version,bytes32 eventSource,bytes32 externalEventId,bytes32 streamId,uint64 streamSeq,uint64 observedAt,uint64 validUntil,address submitter,bytes32 policyId,bytes data)` — a test pins the exported types to this exact string.
- Domain: `{ name: "HederaVerifiableSettlement", version: "1", chainId, verifyingContract: <SettlementRouter> }`. The chain id comes from the selected network (295 mainnet, 296 testnet, 298 local).

```ts
import { SETTLEMENT_EVENT_TYPES, eip712Domain } from "@sh/sdk";
const signature = await wallet.signTypedData(
  eip712Domain({ chainId: 296, verifyingContract: routerAddress }),
  SETTLEMENT_EVENT_TYPES,
  event,
);
```

Because the domain includes chain and router, an attestation for testnet or for another deployment recovers a different signer and is rejected (replay class E). `eventKey` deliberately does **not** include them, so audit can join the same event across deployments.

### Golden vectors

The unit tests pin these values (test key `0x01…01`, router `0x5fbdb2315678afecb367f032d93f642f64180aa3`, chain 296, the event of `test-fixtures.ts`). #9 must reproduce them:

| | |
|---|---|
| `eventKey` | `0xa443f61dfefa9b88087f5580a4365b62f4ff0f44b0cbd672d3323946ed6a27b8` |
| `settlementId` | `0x131e2da33ac18ad10a946d80f3d56cc5a5929d05acf69372fae39fe46a85d9af` |
| `contentHash` | `0x217eb9b439c7478c295d3484ab573bf880892c15d3e5df2cd6bbb0c529bdfa91` |
| `attestationDigest` | `0x6b61fe09abfef4297d0e324de7c510eab9d5b4d6e9021789a34da052b604c905` |
| message size / SHA-256 | 482 bytes / `0xf94367aef65c087723224cb860362ac51deb0d3e76781049f93088602fae2be2` |

### Idempotency and replay, as they show up here

| Situation | Behaviour |
|---|---|
| Same event re-attested (new `observedAt`/`validUntil`) | same `eventKey`, same `contentHash`, **different** `attestationDigest` |
| Same attestation published twice (retry) | two HCS messages with the **same** `attestationDigest`; consumers dedupe by it (`HCS_DUPLICATE_BENIGN` in #10) |
| Different facts for one `eventKey` | different `contentHash` (`HCS_EQUIVOCATION` in #10) |
| Other router or chain | different `settlementId` and digest; same `eventKey` |

## 4. Reading a message (for #10 and #12)

Mirror Node returns the message base64-encoded at `GET /api/v1/topics/{topic}/messages/{sequence}` (direct lookup, ADR §5.3). Decode with the same code the publisher used:

```ts
import { decodeMessage } from "@sh/sdk";
const bytes = Uint8Array.from(Buffer.from(body.message, "base64"));
const decoded = decodeMessage(bytes, { chainId, verifyingContract: routerAddress });
if (decoded.ok) decoded.value.derived.attestationDigest; // compare with SettlementExecuted.attestationDigest
else decoded.issues; // [{ field: "message", code, message }]
```

Compare `audit.messageSha256` (from the publisher) with `sha256(bytes)` to prove the fetched message is the published one. HCS has no content search (P6): index by scanning a timestamp window and keying on `eventKey`/`attestationDigest`.

## 5. Publisher service

### Configuration (no hardcoded values)

| Variable | Required | Meaning |
|---|---|---|
| `HEDERA_HCS_TOPIC_ID` | yes | Topic `0.0.x` on the selected network. Its `submitKey` must be the operator key (ADR §6.3). |
| `HEDERA_SETTLEMENT_ROUTER_ADDRESS` | yes | Router EVM address: the `verifyingContract` of the signing domain. |
| `HEDERA_HCS_PUBLISH_TIMEOUT_MS` | no | Overall deadline of one publish, 1000–120000, default 30000. |
| `HEDERA_NETWORK`, `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY` | yes | As in [integration.md](integration.md#environment-validation). |

The operator key is read only to create the Hedera client. It is never part of the configuration object, of a result or of an error.

### Public interface

```ts
// 1. Optional but recommended at startup: environment (#5) + configuration + topic (exists, has a submitKey, it is ours).
const pre = await preflightHcsPublisher(process.env);
if (!pre.ok) { /* pre.error: HcsPublishFailure */ }

// 2. Build the publisher from the environment (throws HcsPublishError CONFIG_INVALID) and publish.
const { publisher, close } = await createHcsPublisherFromEnv(process.env, { expectedSigner: oracleSignerAddress });
const result = await publisher.publish({ event, signature });   // never throws for publish problems
close();
```

Responsibilities, one function each: **build/validate** `buildEnvelope` · **serialize** `encodeMessage` · **publish** `HcsTransport.submit` (adapter: `createHieroTransport`) · **result handling** `interpretReceipt` / `classifyPublishError` · **audit metadata** `buildEvidence`. Everything is pure or takes injected dependencies (`fetch`, transport, clock): no `console`, CLI, prompts or storage. For tests, `createHcsPublisher(config, fakeTransport)` runs with no network.

### Result

`publish` returns `PublishSuccess | { ok: false, status: "failed", error }`. Use `unwrapPublish(result)` if you prefer exceptions (`HcsPublishError`).

`PublishSuccess` is JSON-safe (only strings and numbers): **persist it as it is**. It is the durable record for correlation.

| Field | Meaning |
|---|---|
| `status` | `"published"` |
| `event` | `eventKey`, `settlementId`, `attestationDigest`, `contentHash`, `eventSource`, `externalEventId`, `signer` |
| `topicId`, `network` | Where it was published |
| `transactionId` | Hedera transaction id (`0.0.123@1712345678.123456789`). **Persist this.** |
| `mirrorTransactionId` | Same, Mirror format (`0.0.123-1712345678-123456789`) |
| `hcsRef` | `{ sequence, consensusTimestampNs }` (decimal strings): the ADR's `HcsRef` **claim** to pass to `settle` |
| `consensusTimestamp`, `runningHash` | From the record and receipt respectively (NV-6) |
| `hashscanUrl` | HashScan page of the transaction, addressed by consensus timestamp; `null` only on `local`, which has no public explorer |
| `hashscanTopicUrl` | HashScan page of the topic |
| `audit` | `schema`, `messageFormatVersion`, `messageBytes`, `messageSha256`, `network`, `chainId`, `routerAddress`, `mirrorMessageUrl`, `recordedAt` |

**D11 (publish → receipt → release).** `publish` resolves only after consensus. Release the attestation to relayers **only when `ok` is true**, and pass them `hcsRef`. `hcsRef` is a claim: the router cannot verify it (P4).

### Errors

Branch on `error.code` and `error.outcome`, never on message text or Hedera SDK classes.

| `code` | Meaning | `outcome` | `retryable` | Caller should |
|---|---|---|---|---|
| `CONFIG_INVALID` | Missing/invalid env (topic, router, timeout, network, operator) | `not_sent` | no | Fix `configIssues` (variable + remediation) |
| `INVALID_EVENT` | Event or signature failed validation, or signer mismatch | `not_sent` | no | Fix `issues` (field + code); nothing was sent |
| `TOPIC_INVALID` | Topic does not exist, deleted or expired (`INVALID_TOPIC_ID`) | `rejected` / `not_sent` | no | Check `HEDERA_HCS_TOPIC_ID` and network |
| `TOPIC_NOT_WRITABLE` | No `submitKey`, or it is not the operator key (preflight) | `not_sent` | no | Use the operator key as `submitKey` |
| `NETWORK_UNAVAILABLE` | No node reachable, or `BUSY`/`PLATFORM_NOT_ACTIVE` | `not_sent`, `rejected` or `unknown` | yes | Retry per your policy |
| `TIMEOUT` | Deadline reached (own or SDK's max-attempts) | **`unknown`** | yes, **after reconciling** | Reconcile, then decide |
| `TRANSACTION_FAILED` | Network returned a failure status (see `hederaStatus`, e.g. `INVALID_SIGNATURE`, `INSUFFICIENT_PAYER_BALANCE`) | `rejected` | no | Fix the cause |
| `UNEXPECTED_RESPONSE` | Success without sequence/hash/timestamp, or unclassifiable failure | `unknown` / `not_sent` | no | Reconcile; report |

`outcome` says what is known about the message:

- **`not_sent`** — the network never saw it.
- **`rejected`** — the network refused it or reached consensus with a failure status. It is **not** in the topic.
- **`unknown`** — it may or may not be in the topic. `error.transactionId` is set whenever it was already known (it is generated before sending); look it up on Mirror/HashScan, or scan the topic for the `attestationDigest`, before deciding.

Every failure also carries `eventKey` and `attestationDigest` (when the envelope was built), `topicId`, `hederaStatus` (when the network gave one), `message`, `remediation` and `retryable`. Messages never contain keys or the raw text of SDK errors.

### Retries: the service never retries

A retry is a **policy of the caller**, because HCS has no exactly-once publication (ADR §3.7). What the service guarantees:

- It sends **one** transaction per `publish`. The Hedera adapter never regenerates the transaction id, so any retry the SDK does between nodes re-sends the *same* transaction, which the network deduplicates.
- After an `unknown` outcome, republishing is **at-least-once and benign** (ADR §5.5): the result is two messages with the same `attestationDigest`, which consumers dedupe. Reconcile first when you can.
- Concurrent `publish` calls for the same attestation inside one process share one network call. Across processes, dedupe by persisting the result keyed by `attestationDigest` (or `eventKey`) before releasing.
- The router, not HCS, prevents double settlement (`records[eventKey]`); a duplicate HCS message cannot cause one.

## 6. Topic requirements

`preflightHcsPublisher` (which runs the #5 validator first) and `verifyHcsTopic` check, via Mirror Node: the topic exists and is not deleted; it **has a `submitKey`** (P5); that key is the operator's public key (a key list or threshold key cannot be confirmed for a single operator and is reported as `TOPIC_NOT_WRITABLE`). Omit `adminKey` in production (ADR §6.3).

### Create the topic with a command

```bash
yarn hcs:topic                 # shows what will be created and what it may cost, asks [Y/n], then creates
yarn hcs:topic --write         # also sets HEDERA_HCS_TOPIC_ID in the root .env (only that line is touched)
yarn hcs:topic --smoke-test    # afterwards, publishes one message and reads it back from Mirror Node
```

Options: `--yes`/`-y` (do not ask; required when there is no terminal, e.g. CI, and with `--json`), `--memo "<text>"` (≤ 100 bytes), `--with-admin-key` (also sets the operator key as `adminKey`; the ADR says to omit it in production), `--allow-mainnet`, `--json`. Exit codes are those of `yarn setup`: `0` ok, `1` something to fix or declined, `2` network unreachable.

**Before creating, it shows the plan and the cost, and asks.** Enter or `y` agrees (`[Y/n]`). On mainnet only the word `yes` agrees, and `--allow-mainnet` is also required. Without a terminal and without `--yes` it refuses (still showing the plan), so nothing is ever created by accident.

| | Estimate | Measured on Testnet |
|---|---|---|
| Create the topic (with `submitKey`) | about US$ 0.02 | 0.2563 HBAR, US$ 0.0198 |
| One message (about 650 bytes) | about US$ 0.0005 | 0.0055 HBAR, US$ 0.0004; grows with the size |

The HBAR figure uses the current rate from Mirror Node (`/api/v1/network/exchangerate`). Testnet HBAR has no monetary value; on mainnet these are real charges. If the rate cannot be fetched, only USD is shown. After creating, the **exact charge** is read from Mirror Node (`charged_tx_fee`) and shown.

What it does, in order:

1. Validates the Hedera environment with the #5 validator. Nothing is sent while it is invalid, and the report is the same as `yarn setup`'s.
2. If `HEDERA_HCS_TOPIC_ID` is already set it **does not create another topic**: it checks that the configured one exists and that its `submitKey` is the operator key, then says nothing was created or charged. A configured-but-unusable topic is an error that tells you to empty the variable to create a new one.
3. Refuses mainnet unless `--allow-mainnet`.
4. Shows the plan and cost and asks.
5. Creates the topic with `submitKey` = the operator key. One attempt, no retry. After a timeout the result is `unknown` and it tells you to check the account on HashScan (with the transaction id) instead of running again, because a second run would leave a duplicate topic.
6. Confirms on Mirror Node that the topic exists with the right `submitKey`, waiting up to ~20 s for indexing. If Mirror is slow it still reports success, with a warning to run `yarn setup` later.
7. Explains what was created: topic id, transaction, who can write (only the operator key) and read (anyone), admin key, cost, HashScan link and the `.env` line.

**`--smoke-test`** proves the whole path with one real message: it signs, publishes through the same publisher the system uses, reads the message back from Mirror Node by topic and sequence, decodes it with the shared envelope code, and checks that the digest **and the signer** match what was sent. It reports the timings and the fee charged. It works on a new topic or on an already configured one (`yarn hcs:topic --smoke-test`).

The smoke-test message is a throwaway attestation: source `hedera-verifiable-settlement.smoke-test`, signed by a random key that exists only for that call, bound to the configured router (or a placeholder while there is none). No router accepts that source, so it can never settle anything. It **stays in the topic permanently**, which is why it is opt-in. Prefer running it on a topic you just created for development.

The same logic is available as `provisionHcsTopic(env, options)` and `runPublishSmokeTest(env, options)` in `@sh/sdk` (pure, with injectable `fetch`, creator/transport, signer, clock and `confirm`); `packages/sdk/cli/create-topic.ts` only formats output, asks the question and edits `.env`.

## 7. Tests

| Suite | Command | Network |
|---|---|---|
| Unit (envelope, config, errors, publisher, topic check and creation, cost, smoke test, SDK adapters, CLI) | `yarn test` | none: deterministic fixtures and fakes |
| Integration | `HCS_INTEGRATION=1 yarn workspace @sh/sdk test:integration` | Hedera Testnet: publishes one real message, checks the transaction id and HashScan link, fetches the message from Mirror Node and decodes it with the shared envelope code; also checks `TOPIC_INVALID` |

The integration test is skipped unless `HCS_INTEGRATION=1`. It reads `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY` and `HEDERA_HCS_TOPIC_ID` from the environment or the root `.env`, and uses a placeholder router address if `HEDERA_SETTLEMENT_ROUTER_ADDRESS` is unset.

## 8. Compatibility rules

- The envelope is **v1**. Any change to a field, its order, an identifier formula or a constant is a **breaking change**: bump `HCS_MESSAGE_FORMAT_VERSION` (and `SETTLEMENT_EVENT_VERSION` if the struct changes), keep decoding v1, and update ADR-001 first.
- New fields never go into the message ad hoc. Document-level extensions belong inside `data` (covered by `contentHash`), as the ADR prescribes for #26.
- `PublishSuccess` and `HcsPublishFailure` may gain optional fields; existing fields keep their meaning.
