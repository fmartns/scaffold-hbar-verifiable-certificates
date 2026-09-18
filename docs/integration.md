# External Integration

The oracle is required: a settlement cannot execute until validated external data produces a normalized attestation.

- **Trust model, attestation format and provider constraints:** [architecture.md](architecture.md) (ADR-001) — §3 trust model, §4.4 identity rules for `externalEventId`, §6.1 `SettlementEvent`, §6.9 adapter contract.
- **Provider selection is still pending** (issue #23). Whichever provider is chosen must supply a stable event id, an observation time, and authenticity verifiable on-chain (signed-fact mode or on-chain feed mode, ADR §6.9).
- The deterministic mock (issue #8) exists for tests and CI only and is labelled as such; it does not satisfy the real-oracle requirement.
- Contract, ABI and address propagation to the SDK/frontend (issue #24) will be documented here.
