# Agent Guide

Privacy-preserving, revocable course certificates on Hedera. An issuer gives a holder an **AnonCreds** credential
(Credo + Askar) whose public objects live on the **Hedera Verifiable Data Registry** (HCS, through
`@hiero-did-sdk/anoncreds`), plus a PDF stored as an **HCS-1** file and bound to the credential by `document_sha256`.
A relying party ("Platform B") decides from a zero-knowledge proof, checks revocation against Hedera and asks the
**`AccreditationRegistry`** contract which issuers to trust. Normative design: [docs/architecture.md](docs/architecture.md);
Hedera objects: [docs/hedera.md](docs/hedera.md); threat model: [docs/security.md](docs/security.md); real errors:
[docs/troubleshooting.md](docs/troubleshooting.md).

## Packages

| Package | Owns | Main files |
| --- | --- | --- |
| `packages/hardhat` (`@sh/hardhat`) | `AccreditationRegistry` and its tests; the `codegen` task | `contracts/AccreditationRegistry.sol`, `test/`, `hardhat.config.ts` |
| `packages/sdk` (`@sh/sdk`, TypeScript source, ESM) | certificate logic (`certificates/`), network table and environment validation (`hedera/`), CLIs (`cli/`), the generated ABI (`generated/`), the in-memory Hedera for tests (`testing/`) | `certificates/{agents,issuer,presentation,platform,accreditation,hcs1,ledger,document,service}.ts` |
| `packages/nextjs` (`@sh/nextjs`) | the console (`/`), the public certificate page (`/certificate/[id]`), route handlers under `app/api` | `app/api/_lib/server.ts` (one `CertificateService` per process, error → HTTP mapping) |

## Invariants (never break these)

- Validity is the AnonCreds credential checked against Hedera. **The PDF is never treated as cryptographic proof of
  validity**, and neither is the public certificate page or the issuer's register (`certificates.json`).
- **Verification resolves trusted state independently**: verifiers resolve schema, credential definition, revocation
  registry and revocation status list from Hedera through their own agent (`verifyPresentation` in
  `packages/sdk/certificates/presentation.ts`). Never verify against objects supplied by the issuer or the holder.
- **Revocation is determined from the credential revocation mechanism** (AnonCreds revocation entries on HCS), **not
  from the accreditation contract**.
- **`AccreditationRegistry` never stores individual credential state**: no certificate, holder, grade, student id or
  revocation. It holds trust only: which credential definitions an authority recognizes for a course, with
  `grantedAt`/`withdrawnAt`. A withdrawn definition is never re-accredited.
- **`document_sha256` corresponds to the HCS-1 document published before issuance**: the PDF is published to HCS-1
  first, and the credential's `document_sha256` is the SHA-256 of exactly those bytes.
- **Private credential attributes are never published to Hedera**: grade, student id and anything not meant to be
  public exist only in the credential — never in the PDF, an HCS message, a log, an error or an API response. The PDF
  carries only name, course, issuer, date, certificate id and QR code.
- Every proof request restricts `cred_def_id` to trusted credential definitions and sets `non_revoked` to a single
  instant (`from = to`); `verifyPresentation` rejects proof timestamps outside it. Build requests with
  `buildProofRequest`, never by hand.
- Platform B builds proof restrictions from `credentialDefinitions(course)` and accepts the issuer only if
  `isAccredited(course, id, T)` at the proof's time `T`. Never replace the registry with a local allowlist.

## Trust boundaries

| Boundary | Trusted for | Not trusted for |
| --- | --- | --- |
| Hedera consensus (HCS, Smart Contract Service) | ordering, timestamps, topic submit keys, contract state | — |
| Mirror Node (`packages/sdk/hedera/networks.ts`) | serving what consensus produced (a documented, trusted dependency) | anything it cannot have from consensus |
| Issuer | signing credentials and publishing its own objects | telling a verifier whether a certificate is valid |
| Holder | presenting proofs with its link secret | supplying schemas, definitions or revocation state |
| Browser | nothing: native libraries, the operator key and wallets stay server-side | — |

## Rules

- Never commit secrets, private keys, mnemonics, real account credentials, a `.env` or the `.data/` directory (wallets,
  wallet keys, issuer state).
- The Hedera AnonCreds registry is `HederaVdrRegistry` (`agents.ts`), which corrects the millisecond status-list
  timestamps of `@hiero-did-sdk/anoncreds` 0.1.8. Register no other AnonCreds registry. The Hiero registrar is patched
  in `.yarn/patches/` (DID visibility window), and three `ljharb` packages are patched to drop a `module-sync` export
  that breaks Next.js on Node 20.19; keep the patches until upstream fixes them, and document any new patch in
  docs/architecture.md (D6).
- HCS-1 files have one codec: `packages/sdk/certificates/hcs1.ts`; reads go through `fetchHcs1File`, which verifies the
  memo hash and refuses topics with an admin key.
- Contracts ship with Hardhat tests; after changing one run `yarn codegen` (`packages/sdk/generated/` is generated,
  committed and never edited; the tests fail on stale output). Deploy and write with the Hedera SDK (`accreditation.ts`);
  read through the Mirror Node `contracts/call`.
- Keep certificate PDFs small (a few KB: standard fonts, vector art) — every 960 characters is one HCS message.
- Hedera environment validation has one source: `validateHederaEnvironment` in `@sh/sdk`. It must never put a private
  key, or a URL beyond its origin, in a message, log or result. `loadCertificatesConfig` uses it and its `keyType` to
  turn a raw hex key into DER.
- Mirror Node and HashScan URLs live only in `packages/sdk/hedera/networks.ts`.
- `@sh/sdk/certificates` is server-only (native libraries, the operator key, wallets). Client components import types
  from it, never values. Route handlers using it declare `runtime = "nodejs"`.
