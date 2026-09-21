# Agent Guide

## Architecture
`packages/hardhat` owns Solidity/deploy/test; `packages/nextjs` is the developer console; `packages/sdk` owns Hedera, oracle and Mirror Node adapters and the network configuration. HCS records event attestations, Solidity decides settlement, HTS settles credits, Mirror Node audits.

## Rules
- Never commit secrets, private keys, mnemonics or real account credentials.
- Add contracts with unit tests, deployment and typed frontend artifacts.
- HCS publications must persist transaction ID and HashScan URL.
- HTS operations must be idempotent and validate token/account associations.
- Mirror Node reads are eventual-consistency aware.
- Settlement identity, idempotency and replay rules are normative in `docs/architecture.md` (ADR-001). Never use a payload hash, a signature or a nonce as the idempotency key: it is `eventKey` (ADR §4.3).
- `externalEventId` must be a pure, deterministic function of the event's identifying fields only (ADR §4.4, R1–R6). Never hash JSON.
- HCS is evidence, not validity. The contract cannot read HCS; never present `HcsRef` as verified on-chain.
- Publish to HCS and capture the consensus receipt **before** releasing an attestation for settlement (ADR D11).
- Every HTS response code must be checked (`SUCCESS = 22`); any other value reverts the whole settlement.
- No role may settle, mint or alter a processed record (ADR D12).
- Hedera environment validation has one source: `validateHederaEnvironment` in `@sh/sdk`. The dashboard, CI and scripts import it; never re-implement it. It must never put a private key, or a URL beyond its origin, in a message, log or result.
- HCS evidence has one implementation: `packages/sdk/hedera/hcs` (envelope, identifiers, encode/decode, publisher). #10, #12 and the oracle import it; never write a second parser, JSON variant or identifier formula. The message is `0x01 || abi.encode(SettlementEvent) || signature` ([docs/hcs-envelope.md](docs/hcs-envelope.md)). The publisher never retries by itself: retries after an `unknown` outcome are the caller's policy.
- The oracle has one interface: `packages/sdk/hedera/oracle` (`OracleProvider`/`EventNormalizer`/`Attestor`, composed by `createOracleAdapter`). The mock (`createMockOracleAdapter`) is for tests, CI and local dev only — deterministic, no credentials, always labelled `mock` in `eventSource`. Real oracle integration for production/demo is issue #23; selecting it is by `ORACLE_PROVIDER` configuration, never a conditional in consumer code. See [docs/oracle-adapter.md](docs/oracle-adapter.md).
- HTS has one integration layer: `packages/sdk/hedera/hts` (settlement plan, preconditions, association, errors, idempotency). Nothing else calls the Hedera Token Service. The settled asset is an HTS token, never a generic ERC-20. Production custody is the `SettlementRouter` (it mints and transfers on-chain and is the single enforcement point of replay protection); the adapter is its off-chain counterpart, and off-chain execution (`HEDERA_HTS_CUSTODY=operator`) is for development and Testnet only, refused on mainnet. The idempotency key is `eventKey`. See [docs/hts-adapter.md](docs/hts-adapter.md).
- External integrations use an interface, timeout, validation and deterministic test fixture.

## Commands
Available: `yarn doctor`, `yarn setup` (validates network, account and balance; exit 0 valid, 1 invalid, 2 network unreachable; `--json` for machines), `yarn hcs:topic` (creates the HCS evidence topic once: shows the plan and cost and asks before paying; `--yes` skips the question; never a second topic over a usable configured one; refuses mainnet without `--allow-mainnet`; `--smoke-test` publishes and reads back one message), `yarn hts:token` (creates a development settlement token: operator as treasury/supply key; never a second one over a usable configured token; refuses mainnet without `--allow-mainnet`), `yarn hts:settle <preflight|associate|transfer>` (manual HTS testing: shows the plan and cost and asks before sending; `transfer` only executes under operator custody; refuses mainnet without `--allow-mainnet`), `yarn dev` (`yarn start` is the same dev server; `yarn serve` is production), `yarn build`, `yarn lint`, `yarn check-types`, `yarn test`, `yarn check` (lint + types + test; this is what CI runs), `yarn format`. Per-package scripts are `hardhat:*`, `next:*` and `sdk:*`.
Planned: `yarn test:integration`, `yarn test:e2e`, `yarn verify:testnet`.

Structure rules (see `docs/scaffold-compat.md`): workspaces are named `@sh/hardhat`, `@sh/nextjs`, `@sh/sdk` and the CLI depends on that naming. `@sh/sdk` is consumed as TypeScript source. Chain ids and RPC/Mirror/HashScan URLs live only in `packages/sdk/hedera/networks.ts`. One `.env` at the repository root; secrets never use the `NEXT_PUBLIC_` prefix. `.env.example` is generated from `template.json` (`envVars`) by the CLI; keep them equal (`node scripts/validate-template.mjs`). Run commands with the `--` form: `npm create scaffold-hbar@latest -- --template <owner>/<repo>`.

## Definition of Done
Tests, lint/typecheck/format, error handling, docs, no secrets, HashScan evidence for testnet changes.