# Testnet validation (`yarn verify:testnet`)

Status: **implemented in issue #18**. Logic in `packages/sdk/hedera/testnet`, CLI in `packages/sdk/cli/verify-testnet.ts`,
evidence in [`docs/evidence/testnet/`](evidence/testnet/).

`yarn verify:testnet` runs the whole credential flow against the **real** Hedera Testnet (not a mock) and writes versioned
evidence: transaction IDs, HashScan and Mirror Node links, timings and the full audit reports. It is the smoke test the
bounty submission (#20) cites. It is opt-in: it spends Testnet HBAR and needs the operator, so it is never part of
`yarn check` or CI.

## What it does

For each run (default 2, so one lucky result is not mistaken for a working flow), with a new throwaway credential:

1. **Issue** with `runIssuance`, the issuer console's flow (#12): build, sign (EIP-712), dry-run, **publish the evidence
   to HCS and capture the consensus receipt**, and only then send `issue(event, signature, hcsRef)` (ADR D11).
2. **Audit** with `auditCredential` (#10) until the report settles. While the Mirror Node has not indexed the facts the
   report is `pending_index` and is asked again, up to the index budget; the run passes only on `consistent` with
   `statusOf = issued`. The report is never overridden.
3. **Try to re-issue it**, deliberately (the issue's acceptance criterion):
   - replay the exact signed issuance with its `HcsRef` (`eth_call` of `issue`): must revert `AlreadyIssued`;
   - issue the same reference again through the full flow (fresh holder salt, so different content): must revert
     `ConflictingCredential` at the dry-run, **before anything is published or paid**.
4. **Revoke** with `runRevocation`: status check, sign, dry-run, revocation evidence to HCS first, then `revoke()`.
5. **Audit again** until `consistent` with `statusOf = revoked`, and try to revoke it again: must be refused
   (`AlreadyRevoked`) with nothing published.

A run passes when both audits are consistent and every replay was refused with nothing paid. The command exits 0 only
when every run passed.

## Reuse, not re-implementation

| Concern | Implementation used |
|---|---|
| Preflight (network, operator, key, balance) | `validateHederaEnvironment` |
| Registry address and ABI | `getDeployedContract` (env override, else `packages/sdk/generated`), generated ABI |
| Issuance / revocation order (D11), EIP-712, calldata, error taxonomy | `runIssuance` / `runRevocation` (`hedera/credentials`) |
| HCS publication, authorization, credential envelope | `handlePublishCredential` / `handleCredentialStatus`, the console's own server handlers, called in process |
| Correlation HCS ↔ registry through the Mirror Node | `auditCredential` |
| Explorer links, costs | `hedera/explorer.ts`, `hedera/cost.ts` |

The only new adapter is `createRelayWallet`: an EIP-1193 provider that signs locally with a key and forwards everything
else to the JSON-RPC relay, so the browser flow runs from Node unchanged.

## Who signs and pays

The operator (`HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY`) is the issuer's wallet: it signs the credential, sends the
registry transactions and pays the HCS messages. Only an **ECDSA (secp256k1)** key has an EVM address, so an ED25519
operator is refused with `ISSUER_KEY_NOT_ECDSA` (create an ECDSA account in the Hedera portal).

The issuer namespace is `scaffold-hbar-verify` (`--issuer <namespace>` to change it). If it is not registered and the
operator holds `ADMIN_ROLE` (it deployed the registry), the command registers it once with `registerIssuer` (shown in
the plan). If it is registered with another signer, inactive, or the operator is not admin, it stops with the exact fix.

## Safety

- **Testnet only.** `HEDERA_NETWORK=mainnet` is refused (`MAINNET_REFUSED`) before anything is read; `local` too.
- **Asks before paying.** The plan and the estimated cost (HCS messages + gas upper bounds × the relay's gas price,
  converted with the Mirror Node exchange rate) are shown first; `[Y/n]`. `--yes` skips the question; without a
  terminal and without `--yes` nothing is sent. A balance below the estimate is refused.
- **No secret in the output.** The key never leaves the wallet closure; the report holds identifiers, links, timings
  and verdicts only. The holder identifier is synthetic (`holder.<runId>.<n>@example.com`) and is never written.

## Usage

```bash
yarn setup                                   # the environment must be valid (ECDSA Testnet operator)
yarn hcs:topic --write                       # only if HEDERA_HCS_TOPIC_ID is empty
yarn deploy --network hederaTestnet          # only if no CredentialRegistry is configured (deployer key injected at run time)
yarn verify:testnet --dry-run                # preflight and plan only: nothing paid, nothing written
yarn verify:testnet                          # shows the plan and cost, asks, runs, writes the evidence
yarn verify:testnet --yes --runs 3           # no question; 1 to 5 runs
```

`--json` prints the report on stdout (needs `--yes` or `--dry-run`). Exit codes follow `yarn setup`: 0 passed, 1 failed
or invalid, 2 the network could not be reached.

Each run writes `docs/evidence/testnet/<runId>.md` (for people) and `<runId>.json` (with the complete audit reports),
where `<runId>` is the UTC start time (`20261001T124500Z`). Commit both: the evidence must not depend on HashScan's live
state, and Testnet can be reset.

## Failures

A failed step stops the validation and the report records the stage, the classified error and the identifiers to
reconcile with (HCS transaction ID, transaction hash). An HCS publication with an unknown outcome is never retried
automatically (the publisher never retries): check the transaction on HashScan before running again. Typical causes:

| Code | Fix |
|---|---|
| `MAINNET_REFUSED`, `NOT_TESTNET` | `HEDERA_NETWORK=testnet` |
| `MISSING_ENV`, `INSUFFICIENT_BALANCE`, … | what `yarn setup` reports; fund the account at the faucet |
| `TOPIC_NOT_CONFIGURED` | `yarn hcs:topic --write` |
| `REGISTRY_NOT_DEPLOYED` | `yarn deploy --network hederaTestnet` |
| `ISSUER_KEY_NOT_ECDSA` | an ECDSA Testnet operator |
| `ISSUER_NOT_REGISTERED`, `ISSUER_SIGNER_MISMATCH` | registry admin registers the namespace, or `--issuer` |
| audit not `consistent` | the report's findings say which evidence is missing or mismatched |

## Tests

Deterministic and offline (`yarn test`): `hedera/testnet/*.test.ts` and `cli/verify-testnet.test.ts` run the real
plan, issuer flow, server handlers, HCS publisher and audit against `fakeTestnet` from `@sh/sdk/testing` (a relay backed
by an in-memory `CredentialRegistry` with the contract's checks, errors and events, the in-memory topic and the fake
Mirror Node). Covered: two consistent runs with every replay refused, issuer registration, Mirror indexing lag, failed
HCS publication, an audit that never settles, mainnet/local refusal, every preflight refusal, the cost estimate, the
confirmation and `--dry-run`/`--json`, and that no key reaches the output.
