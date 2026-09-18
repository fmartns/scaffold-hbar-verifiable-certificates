# Architecture Decision Record

## Decision
Use a Hedera-native event-driven settlement architecture: oracle adapter -> HCS attestation -> Solidity SettlementRouter -> HTS transfer/mint -> Mirror Node audit query.

## Trade-offs
A single hosted oracle is simpler but creates vendor lock-in. The SDK will define a provider interface and deterministic mock; initial implementation will select an ecosystem-supported provider after testnet compatibility research. HCS is the evidence log, not a substitute for contract state. HTS is used for the settled credit rather than a generic ERC-20.

## Base scaffold
Adopt conventions from Scaffold HBAR's Next.js + Hardhat monorepo and generated contract artifacts. Reuse official templates for HCS/HTS/oracle primitives; build only the orchestration and developer console.
