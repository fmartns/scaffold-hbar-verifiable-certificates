# Verifiable Certificates on Hedera

[![CI](https://github.com/fmartns/scaffold-hbar-verifiable-certificates/actions/workflows/ci.yml/badge.svg)](https://github.com/fmartns/scaffold-hbar-verifiable-certificates/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Hedera Testnet](https://img.shields.io/badge/Hedera-Testnet-8259EF.svg)](#testnet-evidence)
[![Scaffold-HBAR template](https://img.shields.io/badge/scaffold--hbar-template-0031FF.svg)](https://github.com/hedera-dev/scaffold-hbar)

Privacy-preserving, revocable course certificates on Hedera, with a downloadable tamper-evident PDF and verification
that never calls the issuer.

**Contents:** [Quick start](#quick-start) · [How it works](#how-it-works) · [Hedera services](#hedera-services-in-use) ·
[Flows](#the-flows) · [Testnet evidence](#testnet-evidence) · [Commands](#commands) · [Configuration](#configuration) ·
[Make it yours](#make-it-yours) · [Limitations](#limitations) · [Docs](#documentation)

A [scaffold-hbar](https://github.com/hedera-dev/scaffold-hbar) template. An academy issues **AnonCreds** credentials
([Credo](https://github.com/openwallet-foundation/credo-ts), OpenWallet Foundation) whose public objects live on the
**Hedera Verifiable Data Registry** ([HIP-762](https://hips.hedera.com/hip/hip-762)); each certificate comes with a PDF
stored on **HCS-1**; an **accreditation registry** contract says which academies are recognized for which course; and
a second platform enrolls students in an advanced course from a zero-knowledge proof.

```
Ana completes "Solidity Basics" with 88   ──▶  she receives a credential (in her wallet) and certificate.pdf
Platform B: "Advanced Solidity needs Basics with grade ≥ 70, not revoked"
Ana presents a proof  ──▶  Platform B learns: course = Solidity Basics, grade ≥ 70 = true   ──▶  ENROLLED
                           Platform B never learns: her name, 88, her student id
Bob presents a copy of Ana's PDF   ──▶  DENIED (he has no credential, and a copied credential needs Ana's link secret)
The academy revokes Ana's certificate on Hedera   ──▶  DENIED now · still VALID "as of" before the revocation
The accreditation authority withdraws the academy  ──▶  even valid certificates stop qualifying from that moment
```

## Quick start

**Prerequisites** (the scaffold CLI checks the first three before it creates anything):

- Node.js **≥ 20.19** (Credo needs it; the CLI's own floor is 20.18.3)
- Yarn on your `PATH`: `corepack enable` (or `npm install -g yarn`; any Yarn ≥ 1.22 delegates to the Yarn 3.2.3 the
  repository pins in `.yarnrc.yml`)
- Git with `user.name` and `user.email` configured
- A Hedera **Testnet** account (ED25519 or ECDSA) with about 20 HBAR, free at [portal.hedera.com](https://portal.hedera.com).
  Only needed for the live flow: install, tests and the build run without one.

```bash
npm create scaffold-hbar@latest -- --template fmartns/scaffold-hbar-verifiable-certificates
cd <your-project>
yarn test                     # optional: the whole flow offline, against an in-memory Hedera (no account needed)
cp .env.example .env          # set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY
yarn setup                    # validates network, account, key and balance
yarn issuer:init              # publishes the issuer and the accreditation registry, once (≈ 12 HBAR; asks first)
yarn dev                      # http://localhost:3000
```

The CLI reads this repository's `template.json`, so it selects **Next.js + Hardhat + Yarn** without asking, runs
`yarn install` (which also downloads the prebuilt Askar, AnonCreds and zstd binaries) and makes the first commit; run
`yarn install` yourself only if you passed `--skip-install`. Keep the `--` before `--template`: without it npm swallows
the flag (`npx create-scaffold-hbar@latest --template fmartns/scaffold-hbar-verifiable-certificates` needs no `--`). If
the GitHub API is rate-limited the CLI cannot read `template.json` and falls back to asking for a Solidity framework and
a package manager: choose **Hardhat** and **Yarn**, or pass `-s hardhat --package-manager yarn`.

In the console: **Issue certificate** (Ana, 88) → **Download PDF** → **ana applies** (ENROLLED) → **bob applies**
(DENIED) → **Revoke** → **ana applies** (DENIED) → **Was it valid at…** a time before the revocation (ENROLLED) →
**Check a downloaded certificate** (document MATCH, credential REVOKED) → optionally, on a throwaway data directory,
**Withdraw (authority)** (a fresh certificate is then DENIED: "not accredited"). The three-minute walkthrough is in
[docs/demo.md](docs/demo.md); the step-by-step setup with expected output is in [docs/quick-start.md](docs/quick-start.md).

## How it works

```
             Hedera (HCS, read through the Mirror Node)
  did:hedera · schema · credential definition · revocation registry · revocation entries · certificate PDFs (HCS-1)
        ▲ writes                       ▲ reads                                   ▲ reads
  ┌─────┴──────────┐  credential  ┌────┴────────────┐   zero-knowledge proof  ┌─────┴──────────────────┐
  │ Issuer (Credo) │ ───────────▶ │ Holder (Credo)  │ ──────────────────────▶ │ Platform B (Credo)     │
  │ Hedera Academy │  + PDF       │ Ana's wallet    │                         │ decides enrollment     │
  └────────────────┘              └─────────────────┘                         └────────────────────────┘
                    accreditation authority ──▶ AccreditationRegistry (Solidity) ──▶ read by Platform B
```

| Question | Answer |
| --- | --- |
| **Why AnonCreds?** | Holder binding (a link secret only the holder has), selective disclosure, predicates (`grade ≥ 70` without the grade) and non-revocation proofs. A signed JSON gives none of these. |
| **Why Hedera?** | It is the public Verifiable Data Registry: the verifier resolves the issuer's DID, schema and credential definition from it, and rebuilds the revocation state by replaying the issuer's HCS topic up to a consensus timestamp. Nothing comes from the issuer's server, so the issuer cannot show different lists to different verifiers or rewrite history. |
| **Why HCS-1?** | To deliver a human-readable certificate whose integrity anyone can check without relying on storage the issuer controls: the topic memo is the PDF's SHA-256 and the topic cannot be deleted. It does not decide validity. |
| **Why a contract?** | Platform B must know which academies may certify "Solidity Basics". The accreditation authority records that on the Smart Contract Service, with exact history, so verifiers do not hard-code it. The contract holds trust, never certificate status. |
| **Why the hash?** | The credential carries `document_sha256`, so a PDF can be tied to the credential that actually decides whether it is valid. |

The PDF is a picture of the certificate, never the credential: copying it copies nothing. Validity is the AnonCreds
credential, checked against Hedera. [docs/architecture.md](docs/architecture.md) has the full design, the binding
algorithm and the "remove it and see what breaks" table; [docs/hedera.md](docs/hedera.md) maps every Hedera object.

## Hedera services in use

| Service | What this template puts there | Remove it and… |
| --- | --- | --- |
| **Consensus Service (HCS) as the AnonCreds Verifiable Data Registry** — `@credo-ts/hedera` → `@hiero-did-sdk/anoncreds` → `HederaVdrRegistry` | the issuer's `did:hedera` document, the schema, the credential definition, the revocation registry definition, and the revocation entries topic (one message per change, submit key = the issuer's DID key) | verifiers have nothing to check proofs against; revocation state would live in the issuer's database, which could show different lists to different verifiers or rewrite history |
| **HCS-1 files** (on HCS) | each certificate PDF, topic memo = its SHA-256, no admin key | the PDF moves to storage the issuer controls; validity is unaffected (useful, not load-bearing) |
| **Smart Contract Service** — `AccreditationRegistry` (Hardhat) | which credential definitions an accreditation authority recognizes for a course, with `grantedAt`/`withdrawnAt` in consensus time | every verifier hard-codes whom to trust and must be redeployed to change it; no public record of who was recognized when |
| **Mirror Node** (REST) | the read path: topic messages (the verifier replays the revocation entries up to the proof's consensus time), HCS-1 chunks, account checks, and `contracts/call` on the registry | nothing can be read or verified; it is a trusted dependency ([security.md](docs/security.md)) |

AnonCreds, Credo and Askar provide the cryptography, the agents and the encrypted wallets; Hedera provides the shared,
ordered, timestamped state they verify against. Remove Hedera and the verifier is back to trusting the issuer's server.

## The flows

| Flow | Steps | Hedera writes |
| --- | --- | --- |
| **Initialize** (`yarn issuer:init`, once) | issuer DID → schema → credential definition → revocation registry → deploy `AccreditationRegistry` → `accredit(course, credDef)` | 5 topics + 12 messages + 1 contract create + 1 call (≈ 12 HBAR) |
| **Issue** (console or `POST /api/certificates`) | render the PDF → publish it as an HCS-1 file → `document_sha256 = SHA-256(PDF)` → issue the AnonCreds credential (with `document_sha256` and a revocation index) into the holder's wallet | 1 HCS-1 topic + its chunk messages (5 for the 3.6 KB PDF) |
| **Verify** (`POST /api/enroll`, `POST /api/document-check`) | read the accredited credential definitions → proof request (`non_revoked` at one instant `T`) → holder's proof → the verifier's own agent resolves schema, definition and revocation state at `T` from Hedera → `isAccredited(course, credDef, T)` | none (reads only) |
| **Revoke** (console or `POST /api/certificates/<id>/revoke`) | the issuer publishes a revocation entry; proofs "as of" after it fail, proofs "as of" before it still pass | 1 message on the entries topic |

## What each party sees

| | Issuer | Holder (Ana) | Platform B | Anyone (public page, HashScan) |
| --- | --- | --- | --- | --- |
| Name, course, date on the PDF | ✓ | ✓ | only if Ana shows the PDF | ✓ (HCS-1 is public) |
| Grade, student id | ✓ (at issuance) | ✓ | ✗ (only `grade ≥ 70`) | ✗ |
| Revocation status of this certificate | ✓ | ✓ | ✓ at the time it asks, through Ana's proof | ✗ (indexes are private) |
| Link secret | ✗ | ✓ | ✗ | ✗ |

## Testnet evidence

Published with this repository's own commands on 2026-10-03 (Testnet), all verifiable on HashScan:

| Object | Link |
| --- | --- |
| Issuer DID document topic | [0.0.10835831](https://hashscan.io/testnet/topic/0.0.10835831) |
| Schema (HCS-1) | [0.0.10835833](https://hashscan.io/testnet/topic/0.0.10835833) |
| Credential definition (HCS-1) | [0.0.10835834](https://hashscan.io/testnet/topic/0.0.10835834) |
| Revocation entries (initial issuance state + two revocations) | [0.0.10835836](https://hashscan.io/testnet/topic/0.0.10835836) |
| Revocation registry definition (HCS-1) | [0.0.10835837](https://hashscan.io/testnet/topic/0.0.10835837) |
| A certificate PDF (HCS-1, 5 chunks, memo = SHA-256) | [0.0.10836026](https://hashscan.io/testnet/topic/0.0.10836026) |
| AccreditationRegistry (`Solidity Basics` → the credential definition above) | [0.0.10837530](https://hashscan.io/testnet/contract/0.0.10837530) |
| A certificate checked against that registry | [0.0.10837593](https://hashscan.io/testnet/topic/0.0.10837593) |

Individual transactions (all `SUCCESS`, payer `0.0.9327439`):

| Transaction | HashScan | Mirror Node |
| --- | --- | --- |
| `ConsensusCreateTopic` — the issuer's DID document topic | [1790996836.245900104](https://hashscan.io/testnet/transaction/1790996836.245900104) | [0.0.9327439-1790996829-444905325](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.9327439-1790996829-444905325) |
| `ConsensusCreateTopic` — a certificate PDF stored as HCS-1 | [1790997758.417264894](https://hashscan.io/testnet/transaction/1790997758.417264894) | [0.0.9327439-1790997751-345835606](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.9327439-1790997751-345835606) |
| `ConsensusSubmitMessage` — a revocation entry | [1790997781.896472394](https://hashscan.io/testnet/transaction/1790997781.896472394) | [0.0.9327439-1790997774-512140330](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.9327439-1790997774-512140330) |
| `ContractCreate` — `AccreditationRegistry` | [1791005637.187703104](https://hashscan.io/testnet/transaction/1791005637.187703104) | [0.0.9327439-1791005629-433832773](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.9327439-1791005629-433832773) |
| `ContractCall` — `accredit("Solidity Basics", <credential definition 0.0.10835834>)` | [1791005639.291434104](https://hashscan.io/testnet/transaction/1791005639.291434104) | [0.0.9327439-1791005629-009818278](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.9327439-1791005629-009818278) |

Check them yourself, no account needed:

```bash
curl -s https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10836026            # memo = the PDF's SHA-256, no admin key
curl -s https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10835836/messages   # the revocation entries a verifier replays
curl -s https://testnet.mirrornode.hedera.com/api/v1/contracts/0.0.10837530/results # deploy + accredit
```

Run against them: enrollment ENROLLED revealing only `course`; Bob DENIED; PDF downloaded from HCS-1 with an identical
SHA-256; tampered PDF MISMATCH; after the revocation, enrollment DENIED, "as of" before the revocation ENROLLED, and the
document check reported document MATCH with credential REVOKED. A second run read the accreditation registry through the
Mirror Node before every decision; a throwaway registry was used to check `withdraw` and the "as of" history on Testnet.

## Commands

| Command | What it does |
| --- | --- |
| `yarn setup` | Validates `HEDERA_NETWORK`, the operator account, its key and balance (exit 0 valid, 1 invalid, 2 unreachable; `--json`). Shows the published issuer. |
| `yarn issuer:init` | Publishes the issuer's `did:hedera`, schema, credential definition and revocation registry, then deploys the accreditation registry and accredits that credential definition. Shows the plan and cost and asks before paying (`--yes` skips it); idempotent; refuses mainnet without `--allow-mainnet`. |
| `yarn dev` | Console at http://localhost:3000 (`yarn start` is the same; `yarn serve` serves a production build). |
| `yarn build` | SDK type build, contract compilation and Next.js production build. |
| `yarn codegen` | Regenerates `packages/sdk/generated/AccreditationRegistry.ts` (ABI and bytecode) from the compiled contract; the contract tests fail on stale output. |
| `yarn lint`, `yarn check-types`, `yarn test` | ESLint, TypeScript, and tests against an in-memory Hedera (offline, no credentials). |
| `yarn check` | lint + types + tests + harness recipe check: the fast inner loop. |
| `yarn coverage` | Tests with coverage. |
| `yarn self-check` | The eligibility gate CI runs: manifest, docs, license, no `.env`, secret scan, install, lint, types, tests, build, boot. See [docs/self-check.md](docs/self-check.md). |
| `yarn secrets:scan` | gitleaks over the whole history and the working tree; values always redacted. |
| `yarn harness:validate` | The Hedera Harness Tier 0–1 validators in `.harness/` (run in a clean clone). See [docs/harness.md](docs/harness.md). |
| `yarn format`, `yarn doctor` | Prettier; toolchain check. |

## Configuration

One `.env` at the repository root feeds the CLIs and the Next.js server (`cp .env.example .env`). It is git-ignored, and
no variable is exposed to the browser.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `HEDERA_OPERATOR_ID` | for the live flow | — | Account (`0.0.x`) that pays for topics, messages and the contract |
| `HEDERA_OPERATOR_KEY` | for the live flow | — | Its private key: DER, or raw hex (the curve is read from the account). **Secret, server-side only** |
| `HEDERA_NETWORK` | no | `testnet` | `testnet` or `mainnet` (`yarn issuer:init` refuses mainnet without `--allow-mainnet`) |
| `HEDERA_MIRROR_NODE_URL` | no | public Mirror Node of the network | Mirror Node REST base URL |
| `HEDERA_MIN_BALANCE_HBAR` | no | 20 (testnet), 10 (mainnet) | Balance `yarn setup` requires |
| `CERTIFICATES_DATA_DIR` | no | `.data` | Askar wallets, issuer identifiers, tails files. Git-ignored; back it up — it holds the issuer's keys |
| `CERTIFICATES_PUBLIC_URL` | no | `http://localhost:3000` | Origin printed in the QR code and the tails URL |

## Tests

`yarn test` runs everything offline and without credentials: the SDK suite runs the real Credo, AnonCreds and Hiero
code against `InMemoryHedera` (`packages/sdk/testing`), which replaces only the HCS transport and the Mirror Node
endpoints. It covers publishing the issuer, issuance with the PDF on HCS-1 and its `document_sha256`, selective
disclosure and the `grade >= 70` predicate, a copied PDF or credential, revocation now and "as of" before, a proof built
for another time, accreditation granted and withdrawn, a tampered PDF, and environment validation. Hardhat tests cover
the contract and fail if `packages/sdk/generated` is stale; Vitest covers the console, the public certificate page and
the route-handler error mapping. Live Testnet runs are manual (above). Details: [docs/testing.md](docs/testing.md).

## Security and privacy

- The grade and the student id exist only in the credential: never on Hedera, in the PDF, a log or an API response.
- The operator key and the wallets never leave the server; secrets never use `NEXT_PUBLIC_`. `yarn secrets:scan`
  (gitleaks over the full history) runs in CI.
- Verifiers never take schemas, credential definitions or revocation state from the issuer or the holder.
- The public certificate page proves only that a PDF is intact, never that the certificate is valid: revocation
  indexes stay private, so status is proven by the holder, to a verifier, at a point in time.

## Project layout

```
packages/hardhat/              @sh/hardhat — AccreditationRegistry.sol and its tests (deployed by the SDK)
packages/sdk/                  @sh/sdk — consumed as TypeScript source
  certificates/
    agents.ts                  Credo agents (Askar wallets) + HederaVdrRegistry (Hedera AnonCreds registry, fixed)
    issuer.ts                  publish the issuer; issue (PDF → HCS-1 → credential); revoke
    presentation.ts            proof requests, presentations, verification against Hedera
    platform.ts                Platform B: accreditation, enrollment rule and downloaded-document check
    accreditation.ts           AccreditationRegistry: deploy/accredit/withdraw (Hedera SDK), read (Mirror Node)
    hcs1.ts · ledger.ts        HCS-1 codec; write via the Hedera SDK, read via the Mirror Node
    document.ts                deterministic certificate PDF with a vector QR code
    service.ts · store.ts      wiring for the app and CLIs; local issuer state and register
  hedera/                      networks and environment validation (validateHederaEnvironment)
  cli/                         yarn setup, yarn issuer:init
  generated/                   ABI and bytecode of the contract (yarn codegen)
  testing/hedera.ts            in-memory Hedera and accreditation registry for tests
packages/nextjs/               @sh/nextjs — console (/), public certificate page (/certificate/[id]), API routes
scripts/                       self-check, secret scan, template validation, fresh-scaffold verification
.yarn/patches/                 documented patches: the Hiero DID registrar, three Node 20.19 module-sync fixes
.harness/                      Hedera Harness recipe (Tier 0–1)
AGENTS.md · CLAUDE.md          briefing for coding agents (CLAUDE.md imports AGENTS.md)
```

## Make it yours

The template is a working use case, meant to be changed. [AGENTS.md](AGENTS.md#where-to-add-things) lists where each
kind of change goes; the usual ones:

- **Your credential**: edit `CERTIFICATE_SCHEMA` in `packages/sdk/certificates/issuer.ts` (keep private attributes out of
  the PDF), then run `yarn issuer:init` on a fresh `CERTIFICATES_DATA_DIR` to publish the new schema and definition.
- **Your relying-party rule**: change `ENROLLMENT_POLICY` and `decide*` in `packages/sdk/certificates/platform.ts`; build
  requests with `buildProofRequest` so `non_revoked` stays a single instant.
- **Your document**: change the layout in `packages/sdk/certificates/document.ts`; keep it small (every 960 characters is
  one HCS message).
- **Your trust anchor**: the accreditation authority is whoever deploys `AccreditationRegistry`. Platform B reads it with
  `MirrorAccreditationReader(mirrorNodeUrl, address)`; `service.ts` takes the address of the demo registry from
  `.data/accreditation.json` — point it at the real authority's registry instead.

`yarn check` is the inner loop; `yarn self-check` reproduces the bounty gate before you push.

## Limitations

- The Mirror Node is trusted to serve what consensus produced; Hedera offers no state proofs a verifier can check today.
- Holders are demo wallets on the server; production holders use a mobile wallet that supports `did:hedera`.
- One revocation registry (999 certificates); no rotation yet.
- Issuer, holders and verifier exchange objects in-process (no DIDComm or OpenID4VC).

Details and the threat model: [docs/security.md](docs/security.md).

## Documentation

| Document | For |
| --- | --- |
| [docs/quick-start.md](docs/quick-start.md) | first run, with expected output |
| [docs/demo.md](docs/demo.md) | three-minute demo script |
| [docs/architecture.md](docs/architecture.md) | design, binding algorithm, load-bearing analysis, decisions |
| [docs/hedera.md](docs/hedera.md) | every Hedera object, HCS-1 sizing, measured costs |
| [docs/security.md](docs/security.md) | threat model, trust boundaries, Definition of Done |
| [docs/testing.md](docs/testing.md) | test layers and the in-memory Hedera |
| [docs/troubleshooting.md](docs/troubleshooting.md) | real errors and their fixes |
| [docs/scaffold-compat.md](docs/scaffold-compat.md) | how the scaffold CLI consumes this template |
| [docs/harness.md](docs/harness.md), [docs/self-check.md](docs/self-check.md) | validation recipes |
| [AGENTS.md](AGENTS.md) | rules for coding agents |

## License

MIT — see [LICENSE](LICENSE).
