# Troubleshooting

Each entry is an error reproduced on a fresh clone, with the message as it is printed and the fix. Messages never
contain a private key; never paste one into an issue either. If a command reports something not listed here, run
`yarn setup` first: it checks network, account, key and balance and names the variable to fix.

## Install and toolchain

**`Usage Error: Couldn't find the node_modules state file - running an install might help (findPackageLocation)`**

Any `yarn <script>` on a fresh clone before the first install. Run `yarn install`. Yarn refuses scripts until then, so
the two dependency-free scripts are called with `node` before installing: `node scripts/doctor.mjs` and
`node scripts/self-check.mjs` (which treats the clean install as one of its requirements).

**`FAIL  Node.js 18.x is older than the required >= 20.18.3.`** (from `yarn doctor`)

Install Node.js 20.18.3 or later (CI runs 20.18.3 and 24).

**`FAIL  Yarn was not found on PATH.`**

Run `corepack enable`. The repository pins Yarn 3.2.3 in `.yarn/releases`; any Yarn launcher picks it up.

**`warn  No .env file. Run cp .env.example .env ...`**

Only a warning: tests and the app run without `.env`. Create it when you need Testnet (`cp .env.example .env`).

## Environment (`yarn setup`)

`yarn setup` exits 0 when valid, 1 when invalid, 2 when the network is unreachable. Configuration problems are
reported together and no request is made while any exist.

**`x [MISSING_ENV] HEDERA_OPERATOR_ID is not set or is empty.`** and the same for `HEDERA_OPERATOR_KEY`

There is no `.env`, or the values are empty. `cp .env.example .env`, then set both from <https://portal.hedera.com>.
The same message appears from `yarn hcs:topic`, followed by `[CONFIG_INVALID] ... so no topic was created.`

**`x [INVALID_NETWORK] HEDERA_NETWORK "devnet" is not a supported network.`**

Use `testnet`, `mainnet` or `local`, or leave it empty for `testnet`.

**`x [INVALID_OPERATOR_KEY] HEDERA_OPERATOR_KEY is not a valid Hedera private key.`**

The value is an account id, a public key or a mnemonic. Use the hex private key, DER-encoded (`302e…`/`3030…`) or the
raw 32-byte hex string.

**`x [KEY_MISMATCH] HEDERA_OPERATOR_KEY does not belong to account 0.0.2: its public key differs from the account's key on testnet.`**

The key is valid but controls another account (or the account is on another network). Use the key created with that
account, or set `HEDERA_OPERATOR_ID` to the account this key controls.

**`x [ACCOUNT_NOT_FOUND] Account 0.0.999999999 does not exist on testnet (checked https://testnet.mirrornode.hedera.com).`**

A typo, the wrong network, or a Testnet reset: Testnet is reset periodically and account ids change (keys are kept).
Create a new account and update `HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_KEY`. After a reset, the HCS topic and the
registry deployment are gone too: rerun `yarn hcs:topic --write` and `yarn deploy --network hederaTestnet`.

**`INSUFFICIENT_BALANCE`**

The operator holds less than `HEDERA_MIN_BALANCE_HBAR` (20 HBAR on Testnet by default). Top up at
<https://portal.hedera.com/faucet>.

**`HEDERA_RPC_URL` or `HEDERA_MIRROR_NODE_URL` seems ignored**

Both override only the network selected by `HEDERA_NETWORK`, so one override cannot silently redirect another
network. Check `HEDERA_NETWORK` first. Browser reads always use the public relay of the network.

## Deploy

**`Error: ERROR processing .../00_deploy_credential_registry.ts: TypeError: Cannot read properties of undefined (reading 'length')`**

`yarn deploy --network hederaTestnet` without `__RUNTIME_DEPLOYER_PRIVATE_KEY`: the live network has no account, by
design (there is no default key). Pass it for this command only:
`__RUNTIME_DEPLOYER_PRIVATE_KEY=0x<ecdsa-key> yarn deploy --network hederaTestnet`. Do not put it in `.env`;
`DEPLOYER_PRIVATE_KEY_ENCRYPTED` is reserved and not read.

**`Error: HEDERA_HCS_TOPIC_ID is required to deploy CredentialRegistry on hederaTestnet.`**

The registry fixes its evidence topic at deploy. Create it first: `yarn hcs:topic --write`.

**`ProviderError: [Request ID: …] Error occurred during transaction simulation: Sender account not found.`**

The deployer key has no account on that network (never funded, wrong network, or a Testnet reset). Fund its EVM
address or create an ECDSA account in the portal and use its key.

