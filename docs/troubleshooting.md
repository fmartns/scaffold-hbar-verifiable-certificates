# Troubleshooting

Real errors met while building and running this template, with their cause and fix.

## Install and toolchain

**`npm error 'node' is not recognized as an internal or external command` during `npm install` (Windows).**
npm runs install scripts through `cmd.exe`, which did not find `node` on its `PATH` (common with nvm-windows or several
Node installations). The template uses Yarn, which runs scripts with its own shell; use `yarn install`. If Yarn is not
on your `PATH`, run `corepack enable`, or call the pinned release directly: `node .yarn/releases/yarn-3.2.3.cjs install`.

**`@credo-ts/node` requires Node >= 20.19.** Credo is ESM-only and its Node package requires 20.19 or newer
(`require(esm)`). Upgrade Node; the CLI and `engines` enforce it.

**Install fails downloading `library-<platform>.tar.gz` or a `zstd-napi` prebuild.** The Askar, AnonCreds and zstd
packages download prebuilt binaries from their GitHub releases during install (macOS x64/arm64, Linux x64/arm64,
Windows x64). Behind a proxy or offline, allow `github.com` and `objects.githubusercontent.com`, then run
`yarn install` again. Other platforms build zstd from source and need a C toolchain.

**`No available zstd module found. Please install 'zstd-napi'`.** The Hiero AnonCreds registry compresses revocation
entries with zstd, an optional dependency of the Hiero SDK. `@sh/sdk` and `@sh/nextjs` both depend on `zstd-napi`; if
you moved code elsewhere, add it there too.

## Environment (`yarn setup`)

**`HEDERA_OPERATOR_ID is not set or is empty`.** Run `cp .env.example .env` and fill in the operator. In the Next.js
app, the root `.env` is loaded by `next.config.ts`; restart `yarn dev` after editing it.

**A raw hex key is rejected, or Hedera answers `INVALID_SIGNATURE`.** A 32-byte hex key is valid for both ED25519 and
ECDSA, and the Hedera SDK reads bare hex as ED25519. The template reads the curve from your account on the Mirror Node
(`keyType` in `validateHederaEnvironment`) and converts the key to DER. If `yarn setup` reports `KEY_UNVERIFIABLE`
(multi-key accounts), put the key in DER form (`302e…` for ED25519, `3030…` for ECDSA).

**`AccountBalanceQuery` fails with `max attempts of 10 was reached … BUSY`.** On 2026-10-03 every Testnet consensus node
answered the free balance query with `BUSY` while transactions worked. `yarn setup` reads balances from the Mirror Node
and is not affected; do the same in your own scripts.

## Issuer and certificates

**`Unable to register Did: Timeout of 120000ms exceeded while waiting for DID update to be visible on the network`.**
The Hiero registrar looks for the new DID message between the start of the wait and the local time *at the start of
the wait*. If your clock is behind consensus (one second is enough), the message is never in the window. The template
ships a `yarn patch` that moves the window (`.yarn/patches/@hiero-did-sdk-registrar-*.patch`); if you see this error,
check that `package.json` still has the `resolutions` entry for it, and sync your clock. The DID topic was created
anyway (visible on HashScan) but its key stayed in the failed run's wallet; run `yarn issuer:init` again.

**`Either timestamp and revocation state must be presented, or neither` when building a proof.** The Hiero AnonCreds
registry returns revocation status lists stamped in milliseconds; AnonCreds expects seconds. `HederaVdrRegistry`
(`packages/sdk/certificates/agents.ts`) fixes it. You get this error if an agent registers the plain
`HederaAnonCredsRegistry` instead.

**`Run \`yarn issuer:init\` (or Initialize issuer) first.` (HTTP 409).** The data directory has no issuer for the selected
network. Run `yarn issuer:init`. Switching `HEDERA_NETWORK` or `CERTIFICATES_DATA_DIR` starts from an empty issuer.

**`The holder could not build this proof` / DENIED with "The holder has no certificate to present."** Expected for a
grade below 70, a revoked certificate as of now, or a holder without the credential. The decision card says which.

**`The proof uses a revocation state from another time than requested.`** The proof was built for a different
`non_revoked` instant than the request it was checked against. Build a fresh proof for each request.

**A revocation does not show up immediately.** Mirror Nodes index a few seconds after consensus; proofs "as of now"
reflect the revocation once the entry is indexed.

**`INSUFFICIENT_PAYER_BALANCE` during `yarn issuer:init`.** Creating the accreditation contract costs about 10.5 HBAR
(Hedera's contract creation fee); the whole command about 12. Top up the account at the faucet and run it again: the
issuer half is not repeated.

**DENIED with "The certificate's issuer was not accredited …".** The accreditation authority withdrew the issuer's
credential definition (or never accredited it) at the time asked. Withdrawal is permanent for that definition; start
over with a fresh `CERTIFICATES_DATA_DIR` and `yarn issuer:init`.

**`… is stale: run \`yarn codegen\``** in the contract tests. The contract changed; regenerate
`packages/sdk/generated/AccreditationRegistry.ts` and commit it.

**`REGISTRY_FULL`.** A revocation registry holds `maximumCredentialNumber − 1` certificates (999). The template does
not rotate registries; publish a new issuer on a fresh data directory, or add rotation.

**`HCS-1 chunk N is missing` or `does not match the hash in the topic memo` when downloading a PDF.** Right after an
upload the Mirror Node may not list every chunk yet (the issuer waits for it; a reader may be faster). Retry after a
few seconds. A persistent mismatch means the Mirror Node served different data: try another Mirror Node
(`HEDERA_MIRROR_NODE_URL`).

## Next.js build

**`Module parse failed: Unexpected character` in `koffi/build/…/koffi.node`.** The native Askar binding was bundled.
Server-only packages must be listed in `SERVER_EXTERNALS` in `packages/nextjs/next.config.ts` and be dependencies of
`@sh/nextjs`: `serverExternalPackages` alone does not apply to imports made from the transpiled `@sh/sdk` workspace.

**`Selector "input, select, button" is not pure` in a CSS module.** CSS modules only accept selectors with a local
class; scope element styles (`.panel input`) or put them in `app/globals.css`.

## Self-check, CI and harness

**`Secret scan could not run: gitleaks was not found`.** Install gitleaks (or set `GITLEAKS_BIN`); CI installs it.

**`yarn harness:validate` refuses to run.** It refuses a workspace with a `.env`, so run it in a clean clone.

**Commit hook fails with `yarn: command not found`.** The Husky pre-commit hook runs `yarn lint-staged`; make Yarn
available on your `PATH` (`corepack enable`).
