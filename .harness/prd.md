# Feature brief (edit the "Feature to implement" section)

## Goal

Extend this verifiable-settlement project with one feature, using
`hedera-harness run`. Do **not** rebuild the app, replace its architecture or
re-implement a module that already exists.

## Who it is for

Developers who scaffolded this template and add their own use case on top of
it: a settlement policy, an oracle provider, a console page, an audit view.

## Existing app (preserve)

Read `AGENTS.md` and `docs/architecture.md` (ADR-001) first; they are
normative. In particular:

- Packages: `packages/hardhat` (contracts, deploy, tests), `packages/nextjs`
  (developer console), `packages/sdk` (Hedera, oracle and Mirror Node adapters,
  network configuration).
- Single-source modules — import them, never write a second version:
  `validateHederaEnvironment` (environment), `packages/sdk/hedera/hcs`
  (evidence envelope and publisher), `packages/sdk/hedera/hts` (the only HTS
  caller), `packages/sdk/hedera/oracle` (oracle interface and mock),
  `packages/sdk/hedera/audit` (credential audit), `checkHederaHealth`
  (infrastructure health), `packages/sdk/hedera/networks.ts` (every chain id
  and RPC/Mirror/HashScan URL).
- Settlement guarantees: the idempotency key is `eventKey`, never a payload
  hash, signature or nonce; `externalEventId` is a pure function of the event's
  identifying fields; HCS is evidence, not validity; the attestation is
  published to HCS and its receipt captured before settlement; every HTS
  response code other than `SUCCESS` (22) reverts; no role may settle, mint or
  alter a processed record.
- Routes: `/` and `/dashboard` keep rendering, and `GET /api/env/status`
  keeps answering, without a `.env`.

## Feature to implement

Replace this section with the delta you want: the new route, contract,
policy, provider or adapter, its inputs and outputs, and the observable
behaviour that proves it works.

## Non-goals

- Do not switch the package manager away from Yarn or add a lockfile for
  another manager.
- Do not add a `.env`, a private key, a mnemonic or a real account credential
  to any file; secrets never use the `NEXT_PUBLIC_` prefix.
- Do not send Testnet or Mainnet transactions from tests; external integrations
  use an interface, a timeout, validation and a deterministic fixture.

## Acceptance (deterministic)

1. New contracts ship with unit tests, a deploy script and typed frontend
   artifacts; new SDK modules ship with tests.
2. Documentation for the feature is added or updated under `docs/`.
3. `yarn harness:validate` passes: the static invariants and secret scan in
   `.harness/`, then `yarn install --immutable`, `yarn lint`,
   `yarn check-types`, `yarn test` and `yarn build`.
