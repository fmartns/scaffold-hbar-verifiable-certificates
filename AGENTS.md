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
- External integrations use an interface, timeout, validation and deterministic test fixture.

## Commands
Available: `yarn doctor`, `yarn dev` (`yarn start` is the same dev server; `yarn serve` is production), `yarn build`, `yarn lint`, `yarn check-types`, `yarn test`, `yarn check` (lint + types + test; this is what CI runs), `yarn format`. Per-package scripts are `hardhat:*`, `next:*` and `sdk:*`.
Planned: `yarn setup`, `yarn test:integration`, `yarn test:e2e`, `yarn verify:testnet`.

Structure rules (see `docs/scaffold-compat.md`): workspaces are named `@sh/hardhat`, `@sh/nextjs`, `@sh/sdk` and the CLI depends on that naming. `@sh/sdk` is consumed as TypeScript source. Chain ids and RPC/Mirror/HashScan URLs live only in `packages/sdk/hedera/networks.ts`. One `.env` at the repository root; secrets never use the `NEXT_PUBLIC_` prefix. `.env.example` is generated from `template.json` (`envVars`) by the CLI; keep them equal (`node scripts/validate-template.mjs`). Run commands with the `--` form: `npm create scaffold-hbar@latest -- --template <owner>/<repo>`.

## Definition of Done
Tests, lint/typecheck/format, error handling, docs, no secrets, HashScan evidence for testnet changes.