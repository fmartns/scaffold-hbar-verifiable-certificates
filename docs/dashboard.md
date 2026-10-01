# Environment dashboard (#11)

`/dashboard` shows at a glance whether the Hedera environment is usable: network, operator account and balance, the
connected wallet, the deployed `CredentialRegistry`, the HCS evidence topic, and one health status per integration.
It is about infrastructure, not about operating credentials: issuing and revoking belong to the issuer console (`/issuer`, [issuer-console.md](issuer-console.md)),
checking a credential to the public verifier (#40).

Open it with `yarn dev` and go to <http://localhost:3000/dashboard>. It renders without a `.env` (everything shows as
**Not configured** with the command that fixes it).

## One source of data

The page calls `checkHederaHealth(process.env)` from `@sh/sdk` on every request (`force-dynamic`) and only renders
the result. The report is also served as JSON at `GET /api/env/status` for scripts and the CI self-check (#14).
`checkHederaHealth` composes the existing checks and never re-implements them:

| Integration        | Checked by                                                         | `not_configured` when                           |
| ------------------ | ------------------------------------------------------------------ | ----------------------------------------------- |
| Operator account   | `validateHederaEnvironment` (#5), with `requireOperatorKey: false` | `HEDERA_OPERATOR_ID` is not set                 |
| Mirror Node        | latest block (`/api/v1/blocks`), lag vs the audit's index budget   | never (always has a default)                    |
| JSON-RPC relay     | `eth_chainId` equals the selected network's chain id               | never (always has a default)                    |
| HCS evidence topic | `verifyHcsTopic` (#6): exists, not deleted, has a submitKey        | `HEDERA_HCS_TOPIC_ID` is not set                |
| CredentialRegistry | `hcsTopicNum()` and `paused()` over the relay (#9/#10 reader)      | no `HEDERA_CREDENTIAL_REGISTRY_ADDRESS` and no deployment in `packages/sdk/generated` for the network |

Statuses are `ok`, `error` and `not_configured`. An `error` caused only by connectivity carries `transient: true` and
is shown as **Unreachable**: the configuration is not proven wrong. Every status other than `ok` has a remediation
(tested). Warnings do not change the status: a Mirror Node lagging beyond 60 s (audits will report recent records as
pending), paused issuance, mainnet selected, or a topic whose submitKey could not be compared because no operator key
is configured.

Cross-checks that catch real misconfigurations:

- the registry answers on the selected network (an address without a contract is `error`, not "unreachable");
- the registry was deployed for the configured topic (`hcsTopicNum` must equal the number of `HEDERA_HCS_TOPIC_ID`;
  the contract stores only the number, shard and realm are 0 on every public network);
- the relay serves the selected chain.

Identifiers come from the environment and links from `packages/sdk/hedera/explorer.ts`; nothing is hardcoded. The
registry address is `HEDERA_CREDENTIAL_REGISTRY_ADDRESS` when set, otherwise the one the last `yarn deploy` recorded in
`packages/sdk/generated` (ABI/address codegen, #24); the **Address from** row says which. See
[integration.md](integration.md#contract-abi-and-address-codegen).

The **Credential status** card reads `statusOf(credentialId)` from the browser through the `useCredentialRegistry()` hook
(public relay of the network, never `HEDERA_RPC_URL`). It is a read-only probe of the registry; the verifier (#40)
and the issuer console (#12) own the credential flows.

## Wallet

The wallet panel talks to the browser's EIP-1193 provider (MetaMask, HashPack in EVM mode, …) without extra
dependencies. It shows connected/disconnected, the address and its Hedera account id (resolved server-side through the
configured Mirror Node at `GET /api/wallet/account`; an address that never received HBAR has none yet, which is shown
as a state, not an error), the chain versus the target network, and the balance. On the wrong chain it offers
**Switch to &lt;network&gt;**, adding the chain to the wallet when it does not know it.

Client code imports client-safe subpaths (`@sh/sdk/hedera/wallet`, `@sh/sdk/hedera/contracts`,
`@sh/sdk/hedera/audit/registry`, `@sh/sdk/hedera/networks`), never the package root, so the browser bundle does not
pull in the Hedera SDK. The chain added to a wallet always uses the public relay from `networks.ts`, never `HEDERA_RPC_URL`.

## Security

- The health check needs no private key. When `HEDERA_OPERATOR_KEY` is set it is used server-side only, to compare
  public keys with the account and the topic's submitKey; it never enters the report.
- Every URL in the report is reduced to its origin, so an API key in a custom relay or Mirror Node path never reaches
  the browser (tested with overrides carrying secrets in path and query).
- **Copy diagnostics** copies the same report as JSON for bug reports.

## Not in scope yet

- Reference mode with the last reference credential (needs the testnet evidence of #18).
- HTS and oracle cards from the earlier settlement design; the credential flow does not use them.
- A distinct `degraded` state for relay rate limits: they show as **Unreachable** (transient).
