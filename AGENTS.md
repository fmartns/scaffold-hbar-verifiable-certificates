# Agent Guide

## Architecture
`packages/hardhat` owns Solidity/deploy/test; `packages/nextjs` is the developer console; `packages/sdk` owns Hedera, oracle and Mirror Node adapters. HCS records event attestations, Solidity decides settlement, HTS settles credits, Mirror Node audits.

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
Planned: `yarn setup`, `yarn check`, `yarn test`, `yarn test:integration`, `yarn test:e2e`, `yarn verify:testnet`.

## Definition of Done
Tests, lint/typecheck/format, error handling, docs, no secrets, HashScan evidence for testnet changes.