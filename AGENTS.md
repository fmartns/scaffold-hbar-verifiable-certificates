# Agent Guide

## Architecture
`packages/hardhat` owns Solidity/deploy/test; `packages/nextjs` is the developer console; `packages/sdk` owns Hedera, oracle and Mirror Node adapters. HCS records event attestations, Solidity decides settlement, HTS settles credits, Mirror Node audits.

## Rules
- Never commit secrets, private keys, mnemonics or real account credentials.
- Add contracts with unit tests, deployment and typed frontend artifacts.
- HCS publications must persist transaction ID and HashScan URL.
- HTS operations must be idempotent and validate token/account associations.
- Mirror Node reads are eventual-consistency aware.
- External integrations use an interface, timeout, validation and deterministic test fixture.

## Commands
Planned: `yarn setup`, `yarn check`, `yarn test`, `yarn test:integration`, `yarn test:e2e`, `yarn verify:testnet`.

## Definition of Done
Tests, lint/typecheck/format, error handling, docs, no secrets, HashScan evidence for testnet changes.