- The Credo, Askar, AnonCreds, zstd, Hedera SDK and pdf-lib packages are runtime dependencies of `@sh/nextjs` too and are
  listed in `SERVER_EXTERNALS` in `next.config.ts`; add a new native or ESM-only server dependency to both.
- Every typed failure is a `CertificateError` with a stable `code`; route handlers map codes to HTTP statuses in
  `app/api/_lib/server.ts` and never return the text of an unexpected error.
- Writes to Hedera happen only in `yarn issuer:init`, issuance, revocation and accreditation withdrawal, and only with
  the operator configured in `.env`. Nothing runs on mainnet without `--allow-mainnet`.
- Tests are offline and credential-free: use `InMemoryHedera` from `@sh/sdk/testing` (it replaces the Hiero HCS
  transport, so the real Credo and Hiero code runs). Runtime code never imports `testing/`.
- External integrations use an interface, a timeout, validation and a deterministic test fixture.
- The Hedera Harness recipe in `.harness/` (`spec.yaml`, `validators/static.json`, `validators/yarn.json`, `prd.md`) ships
  into every scaffolded project. When you add a root script, a module or a normative rule, update the validators in the
  same change; never assert `template.json` there (the CLI deletes it). See [docs/harness.md](docs/harness.md).
- Secret scanning has one implementation: `.gitleaks.toml` run by `scripts/secret-scan.mjs`; never silence a finding
  without a narrow, documented allowlist entry, and never print a matched value.
- Text files are checked out with LF (`.gitattributes`): solc hashes the source into the bytecode metadata, so CRLF
  would make the codegen check fail.

## Where to add things

| Change | Where | Also update |
| --- | --- | --- |
| A credential attribute | `CERTIFICATE_SCHEMA` in `certificates/issuer.ts` (a new schema and credential definition: run `yarn issuer:init` on a fresh `CERTIFICATES_DATA_DIR`) | `certificates.test.ts`; keep private attributes out of the PDF |
| A relying-party rule (another course, predicate, reveal) | `ENROLLMENT_POLICY` / `decide*` in `certificates/platform.ts`, using `buildProofRequest` | `certificates.test.ts` (accepted, denied, revoked, not accredited) |
| An API route | `packages/nextjs/app/api/<name>/route.ts`: `runtime = "nodejs"`, body wrapped in `respond()` | a new `CertificateError` code needs a status in `server.ts` |
| Contract behavior | `packages/hardhat/contracts`, then `yarn codegen` | Hardhat tests, `accreditation.ts`, `testing/hedera.ts` |
| A Hedera read or write | `certificates/ledger.ts` / `accreditation.ts`; URLs in `hedera/networks.ts` | the in-memory fake in `testing/hedera.ts` |
| An environment variable | `template.json` `envVars`, then `node scripts/validate-template.mjs` (keeps `.env.example` equal) | `validateHederaEnvironment` or `loadCertificatesConfig`; README table |

## Running it

- **Offline (no account, no `.env`)**: `yarn test` runs the whole flow — DID, schema, credential definition, revocation
  registry, issuance, proofs, revocation, accreditation, HCS-1 — against `InMemoryHedera` and the in-memory registry.
  This is the default for every change.
- **Testnet (manual)**: `cp .env.example .env`, set `HEDERA_OPERATOR_ID`/`HEDERA_OPERATOR_KEY`, then `yarn setup`,
  `yarn issuer:init` (spends about 12 HBAR, asks first) and `yarn dev`. There is no local Hedera node mode: AnonCreds
  objects need a public network. Put HashScan links of live runs in the README.

## Commands
Available: `yarn codegen` (regenerates the contract ABI and bytecode for the SDK), `yarn doctor`, `yarn setup` (validates network, account, key and balance; exit 0 valid, 1 invalid, 2
unreachable; `--json`), `yarn issuer:init` (publishes the issuer DID, schema, credential definition and revocation
registry once, then deploys the accreditation registry and accredits; shows plan and cost and asks; `--yes`; refuses mainnet without `--allow-mainnet`), `yarn dev` (`yarn
start` is the same; `yarn serve` is production), `yarn build`, `yarn lint`, `yarn check-types`, `yarn test`, `yarn
check` (lint + types + test + `harness:doctor`), `yarn coverage`, `yarn self-check` (the eligibility gate CI runs; see
[docs/self-check.md](docs/self-check.md)), `yarn format`, `yarn harness:doctor`, `yarn harness:validate` (full Tier 0–1;
refuses a workspace with a `.env`, so run it in a clean clone), `yarn secrets:scan` (exit 0 clean, 1 findings, 2 could
not run). Per-package scripts are `hardhat:*`, `next:*` and `sdk:*`.

Structure rules (see [docs/scaffold-compat.md](docs/scaffold-compat.md)): workspaces are `@sh/hardhat`, `@sh/nextjs` and
`@sh/sdk`; the manifest declares `solidityFramework: hardhat` and `packageManager: yarn`. `@sh/sdk` is consumed as
TypeScript source. One `.env` at the repository root; secrets never use the `NEXT_PUBLIC_` prefix. `.env.example` is
generated from `template.json` (`envVars`); keep them equal (`node scripts/validate-template.mjs`). Scaffold with
`npm create scaffold-hbar@latest -- --template <owner>/<repo>`.

## Definition of Done
Tests, lint/typecheck/format, error handling, docs, no secrets (`yarn secrets:scan` exits 0), HashScan evidence for
Testnet changes, and every applicable item of the security Definition of Done in
[docs/security.md](docs/security.md#7-security-definition-of-done-every-pull-request).
