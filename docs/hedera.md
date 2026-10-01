# Hedera services in this template

What each Hedera service does here, why it is needed, where the code lives and how it fails. The plain-language
argument is in the [README](../README.md#por-que-cada-integração-hedera-é-indispensável); the normative rules are in
[architecture.md](architecture.md) (ADR-001, and [ADR-002](architecture.md#adr-002--credentials-privacy-on-chain-vs-off-chain-and-data-model) for the credential privacy and data model).

| Service | Role here | Without it | Code |
|---|---|---|---|
| Smart contracts (Hedera EVM) | `CredentialRegistry` decides credential status | Status is whatever the issuer's server says | `packages/hardhat/contracts` |
| Consensus Service (HCS) | Ordered, timestamped, issuer-signed evidence of each issue and revoke | Only current state survives; no proof of what was signed and when | `packages/sdk/hedera/hcs` |
| Mirror Node | Read-only index that correlates contract logs with HCS messages | Nobody can link the record to its evidence without running a node | `packages/sdk/hedera/audit` |
| JSON-RPC relay | EVM access for Hardhat, wallets and contract reads | No deploy, no wallet transactions | `packages/sdk/hedera/networks.ts` |
| HashScan | Human-readable proof link for every transaction | Evidence exists but is hard to show | `packages/sdk/hedera/explorer.ts` |
| Token Service (HTS) | Not used by credentials; previous settlement direction only | Nothing in the credential flow | `packages/sdk/hedera/hts` |

## Smart contracts: `CredentialRegistry`

**What it does.** Registers issuer namespaces and their signer (`registerIssuer`, admin only), accepts `issue` and
`revoke` with an EIP-712 signature from the namespace's current signer, records each `credentialId` once and answers
`statusOf(credentialId)`. It is the only source of truth for status ([credential-registry.md](credential-registry.md)).

**Why a contract.** Status must be public and must not depend on the issuer's server. The contract also enforces what
no role can do: change the hash or subject of an issued credential, re-issue an id, or un-revoke. Every revocation
records who did it.

**How it runs on Hedera.** Solidity 0.8.28 compiled for `cancun`, deployed through the JSON-RPC relay with
`hardhat-deploy`. Each deployment has an EVM address (`0x…`) and a Hedera contract id (`0.0.x`); the codegen resolves
the contract id on the Mirror Node and records both in `packages/sdk/generated`. Contracts are verified on Sourcify
(Hedera has no Etherscan API).

**Fails how.** Reverts with custom errors (`UnknownIssuer`, `AlreadyIssued`, `Expired`, `SubmitterMismatch`, ...),
decoded by name in the SDK. The issuer console dry-runs `issue` with `eth_call` first, so most of them appear before
anything is paid ([issuer-console.md](issuer-console.md#errors)).

## Hedera Consensus Service (HCS)

**What it does.** One topic per deployment receives a message per issuance (`0x10`) and revocation (`0x11`): the
ABI-encoded signed event and the issuer's signature. The network gives each message a consensus timestamp and a
sequence number. The message format has one implementation, `packages/sdk/hedera/hcs/credential-envelope.ts`.

**Why HCS.** It is a cheap, ordered, tamper-evident log that the issuer cannot rewrite. It lets anyone prove what the
issuer signed and when, check that the evidence was published **before** the registry transaction (ADR-001 D11), and
detect equivocation (two validly signed contents for the same `credentialId`).

**What it is not.** HCS is evidence, not validity. The contract cannot read HCS: the `HcsRef` passed to `issue` is the
publisher's claim and is checked off-chain by the audit, never on-chain. Messages are public, so only hashes and the
salted `subjectCommitment` are published, never personal data.

**Setup and cost.** `yarn hcs:topic` creates the topic with the operator key as `submitKey` (only the operator can
publish), about US$ 0.02 once; each message costs about US$ 0.0005. The registry stores the topic number at deploy
(`hcsTopicNum`), and the dashboard cross-checks it against `HEDERA_HCS_TOPIC_ID`.

**Fails how.** The publisher waits for the consensus receipt and returns the transaction ID and HashScan URL. It never
retries on its own: after an `unknown` outcome the caller checks the transaction ID first, so a message is not
published twice ([hcs-envelope.md](hcs-envelope.md)).

## Mirror Node

**What it does.** A read-only REST index of the network: account balances and keys (`yarn setup`), topic messages,
contract logs and contract ids. `auditCredential` reads `statusOf` over the relay, then fetches the
`CredentialIssued`/`CredentialRevoked` logs and the HCS messages they point to, and reports whether they match
([credential-audit.md](credential-audit.md)).

**Why the Mirror Node.** It is the only place where both sources can be read together without running a node and
without any key. That is what lets a verifier, and not only the issuer, audit a credential.

**Eventual consistency.** The Mirror Node indexes a few seconds behind consensus. Data that is not there yet is
`pending` while the fact is younger than the index budget (60 s), and reported missing only after that. The audit
polls for `HEDERA_AUDIT_POLL_TIMEOUT_MS` (default 20 s) before answering. The dashboard warns when the Mirror Node lags
beyond the budget. The report explains `statusOf` and never overrides it.

## JSON-RPC relay

The EVM entry point for Hardhat, the wallet and browser reads. Defaults are the public Hashio endpoints, meant for
development and testing; they rate-limit, which the console reports as `rpc_unavailable`. `HEDERA_RPC_URL` points the
server and Hardhat to another relay, and applies only to the network selected by `HEDERA_NETWORK`. Browser reads always
use the network's public relay from `networks.ts`, so a private relay URL never reaches the bundle.

## Accounts, keys and the operator

- **Operator** (`HEDERA_OPERATOR_ID`/`HEDERA_OPERATOR_KEY`): a Hedera account used server-side to pay for HCS topic
  creation and publication. ED25519 or ECDSA. `validateHederaEnvironment` checks that it exists, that the key controls
  it and that the balance is enough, and never prints the key.
- **Deployer** (`__RUNTIME_DEPLOYER_PRIVATE_KEY`, passed at run time): an ECDSA account, because the relay signs EVM
  transactions with secp256k1. It becomes the registry admin.
- **Issuer signer**: the EVM address registered for a namespace. It signs in the browser wallet and sends `issue` and
  `revoke`; the server never sees its key.

Testnet is reset periodically. Keys survive a reset but account ids change, so `yarn setup` reports
`ACCOUNT_NOT_FOUND` until you create a new account and update `.env` ([troubleshooting.md](troubleshooting.md)).

## HashScan

Every HCS publication and registry transaction is shown with its HashScan link, built in one place
(`packages/sdk/hedera/explorer.ts`). The local network has no public explorer, so links are omitted there. HashScan is
how a change on Testnet is evidenced in a pull request (Definition of Done in [AGENTS.md](../AGENTS.md)).

## Hedera Token Service (HTS)

Not part of the credential flow. The HTS adapter, `yarn hts:token` and `yarn hts:settle` belong to the previous
settlement direction and stay as history ([hts-adapter.md](hts-adapter.md)). A credential is a registry record, not a
token.

## Networks

Chain ids and URLs live only in `packages/sdk/hedera/networks.ts`.

| `HEDERA_NETWORK` | Chain id | Hardhat network | Relay | Mirror Node | Explorer |
|---|---|---|---|---|---|
| `testnet` (default) | 296 | `hederaTestnet` | `https://testnet.hashio.io/api` | `https://testnet.mirrornode.hedera.com` | `https://hashscan.io/testnet` |
| `mainnet` | 295 | `hederaMainnet` | `https://mainnet.hashio.io/api` | `https://mainnet.mirrornode.hedera.com` | `https://hashscan.io/mainnet` |
| `local` (Hedera Local Node) | 298 | `hederaLocal` | `http://127.0.0.1:7546` | `http://127.0.0.1:5551` | none |
