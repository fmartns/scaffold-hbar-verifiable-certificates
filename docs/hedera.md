# Hedera in this template

Every Hedera object the template creates, who writes it, who reads it, and what would break without it. Two services:
the Consensus Service carries the credentials' public objects, their revocation state and the PDFs; the Smart
Contract Service carries the accreditation registry. Each passes the "remove it and see what breaks" test.

## Objects

| Object | Written by | Who can write | Read by | How it is resolved | Without it |
| --- | --- | --- | --- | --- | --- |
| **`did:hedera`** of the issuer | `yarn issuer:init` (`registerIssuerDid`) | the DID root key (in the issuer's Askar wallet) | holders, verifiers, anyone | `did:hedera:testnet:<key>_<topicId>`: the topic's messages are the DID document's history | the key that controls the issuer's AnonCreds topics would not be publicly bound to an identifier |
| **Schema** `CourseCompletion 1.0` | `issuer:init` | issuer DID key (topic submit key) | holders, verifiers | HCS-1 file; id `<did>/anoncreds/v1/SCHEMA/<topicId>` | verifiers could not check which attributes a credential has |
| **Credential definition** (CL keys, revocable) | `issuer:init` | issuer DID key | holders, verifiers | HCS-1 file; id `…/PUBLIC_CRED_DEF/<topicId>` | proofs could not be verified against the issuer's public keys |
| **Revocation registry definition** | `issuer:init` | issuer DID key | holders, verifiers | HCS-1 file; its metadata names the entries topic; `…/REV_REG/<topicId>` | no non-revocation proofs |
| **Revocation entries topic** | `issuer:init` (initial list), every revocation | issuer DID key | holders, verifiers, at a chosen time | messages `{prevAccum, accum, issued?, revoked?}` (zstd + base64) replayed in consensus order up to `T` | **the state every non-revocation proof is checked against would not exist** |
| **AccreditationRegistry** contract | `yarn issuer:init` (deploy + `accredit`); the authority (`withdraw`) | the deployer (the authority), enforced by the contract | Platform B, at every decision | Mirror Node `POST /api/v1/contracts/call` (`credentialDefinitions`, `isAccredited`) | verifiers would hard-code which academies to trust, with no public history |
| **Certificate PDF** (one per certificate) | `issueCertificate` | operator key (submit key); no admin key | anyone (download, public page) | HCS-1: memo `<sha256>:zstd:base64`, chunks `{o, c}` | the PDF would live on storage the issuer controls; validity is unaffected |

Consensus timestamps are what "valid at time `T`" means: the registry asks the Mirror Node for the entries with
consensus time ≤ `T`. Submit keys are what "only the issuer can revoke" means: the consensus nodes reject messages that
the topic's submit key did not sign. The Mirror Node is the read path for both.

## Where the verifier reads Hedera (code)

- `packages/sdk/certificates/presentation.ts` → `verifyPresentation`: for each identifier of the proof, calls
  `getSchema`, `getCredentialDefinition`, `getRevocationRegistryDefinition` and `getRevocationStatusList(id, T)` on the
  verifier's own agent, then `verifyProof`.
- `@credo-ts/hedera` → `HederaAnonCredsRegistry.getRevocationStatusList` converts `T` to milliseconds and calls the
  Hiero registry.
- `@hiero-did-sdk/anoncreds` → `resolveRevocationStatusList`: resolves the registry definition (HCS-1), reads the
  entries topic with `toDate = T`, applies `issued`/`revoked`, keeps the last accumulator.
- `packages/sdk/certificates/agents.ts` → `HederaVdrRegistry` returns that list stamped in seconds (see
  [architecture.md](architecture.md#8-decisions), D6).
- `packages/sdk/certificates/accreditation.ts` → `MirrorAccreditationReader`: ABI-encodes `credentialDefinitions(course)`
  and `isAccredited(course, id, T)` and posts them to the Mirror Node's `contracts/call`; `platform.ts` uses the first to
  build the proof request's restrictions and the second to accept the issuer at `T`. `block.timestamp` on Hedera is the
  consensus time, so the registry's `grantedAt`/`withdrawnAt` and the revocation entries share one clock.

## HCS-1 for the certificate document

[HCS-1](https://hol.org/docs/standards/hcs-1) stores a file as the messages of a dedicated topic: the original bytes are
compressed with zstd, base64-encoded behind a `data:<mime>;base64,` prefix and split into chunks of at most 1,024 bytes
per message (the template uses 960 characters, leaving room for the JSON envelope). The topic memo is
`<SHA-256 of the original bytes>:zstd:base64`; the topic has a submit key and no admin key. A reader fetches every
message, sorts by `o`, concatenates, decodes, decompresses and rejects the result unless its SHA-256 equals the memo.

The Hiero DID SDK ships an HCS-1 reader that only accepts `application/json`, so the template has its own codec
(`packages/sdk/certificates/hcs1.ts`): it rejects a missing, duplicated or malformed chunk, content without a data URI,
invalid zstd and any hash mismatch. Reads go through the Mirror Node REST API with pagination (`ledger.ts`).

### Is HCS-1 sensible for a PDF?

| PDF size | Messages | Cost (measured rates) | Upload time (sequential receipts) | Verdict |
| --- | --- | --- | --- | --- |
| **3.6 KB** (this template) | 5 | **≈ US$ 0.024** | ≈ 8 s | yes |
| 50 KB | ≈ 72 | ≈ US$ 0.07 | ≈ 2 min | possible, poor UX |
| 100 KB | ≈ 143 | ≈ US$ 0.12 | ≈ 4 min | not for an interactive flow |
| 250 KB | ≈ 356 | ≈ US$ 0.30 | ≈ 10 min | no |
| 500 KB | ≈ 712 | ≈ US$ 0.58 | ≈ 20 min | no |
| 1 MB | ≈ 1,457 | ≈ US$ 1.18 | ≈ 40 min | no |

Larger sizes assume incompressible content (PDFs are already compressed). The template keeps the PDF small on purpose:
standard fonts, vector QR code, no images. A certificate with a logo or signature image should keep it as vector art or
a small image, or store the document elsewhere and keep only the hash in the credential.

## Costs

Measured on Testnet on 2026-10-03 at the network exchange rate (US$ 0.1012 per ℏ):

| Operation | Transactions | Cost |
| --- | --- | --- |
| Issuer DID | 1 topic + 1 message | 0.304 ℏ ≈ US$ 0.031 |
| Schema | 1 topic + 1 message | 0.202 ℏ ≈ US$ 0.020 |
| Credential definition | 1 topic + 7 messages | 0.257 ℏ ≈ US$ 0.026 |
| Revocation registry definition | 1 topic + 2 messages | 0.210 ℏ ≈ US$ 0.021 |
| Revocation entries topic + initial list | 1 topic + 1 message | ≈ 0.20 ℏ ≈ US$ 0.020 |
| AccreditationRegistry deploy (initcode inline, 571k gas) | 1 contract create | 10.5 ℏ ≈ US$ 1.06 (the ContractCreate fee dominates) |
| `accredit` (185k gas) / `withdraw` | 1 contract call each | 0.155 ℏ ≈ US$ 0.016 / 0.029 ℏ ≈ US$ 0.003 |
| **`yarn issuer:init` total (once)** | 5 topics + 12 messages + 1 contract + 1 call | **≈ 11.9 ℏ ≈ US$ 1.20** |
| Certificate PDF on HCS-1 (per certificate) | 1 topic + 5 messages | 0.235 ℏ ≈ US$ 0.024 |
| Credential issuance (per certificate) | none: revocation registries are issuance-by-default | free |
| Revocation (per certificate) | 1 message | ≈ 0.004–0.008 ℏ ≈ US$ 0.0004–0.0009 |
| Verification (incl. registry reads), download, public page | Mirror Node reads | free |

| Certificates | Setup | Marginal (PDF) | Total |
| --- | --- | --- | --- |
| 1 | US$ 1.20 | US$ 0.024 | ≈ US$ 1.2 |
| 100 | US$ 1.20 | US$ 2.40 | ≈ US$ 3.6 |
| 1,000 | US$ 1.20 + a second revocation registry (≈ US$ 0.04) | US$ 24 | ≈ US$ 25 |
| 10,000 | US$ 1.20 + 10 revocation registries (≈ US$ 0.4) | US$ 240 | ≈ US$ 242 |

A registry holds `maximumCredentialNumber − 1` certificates (999 by default). The template does not rotate registries
yet (it stops with `REGISTRY_FULL`); the rows above for 1,000+ include what rotation would cost. Topic creation dominates
every cost; the fee schedule is USD-denominated, so HBAR amounts move with the exchange rate. HCS messages are kept by
Mirror Nodes; the template's topics have no admin key, so nobody can delete them.

## Network facts worth knowing

- Consensus-node balance queries (`AccountBalanceQuery`) returned `BUSY` on every Testnet node on 2026-10-03 while
  transactions and paid queries worked; `yarn setup` reads the balance from the Mirror Node.
- Mirror Node data appears a few seconds after consensus. The template waits for visibility after every write
  (`publishHcs1File`, the Hiero registrar's DID awaiter) and a revocation is effective for proofs as soon as the Mirror
  Node lists the entry.
