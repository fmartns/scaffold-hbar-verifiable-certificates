# Quick start

Two paths. The first takes about five minutes and needs no Hedera account; the second issues and revokes a real
credential on Testnet in about fifteen. Every command below exists in the root `package.json`; when one fails, the
exact messages and fixes are in [troubleshooting.md](troubleshooting.md).

Prerequisites: Node.js >= 20.18.3, Git with `user.name`/`user.email` set, and Yarn (`corepack enable` turns on the Yarn
that ships with Node). For `yarn self-check` and `yarn secrets:scan` you also need
[gitleaks](https://github.com/gitleaks/gitleaks) (`brew install gitleaks` on macOS).

## Path 1: offline, five minutes

```bash
npm create scaffold-hbar@latest -- --template fmartns/scaffold-hbar-verifiable-settlement
cd <project-name>
yarn install     # if the CLI did not run it
yarn doctor      # Node, Yarn and .env; a missing .env is only a warning here
yarn test        # SDK, contracts and frontend, offline and credential-free
yarn dev         # http://localhost:3000
```

The `--` before `--template` is required: without it npm swallows the flag and the CLI never sees it.

What you just ran:

- `yarn test` includes `CredentialLifecycle.flow.test.ts`, the whole issuer → HCS → `CredentialRegistry` → verifier flow
  against the compiled contract, with an in-memory HCS topic and a fake Mirror Node (including indexing lag). The test
  layers and fixtures are in [testing.md](testing.md).
- <http://localhost:3000/dashboard> renders every integration as **Not configured** with the command that fixes it.
- <http://localhost:3000/issuer> explains what is missing and disables its forms.

`yarn check` (lint, types, tests and the harness recipe) is the inner loop from here on.

## Path 2: a real credential on Testnet

### 1. Create and fund an account

Create a Testnet account at <https://portal.hedera.com> and choose an **ECDSA** key. ECDSA is not required by the
operator (ED25519 works for `yarn setup` and HCS), but the same key can then be the contract deployer and be imported
into MetaMask as the issuer's signer, which keeps this guide to one account. The portal funds it with test HBAR; top
up at <https://portal.hedera.com/faucet>. `yarn setup` requires at least 20 HBAR on Testnet.

### 2. Configure and validate

```bash
cp .env.example .env
```

Set `HEDERA_OPERATOR_ID` (`0.0.x`) and `HEDERA_OPERATOR_KEY` (the hex private key, DER or raw 32 bytes). `.env` is
git-ignored; never commit it and never give a variable holding a key the `NEXT_PUBLIC_` prefix. Every variable is
explained in the [README](../README.md#variáveis-de-ambiente).

```bash
yarn setup
```

It checks, without spending anything, that the network is valid, the account exists, the key controls it and the
balance is enough. Exit code 0 means valid, 1 invalid (each problem is listed with its fix), 2 network unreachable.

### 3. Create the HCS evidence topic

```bash
yarn hcs:topic --write --smoke-test
```

It shows the plan and the estimated cost (about US$ 0.02 for the topic, plus about US$ 0.0005 for the smoke-test
message), asks `[Y/n]`, creates the topic with the operator key as `submitKey`, writes `HEDERA_HCS_TOPIC_ID` to
`.env`, then publishes one message and reads it back from the Mirror Node. It never creates a second topic over a
usable configured one. Keep the HashScan link it prints.

### 4. Deploy `CredentialRegistry`

The deployer key is passed only to this command and is never written to `.env` (there is no default key: without it a
live deploy fails). In zsh or bash with `HIST_IGNORE_SPACE`/`HISTCONTROL=ignorespace`, the leading space keeps the
line out of shell history.

```bash
 __RUNTIME_DEPLOYER_PRIVATE_KEY=0x<ecdsa-private-key> yarn deploy --network hederaTestnet
```

The deployer becomes the registry admin and the topic number from `HEDERA_HCS_TOPIC_ID` is fixed in the contract
(`hcsTopicNum`). The deploy ends by regenerating `packages/sdk/generated` with the address, the contract id and
HashScan links ([integration.md](integration.md#contract-abi-and-address-codegen)). Copy the printed address into
`.env`:

```bash
HEDERA_CREDENTIAL_REGISTRY_ADDRESS=0x<address printed by the deploy>
```

Restart `yarn dev` and open <http://localhost:3000/dashboard>: operator, relay, Mirror Node, topic and registry should
be **OK**, and the registry row cross-checks that it was deployed for the configured topic.

### 5. Register the issuer

Issuers are registered by the admin, once per namespace; the console never does it. The namespace is
`keccak256` of a lowercase name such as `acme-university` ([credential-schema.md §3.1](credential-schema.md#31-issuer)).
The signer is the wallet address that will sign in the console. `maxValidity` caps each signature window
(`validUntil - signedAt`), from 1 second to 30 days; the console's default window is 10 minutes.

```bash
 __RUNTIME_DEPLOYER_PRIVATE_KEY=0x<ecdsa-private-key> yarn workspace @sh/hardhat hardhat console --network hederaTestnet
```

```js
const registry = await ethers.getContractAt("CredentialRegistry", "0x<registry address>");
const issuer = ethers.keccak256(ethers.toUtf8Bytes("acme-university"));
await (await registry.registerIssuer(issuer, "0x<issuer wallet address>", 86400)).wait();
await registry.issuerOf(issuer);
```

`IssuerAlreadyRegistered` means the namespace is taken on this deployment; pick another name. The admin and issuer
roles are described in [credential-registry.md](credential-registry.md#access-control).

### 6. Issue a credential

1. Import the issuer key into MetaMask (or use HashPack in EVM mode). The console offers to add and switch to Hedera
   Testnet (chain 296) when the wallet is elsewhere.
2. At <http://localhost:3000/issuer>, connect the wallet and fill the form: **Issuer namespace** is the name you
   registered (`acme-university`), then a credential type (the presets of [credential-schema.md §6](credential-schema.md#6-examples-three-credential-types-one-schema-model)),
   a reference, the claims and the holder identifier.
3. Submit. The console builds and signs the `CredentialEvent`, dry-runs `issue` (contract errors show up here, before
   anything is paid), publishes the signed message to HCS and waits for the consensus receipt, then sends `issue` with
   the real `HcsRef`.
4. The result shows the credential ID (with a QR code), the HCS transaction on HashScan, the registry transaction and
   the one-time holder secret. Download the holder document for the holder; the raw identifier never left the browser.

The full flow, the submitter pin and every error state are in [issuer-console.md](issuer-console.md).

### 7. Verify and audit

- The console's audit panel runs `auditCredential` ([credential-audit.md](credential-audit.md)). Right after issuing it
  usually says `pending_index`: the Mirror Node has not indexed the log or the message yet (seconds). It re-queries
  until the evidence is `consistent`.
- The dashboard's **Credential status** card reads `statusOf(credentialId)` from the contract: that is the answer.
- The public verifier page (`/verify/[credentialId]`, link and QR code) is planned in
  [#40](https://github.com/fmartns/scaffold-hbar-verifiable-settlement/issues/40).

### 8. Revoke

In the console's revoke card, enter the credential ID and a reason, then confirm in the dialog. Revocation is final and goes through the same
publish-then-transact flow; `statusOf` becomes revoked and the audit shows the revocation evidence.

## Next

- Add your own credential type, contract or network: [README, Customização](../README.md#customização).
- What each Hedera service does and costs here: [hedera.md](hedera.md).
- Before mainnet: [deployment.md](deployment.md) and the security Definition of Done in [security.md](security.md).
