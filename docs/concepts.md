# Concepts

Canonical terms for the settlement flow. Definitions and rules are normative in [architecture.md](architecture.md) (ADR-001); this page is only an index.

| Term | Meaning | ADR |
|---|---|---|
| Fact / oracle attestation | What the oracle observes and signs. Never an outcome. | [§3.1](architecture.md#31-roles-and-responsibilities), [§6.1](architecture.md#61-settlementevent-and-signing) |
| Settlement intent / `SettlementEvent` | The typed, signed record of a fact | [§6.1](architecture.md#61-settlementevent-and-signing) |
| HCS event envelope | `0x01 ‖ abi.encode(SettlementEvent) ‖ signature`, published before settlement | [§6.3](architecture.md#63-hcs-message-format) |
| Settlement policy | On-chain `view` component mapping facts to an outcome, bounded by caps | [§6.6](architecture.md#66-settlement-policy-interface) |
| HTS credit | The token amount minted/transferred by the router; atomic with the processed mark | [§6.7](architecture.md#67-hts-execution-obligations-7) |
| Idempotency key (`eventKey`) | `keccak256(abi.encode(EVENT_KEY_TAG, eventSource, externalEventId))`, stored permanently | [§4.3](architecture.md#43-how-the-identifiers-are-built) |
| `settlementId`, `contentHash`, `attestationDigest` | Chain-bound settlement id · conflict detector · signed digest | [§4.3](architecture.md#43-how-the-identifiers-are-built) |
| Mirror Node audit record / finding | Result of correlating HCS, contract logs and HTS records | [§6.8](architecture.md#68-mirror-node-audit-contract-10) |
| HashScan evidence | Explorer link for a Transaction ID or EVM hash of each step | [dx-benchmark.md](dx-benchmark.md) (REQ-11-03, REQ-12-02) |
