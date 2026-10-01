# Credential audit (Mirror Node)

`packages/sdk/hedera/audit` correlates the HCS evidence of a credential's lifecycle (issuance and revocation) with the
state and logs of `CredentialRegistry` (#9), through the Mirror Node. It returns one report type that the public
verifier (#40), the issuer console ([issuer-console.md](issuer-console.md)) and the testnet validation (#18) consume as-is. None of them re-implements
the correlation rules.

```ts
import { auditCredential, auditHcsMessage, createCredentialAuditContext, loadCredentialAuditConfig } from "@sh/sdk";

const ctx = createCredentialAuditContext(loadCredentialAuditConfig(process.env));
const report = await auditCredential(credentialId, ctx); // or: await auditHcsMessage(sequence, ctx)
```

Configuration: `HEDERA_NETWORK`, `HEDERA_HCS_TOPIC_ID`, `HEDERA_CREDENTIAL_REGISTRY_ADDRESS` and
`HEDERA_AUDIT_POLL_TIMEOUT_MS` (optional, default 20000). No secret is needed: the audit is read-only.

## Principles

- **The contract is the authority.** `statusOf(credentialId)`, read over JSON-RPC, decides `issued`, `revoked` or
  `not_found`. The report explains that state with evidence and never overrides it (ADR-001 D10).
- **HCS is evidence, not validity.** The contract cannot read HCS. The `HcsRef` emitted in `CredentialIssued` is a
  claim that the audit checks off-chain.
- **Eventual consistency is explicit.** Every Mirror read that expects data polls with exponential backoff (500 ms,
  doubling, capped at 5 s) until `pollTimeoutMs`. Data still absent is reported as `*_PENDING` while the fact is
  younger than the index budget (60 s, ADR-001 §6.2), and as missing only after that. A retryable Mirror failure
  (network, HTTP 5xx or 429) is retried inside the same deadline. If the Mirror Node is still failing at the deadline,
  the report says `unavailable`, never "missing".
- **Expected failures are findings, not exceptions.** An unreachable RPC or Mirror Node, or an undecodable message,
  still produces a report.
- **Provenance.** Every report records the Mirror Node and RPC origins (never a full URL), the query time and the
  highest consensus timestamp it observed.

## How correlation works

`auditCredential(credentialId)`:

1. Reads `statusOf`. If the status is `not_found`, the audit stops (`evidence: "not_applicable"`).
2. Fetches the `CredentialIssued` log (`topic1 = credentialId`) in a window around `issuedAt`. Topic-filtered log
   queries always carry a timestamp range (ADR P6).
3. Fetches the HCS message at the claimed `hcsSequence`, decodes it with the credential envelope, and checks the
   message kind, `credentialId`, EIP-712 digest, signer, content (hash, subject, issuer), the consensus timestamp claim,
   and commit-before-execute (HCS consensus earlier than the transaction).
4. If revoked: fetches the `CredentialRevoked` log, then the HCS revocation evidence, either by a known sequence or by
   scanning the topic from `revokedAt − 1 h`. Noise and messages of other kinds or other credentials are ignored. It
   checks that the evidence is signed by the on-chain `revokedBy` and was committed before the transaction.

`auditHcsMessage(sequence)` starts from one message. It decodes the message, audits its credential, and states how
that message relates to the record: the referenced evidence, a benign duplicate (same content, re-signed or
re-published), an equivocation (validly signed, different content), valid evidence not on-chain yet, or a published
revocation that was never executed.

## Report

| Field | Meaning |
|---|---|
| `onChain.status` | `issued`, `revoked`, `not_found`, or `unknown` (RPC unreachable) |
| `evidence` | `consistent`, `pending_index` (retry later), `inconsistent` (a high or medium finding), `unavailable`, `not_applicable` |
| `issuance`, `revocation` | Both sides (HCS and contract) with HashScan links, plus `matched` |
| `timeline` | `hcs.issuance`, `chain.issued`, `hcs.revocation`, `chain.revoked`, ascending by consensus timestamp |
| `findings` | `{ code, severity, message }`, codes below |
| `provenance` | Network, Mirror and RPC origins, registry, topic, query time, highest consensus timestamp seen |

| Code | Severity | Meaning |
|---|---|---|
| `ONCHAIN_LOG_PENDING` / `ONCHAIN_LOG_MISSING` | info / high | `statusOf` shows the fact, but its log is not indexed yet, or is still absent after the budget |
| `HCS_PENDING_INDEX` / `HCS_MISSING` | info / high | The HCS message claimed by the issuance is not indexed yet, or is still absent after the budget |
| `HCS_NOT_FOUND` | medium | A sequence the caller asked for was not found within the poll timeout |
| `HCS_UNDECODABLE` | high | The message is not a valid credential message |
| `HCS_REF_MISMATCH` | medium | The message or its consensus timestamp does not match the on-chain claim |
| `HCS_DIGEST_MISMATCH`, `HCS_SIGNER_MISMATCH`, `HCS_CONTENT_MISMATCH` | high | The evidence differs from the on-chain record |
| `HCS_AFTER_ONCHAIN` | high | Commit-before-execute violated |
| `HCS_DUPLICATE_BENIGN` | info | Another valid message with the same content |
| `HCS_EQUIVOCATION` | high | Another validly signed message with different content |
| `HCS_NOT_ONCHAIN` | info | Valid evidence whose credential is not registered on-chain |
| `REVOCATION_EVIDENCE_PENDING` / `REVOCATION_EVIDENCE_MISSING` | info / medium | Revoked on-chain; no HCS revocation evidence yet, or none after the budget |
| `REVOCATION_SIGNER_MISMATCH` | high | The evidence is not signed by `revokedBy` |
| `REVOCATION_AFTER_ONCHAIN` | medium | The evidence was committed after the revocation transaction |
| `REVOCATION_NOT_EXECUTED` | info | Revocation published to HCS, but the credential is still issued on-chain |
| `MIRROR_UNAVAILABLE`, `REGISTRY_UNAVAILABLE` | info | Could not read the source; `evidence` is `unavailable` |

## Credential HCS messages

The audit decodes messages with `packages/sdk/hedera/hcs/credential-envelope.ts`, the only credential parser. The
issuance message carries the v1 struct of the credential model in [credential-schema.md](credential-schema.md) (#38).
The revocation message stays a proposal until ADR-002 (#39). The credential module (#41) must publish with this format:

```
issuance   = 0x10 || abi.encode(CredentialEvent)      || signature   // EIP-712, signed by the issuer signer
revocation = 0x11 || abi.encode(CredentialRevocation) || signature   // EIP-712, signed by the revoker
CredentialRevocation(uint16 version,bytes32 credentialId,bytes32 issuer,bytes32 reasonCode,uint64 signedAt)
```

Both are signed under the `CredentialRegistry` domain. `revoke(credentialId)` is authorized by `msg.sender`, so the
revocation signature is evidence only: the audit compares its signer with the on-chain `revokedBy`. The first byte
never collides with the settlement envelope (`0x01`).

## Tests

- Unit tests (`packages/sdk/hedera/audit/*.test.ts`, no network) use the shared deterministic fixtures
  (`@sh/sdk/testing`, see [testing.md](testing.md)) shaped like the Mirror REST and JSON-RPC answers. They include indexing lag (records hidden for N reads), forced HTTP failures, and a virtual
  clock so polling is exact and instant.
- `packages/hardhat/test/CredentialAudit.test.ts` pins the SDK's event signatures, type string, `credentialId` formula
  and digest to the compiled contract. It then audits a real issuance and revocation from actual receipt logs.
- `packages/hardhat/test/CredentialLifecycle.flow.test.ts` drives issuer → HCS → registry → audit end to end, including
  failed publication, Mirror lag, mismatched evidence, replays and admin revocation.
- `audit.integration.test.ts` runs against the real Testnet Mirror Node. It is opt-in because real indexing latency
  makes it timing-dependent: `AUDIT_INTEGRATION=1 AUDIT_CREDENTIAL_ID=0x... yarn workspace @sh/sdk test:integration`.
