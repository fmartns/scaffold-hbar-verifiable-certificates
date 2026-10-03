# Agent Guide

## Architecture
Privacy-preserving, revocable course certificates. `packages/hardhat` owns the `AccreditationRegistry` contract and its
tests. `packages/sdk` owns the certificate logic (`certificates/`), the
network table and environment validation (`hedera/`), the CLIs (`cli/`) and the in-memory Hedera for tests
(`testing/`). `packages/nextjs` is the console, the public certificate page and the route handlers. AnonCreds
credentials (Credo) use Hedera as the Verifiable Data Registry; each certificate's PDF is an HCS-1 file bound to the
credential by `document_sha256`. Normative design: [docs/architecture.md](docs/architecture.md); Hedera objects:
[docs/hedera.md](docs/hedera.md); threat model: [docs/security.md](docs/security.md); real errors:
[docs/troubleshooting.md](docs/troubleshooting.md).

## Rules
- Never commit secrets, private keys, mnemonics, real account credentials, a `.env` or the `.data/` directory (wallets,
  wallet keys, issuer state).
- Validity is the AnonCreds credential checked against Hedera. Never present the PDF, the public certificate page or
  the issuer's register (`certificates.json`) as proof that a certificate is valid.
- Verifiers resolve schema, credential definition, revocation registry and revocation status list from Hedera through
  their own agent (`verifyPresentation` in `packages/sdk/certificates/presentation.ts`). Never verify against objects
  supplied by the issuer or the holder.
- Every proof request restricts `cred_def_id` to a trusted credential definition and sets `non_revoked` to a single
  instant (`from = to`); `verifyPresentation` rejects proof timestamps outside it. Build requests with
  `buildProofRequest`, never by hand.
- The Hedera AnonCreds registry is `HederaVdrRegistry` (`agents.ts`), which corrects the millisecond status-list
  timestamps of `@hiero-did-sdk/anoncreds` 0.1.8. Register no other AnonCreds registry. The Hiero registrar is patched
  in `.yarn/patches/` (DID visibility window); keep the patch until upstream fixes it, and document any new patch in
  docs/architecture.md (D6).
- Private attributes (grade, student id, anything not meant to be public) exist only in the credential: never in the
  PDF, an HCS message, a log, an error or an API response. The PDF carries only name, course, issuer, date, id and QR.
- The PDF is published to HCS-1 **before** the credential is issued, and the credential's `document_sha256` is the
  SHA-256 of exactly those bytes. HCS-1 files have one codec: `packages/sdk/certificates/hcs1.ts`; reads go through
  `fetchHcs1File`, which verifies the memo hash and refuses topics with an admin key.
- `AccreditationRegistry` holds trust (which credential definitions an authority recognizes for a course, with
  `grantedAt`/`withdrawnAt`), never certificate status: revocation stays in AnonCreds on HCS. Platform B builds proof
  restrictions from `credentialDefinitions(course)` and accepts the issuer only if `isAccredited(course, id, T)` at the
  proof's time. A withdrawn definition is never re-accredited. Contracts ship with Hardhat tests; after changing one run
  `yarn codegen` (`packages/sdk/generated/` is generated, committed and never edited; the tests fail on stale output).
  Deploy and write with the Hedera SDK (`accreditation.ts`); read through the Mirror Node `contracts/call`.
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
- Writes to Hedera happen only in `yarn issuer:init`, issuance, revocation and accreditation withdrawal, and only with the operator configured
  in `.env`. Nothing runs on mainnet without `--allow-mainnet`.
- Tests are offline and credential-free: use `InMemoryHedera` from `@sh/sdk/testing` (it replaces the Hiero HCS
  transport, so the real Credo and Hiero code runs). Runtime code never imports `testing/`. Live Testnet runs are
  manual (`yarn issuer:init`, the console) and their HashScan links go in the README.
- External integrations use an interface, a timeout, validation and a deterministic test fixture.
- The Hedera Harness recipe in `.harness/` (`spec.yaml`, `validators/static.json`, `validators/yarn.json`, `prd.md`) ships
  into every scaffolded project. When you add a root script, a module or a normative rule, update the validators in the
  same change; never assert `template.json` there (the CLI deletes it). See [docs/harness.md](docs/harness.md).
- Secret scanning has one implementation: `.gitleaks.toml` run by `scripts/secret-scan.mjs`; never silence a finding
  without a narrow, documented allowlist entry, and never print a matched value.

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
`@sh/sdk`; the manifest declares `solidityFramework: hardhat`. `@sh/sdk` is consumed as TypeScript source. One `.env` at the
repository root; secrets never use the `NEXT_PUBLIC_` prefix. `.env.example` is generated from `template.json`
(`envVars`); keep them equal (`node scripts/validate-template.mjs`). Scaffold with
`npm create scaffold-hbar@latest -- --template <owner>/<repo>`.

## Definition of Done
Tests, lint/typecheck/format, error handling, docs, no secrets (`yarn secrets:scan` exits 0), HashScan evidence for
Testnet changes, and every applicable item of the security Definition of Done in
[docs/security.md](docs/security.md#7-security-definition-of-done-every-pull-request).
