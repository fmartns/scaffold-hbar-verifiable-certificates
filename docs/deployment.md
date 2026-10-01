# Deployment

Testnet first. The step-by-step Testnet walkthrough, from account to first credential, is
[quick-start.md](quick-start.md#path-2-a-real-credential-on-testnet); this page lists what a deployment consists of and
what changes for mainnet.

## What a deployment is

One deployment per network, made of:

| Piece | Created by | Recorded in |
|---|---|---|
| Operator account (pays for HCS) | <https://portal.hedera.com> | `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY` (`.env`, never committed) |
| HCS evidence topic (`submitKey` = operator key) | `yarn hcs:topic --write` | `HEDERA_HCS_TOPIC_ID` |
| `CredentialRegistry` (deployer = admin, `hcsTopicNum` fixed from the topic) | `yarn deploy --network hederaTestnet` with `__RUNTIME_DEPLOYER_PRIVATE_KEY` in the shell | `packages/sdk/generated` (address, contract id, ABI hash; commit it) and `HEDERA_CREDENTIAL_REGISTRY_ADDRESS` |
| Issuer namespaces and signers | Admin calls `registerIssuer` ([quick-start.md §5](quick-start.md#5-register-the-issuer)) | On-chain (`issuerOf`) |
| Web app (`/dashboard`, `/issuer`, API routes) | `yarn build`, then `yarn serve` | Server environment |

Nothing is shared between networks: a new network needs its own topic, deploy and issuer registrations. After a
Testnet reset all of them are gone. `yarn setup` lists, for the selected network, where each contract is deployed or
the command that deploys it; `/dashboard` cross-checks topic, registry and relay.

Serving the app: `yarn build` bundles the generated manifest, so rebuild after every deploy before `yarn serve`. Set
the same variables as `.env` in the host's server-side environment; none of them is `NEXT_PUBLIC_`.

## Mainnet checklist

Mainnet is refused by default: `yarn hcs:topic` and the HTS scripts require `--allow-mainnet`, and operator custody is
refused. Before using it:

- The security Definition of Done in [security.md](security.md#9-security-definition-of-done-every-pull-request) holds,
  and its open findings are accepted or fixed.
- The admin key (registry `DEFAULT_ADMIN_ROLE`/`ADMIN_ROLE`) is not a hot developer key; the incident runbook in
  [security.md §7](security.md#7-incident-response) has an owner.
- `HEDERA_RPC_URL` points to a production relay (the public Hashio endpoints are for development) and
  `HEDERA_MIRROR_NODE_URL` to a Mirror Node you can rely on.
- The operator holds enough HBAR for the expected HCS volume (about US$ 0.0005 per message) and is monitored.
- The deploy and the first issuance are evidenced with HashScan links.
- The privacy and data-model decisions of [ADR-002](architecture.md#adr-002--credentials-privacy-on-chain-vs-off-chain-and-data-model) are reflected in the schemas
  you publish.