**The dashboard says the registry was deployed for another topic**

`hcsTopicNum()` differs from `HEDERA_HCS_TOPIC_ID`: the topic was recreated after the deploy, or `.env` points to an
old topic. Restore the original topic id, or redeploy with the current one and update
`HEDERA_CREDENTIAL_REGISTRY_ADDRESS`.

**`codegen` fails in CI with stale output**

A contract changed and `packages/sdk/generated` was not regenerated. Run `yarn codegen` and commit the result; never
edit the generated files.

## Issuer console and wallet

The console's errors are listed by category in [issuer-console.md](issuer-console.md#errors). The ones people hit
first:

**Page shows what is missing and the forms are disabled; the API answers `503 not_configured`**

The server needs `HEDERA_NETWORK`, `HEDERA_HCS_TOPIC_ID`, `HEDERA_CREDENTIAL_REGISTRY_ADDRESS` and, to publish,
`HEDERA_OPERATOR_ID`/`HEDERA_OPERATOR_KEY`. Restart `yarn dev` after editing `.env`.

**`Wrong network`: "The wallet is on chain 1, but this console targets chain 296."**

The wallet is on another chain. Accept the switch the console offers (it adds Hedera Testnet if the wallet does not
know it), or switch manually to chain 296 (295 on mainnet, 298 local).

**`Wallet not connected`**

No injected wallet, no connected account, or the wallet is locked. Install MetaMask (or HashPack in EVM mode), unlock
it and click "Connect wallet".

**`issuer_not_registered` (`UnknownIssuer`, `UnauthorizedSigner`, `InactiveIssuer`) or `403 issuer_not_registered`**

The namespace was never registered on this deployment, the connected wallet is not its current signer, or the admin
deactivated it. The namespace must be exactly the lowercase name that was registered (`acme-university` is not
`acme`); uppercase is rejected by the form. Register it as in [quick-start.md](quick-start.md#5-register-the-issuer).

**`ValidityWindowTooLong`**

The signature window in the form is longer than the namespace's `maxValidity`. Shorten the window (default 10 minutes)
or have the admin call `setIssuerMaxValidity`.

**`Network unreachable` (`rpc_unavailable`)**

The public Hashio relay rate-limits. Wait a minute and retry, or set `HEDERA_RPC_URL` to your own relay for the server.

**`timeout` after publishing**

The HCS message or the transaction may still have gone through. The console keeps the HCS transaction id and the
transaction hash: check them on HashScan before retrying. Nothing is retried automatically, so nothing is published
twice behind your back.

## Mirror Node and audit

**Audit says `pending_index` (`ONCHAIN_LOG_PENDING`, `HCS_PENDING_INDEX`) right after issuing**

Not an error. The Mirror Node indexes a few seconds behind consensus; the audit polls for
`HEDERA_AUDIT_POLL_TIMEOUT_MS` (default 20 s) and the console asks again. Data is reported missing only once the fact
is older than the 60 s index budget.

**Audit reports `HCS_MISSING` or `ONCHAIN_LOG_MISSING` after a minute**

Check that `HEDERA_MIRROR_NODE_URL` matches `HEDERA_NETWORK`, and the dashboard's Mirror Node lag warning. A Mirror
Node that is far behind keeps recent facts pending; a wrong one never finds them. The authoritative answer is still
`statusOf`; the audit only explains it ([credential-audit.md](credential-audit.md)).

## Self-check, CI and harness

**`Secret scan could not run: gitleaks was not found (gitleaks). Install it (macOS: brew install gitleaks; ...) or set GITLEAKS_BIN.`**

`yarn secrets:scan` and the `secrets` requirement of `yarn self-check` need gitleaks. Install it, or point
`GITLEAKS_BIN` to the binary. CI installs a pinned, checksum-verified version. Exit code 2 means the scan could not run,
not that it found something ([self-check.md](self-check.md)).

**`README.md:<line> cites yarn <name>, which is not a root script.`**

The `docs` requirement checks every `yarn <script>` written in inline code in README.md and AGENTS.md. Add the script
to the root `package.json` or move the mention to the "Planned" line.

**`harness:validate` fails with `Forbidden file or directory exists: .env`**

By design: the harness validates a clean clone and refuses a workspace with `.env` (3 findings: forbidden file, static
validator, secret scan; every other step still runs). Run it in a fresh clone, or move `.env` away while it runs
([harness.md](harness.md)).

**`self-check` fails `manifest` in a generated project**

The CLI deletes `template.json`. In a project created by `npm create scaffold-hbar`, run `yarn self-check --skip manifest`.
