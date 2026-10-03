# Verifiable Certificates on Hedera

Privacy-preserving, revocable course certificates on Hedera, with a downloadable tamper-evident PDF and verification
that never calls the issuer.

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

Requirements: Node.js ≥ 20.19, Git, and a Hedera Testnet account with about 20 HBAR
([portal.hedera.com](https://portal.hedera.com), free).

```bash
npm create scaffold-hbar@latest -- --template fmartns/scaffold-hbar-verifiable-settlement
cd <your-project>
cp .env.example .env          # set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY
yarn install                  # also downloads the prebuilt Askar, AnonCreds and zstd binaries
yarn setup                    # validates network, account, key and balance
yarn issuer:init              # publishes the issuer and the accreditation registry, once (≈ 12 HBAR; asks first)
yarn dev                      # http://localhost:3000
```

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
| Revocation entries (issuance state + one revocation) | [0.0.10835836](https://hashscan.io/testnet/topic/0.0.10835836) |
| Revocation registry definition (HCS-1) | [0.0.10835837](https://hashscan.io/testnet/topic/0.0.10835837) |
| A certificate PDF (HCS-1, 5 chunks, memo = SHA-256) | [0.0.10836026](https://hashscan.io/testnet/topic/0.0.10836026) |
| AccreditationRegistry (`Solidity Basics` → the credential definition above) | [0.0.10837530](https://hashscan.io/testnet/contract/0.0.10837530) |
| A certificate checked against that registry | [0.0.10837593](https://hashscan.io/testnet/topic/0.0.10837593) |

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
.yarn/patches/                 one documented patch to the Hiero DID registrar
.harness/                      Hedera Harness recipe (Tier 0–1)
```

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
