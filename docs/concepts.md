# Concepts

## Product narrative

The template issues, verifies and revokes **verifiable credentials on Hedera** (direction decided in
[#21](https://github.com/fmartns/scaffold-hbar-verifiable-settlement/issues/21)). The plain-language version of this
section, for non-technical readers, is at the top of the [README](../README.md).

### Problem

Organizations that issue credentials (technology events, courses, corporate training, schools, professional
certification bodies) need third parties to verify them without trusting the issuer blindly and without exposing the
holder's personal data. Today the only source of truth is usually the issuer's own server: it can go offline, be
edited without a trace, and has no public, durable record of a revocation.

### Personas

| Persona | Who | Needs |
|---|---|---|
| Issuer | Event organizer, course, school, certification body | Credentials nobody can forge in its name; the ability to revoke; no trust infrastructure of its own |
| Verifier | Employer, another institution, anyone with the link or QR code | A yes/no answer on authenticity and current status, with no account, wallet or key, and without trusting the issuer's site |
| Developer | Builder adopting the template | A contract, SDK, audit and scripts that work out of the box, where only the example is replaced |

### Generic by design

The motivating case, an **event attendance certificate**, is the demo
([#42](https://github.com/fmartns/scaffold-hbar-verifiable-settlement/issues/42)), not the scope. Nothing in
`CredentialRegistry` or the credential envelope knows about events: they handle issuer namespaces, an
`externalCredentialId`, the hash of the off-chain document, a salted `subjectCommitment` and a `schemaId` that each
application defines. Courses, diplomas, professional certifications, badges and corporate training use the same code.

### Why each integration is load-bearing

| Integration | Role | Without it |
|---|---|---|
| `CredentialRegistry` (Solidity) | Source of truth for `statusOf(credentialId)`. Authorizes issuer signers per namespace (EIP-712), records each `credentialId` once, makes revocation final | Status is whatever the issuer's server says. Nothing stops an issuer-side operator from rewriting a credential's hash or subject, re-issuing a revoked id, or silently un-revoking. The contract rules all of these out for every role, and every revocation records `revokedBy` and `byAdmin` ([credential-registry.md](credential-registry.md)) |
| Hedera Consensus Service | Ordered, timestamped evidence of each issuance (`0x10`) and revocation (`0x11`), signed by the issuer and committed before the transaction | Only the current state survives. Nobody can prove what the issuer signed and when, check commit-before-execute, or detect equivocation (two validly signed contents for one `credentialId`) ([credential-audit.md](credential-audit.md)) |
| Mirror Node | Read-only index of contract logs and HCS messages; `auditCredential` correlates them | The contract cannot read HCS, so nothing would link the on-chain record to its evidence without running a node. The audit needs no key and treats unindexed data as `pending`, never "missing" |

HCS is evidence, not validity: the audit report explains `statusOf` and never overrides it.

### What is implemented today

| Piece | Status | Where |
|---|---|---|
| `CredentialRegistry`: issuer registry, `issue`, `revoke`, signer rotation, pause, deploy script and tests | Implemented | [credential-registry.md](credential-registry.md) |
| Credential HCS messages: encode, decode, EIP-712 digests, `credentialId` | Implemented; format accepted by [ADR-002](architecture.md#adr-002--credentials-privacy-on-chain-vs-off-chain-and-data-model) and [credential-schema.md](credential-schema.md) | `packages/sdk/hedera/hcs/credential-envelope.ts` |
| HCS evidence topic creation (`yarn hcs:topic`) | Implemented | [hcs-envelope.md](hcs-envelope.md) |
| HCS publisher (consensus receipt, transaction ID, HashScan URL) | Implemented for the settlement envelope; publishing credential messages is part of #41 | [hcs-envelope.md](hcs-envelope.md) |
| Mirror Node credential audit (`auditCredential`, `auditHcsMessage`) | Implemented | [credential-audit.md](credential-audit.md) |
| Environment dashboard and `GET /api/env/status` | Implemented | [dashboard.md](dashboard.md) |
| SDK credential module (build, sign, publish, issue, verify, revoke) | Planned | [#41](https://github.com/fmartns/scaffold-hbar-verifiable-settlement/issues/41) |
| Issuer console | Planned | [#12](https://github.com/fmartns/scaffold-hbar-verifiable-settlement/issues/12) |
| Public verifier (`/verify/[credentialId]`, link and QR code) | Planned | [#40](https://github.com/fmartns/scaffold-hbar-verifiable-settlement/issues/40) |
| Event attendance certificate demo | Planned | [#42](https://github.com/fmartns/scaffold-hbar-verifiable-settlement/issues/42) |
| Storage of the credential document | Not included, by decision: the JSON holder document is the credential and stays with the holder | [ADR-004](architecture.md#adr-004--credential-document-no-visual-document-and-no-storage-in-the-template) |

The oracle interface and the HTS settlement adapter come from the previous direction. They remain in the repository as
history and are not on the credential critical path.

## Credential terms

| Term | Meaning | Spec |
|---|---|---|
| `CredentialEvent` | The typed record the issuer signs (EIP-712) | [credential-registry.md](credential-registry.md#credentialevent-and-signing) |
| Issuer namespace (`issuer`) | `keccak256` of the lowercase organization name, registered once with a signer | [credential-registry.md](credential-registry.md#access-control) |
| `credentialId` | Idempotency key: `keccak256(abi.encode(CREDENTIAL_KEY_TAG, issuer, externalCredentialId))`, permanent | [credential-registry.md](credential-registry.md#credentialevent-and-signing) |
| `credentialHash` / `subjectCommitment` | Hash of the off-chain document · salted commitment to the holder; never raw personal data | [credential-registry.md](credential-registry.md#credentialevent-and-signing) |
| `HcsRef` | The publisher's claim of where the evidence sits in HCS; checked off-chain, never verified on-chain | [credential-registry.md](credential-registry.md#flow) |
| Credential audit report | Correlation of `statusOf`, contract logs and HCS evidence through the Mirror Node | [credential-audit.md](credential-audit.md#report) |

## Settlement terms (ADR-001, previous direction)

Canonical terms for the settlement flow. Definitions and rules are normative in [architecture.md](architecture.md) (ADR-001); this table is only an index.

| Term | Meaning | ADR |
|---|---|---|
| Fact / oracle attestation | What the oracle observes and signs. Never an outcome. | [§3.1](architecture.md#31-roles-and-responsibilities), [§6.1](architecture.md#61-settlementevent-and-signing) |
| Settlement intent / `SettlementEvent` | The typed, signed record of a fact | [§6.1](architecture.md#61-settlementevent-and-signing) |
| HCS event envelope | `0x01 ‖ abi.encode(SettlementEvent) ‖ signature`, published before settlement | [§6.3](architecture.md#63-hcs-message-format) |
| Settlement policy | On-chain `view` component mapping facts to an outcome, bounded by caps | [§6.6](architecture.md#66-settlement-policy-interface) |
| HTS credit | The token amount minted/transferred by the router; atomic with the processed mark | [§6.7](architecture.md#67-hts-execution-obligations-7) |
| Idempotency key (`eventKey`) | `keccak256(abi.encode(EVENT_KEY_TAG, eventSource, externalEventId))`, stored permanently | [§4.3](architecture.md#43-how-the-identifiers-are-built) |
| `settlementId`, `contentHash`, `attestationDigest` | Chain-bound settlement id · conflict detector · signed digest | [§4.3](architecture.md#43-how-the-identifiers-are-built) |
| Mirror Node audit record / finding | Result of correlating HCS, contract logs and HTS records | [§6.8](architecture.md#68-mirror-node-audit-contract-10) |
| HashScan evidence | Explorer link for a Transaction ID or EVM hash of each step | [dx-benchmark.md](dx-benchmark.md) (REQ-11-03, REQ-12-02) |
