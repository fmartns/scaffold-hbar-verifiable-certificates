# External Integration

The oracle is required: a settlement cannot execute until validated external data produces a normalized attestation.

- **Trust model, attestation format and provider constraints:** [architecture.md](architecture.md) (ADR-001) — §3 trust model, §4.4 identity rules for `externalEventId`, §6.1 `SettlementEvent`, §6.9 adapter contract.
- **Provider selection is still pending** (issue #23). Whichever provider is chosen must supply a stable event id, an observation time, and authenticity verifiable on-chain (signed-fact mode or on-chain feed mode, ADR §6.9).
- The deterministic mock (issue #8) exists for tests and CI only and is labelled as such; it does not satisfy the real-oracle requirement.
- Contract, ABI and address propagation to the SDK/frontend (issue #24) will be documented here.

## Environment validation

`validateHederaEnvironment(env, options)` in `@sh/sdk` is the single place that decides whether the Hedera environment is usable. `yarn setup` runs it; the dashboard (#11) and the CI self-check (#14) must import it instead of re-implementing any of it.

It reads `HEDERA_NETWORK` (testnet by default; `testnet`, `mainnet` or `local`), `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY`, `HEDERA_MIN_BALANCE_HBAR` and the optional `HEDERA_RPC_URL` / `HEDERA_MIRROR_NODE_URL`, then checks the account on the Mirror Node: it exists, is not deleted, holds at least the minimum balance, and is controlled by the configured private key. Configuration problems are reported together and **no request is made while any exist**.

```ts
import { validateHederaEnvironment } from "@sh/sdk";

const result = await validateHederaEnvironment(process.env);
if (result.ok) {
  result.network; result.accountId; result.balance.hbar; result.hashscanUrl; // e.g. https://hashscan.io/testnet/account/0.0.1234
} else {
  result.status; // "invalid": fix the configuration · "unverified": the network was unreachable
  result.issues; // [{ code, category, variable, message, remediation, details }]
}
```

| Category | Codes | Meaning |
|---|---|---|
| `missing_env` | `MISSING_ENV` | A required variable is unset or blank (all reported at once) |
| `account` | `INVALID_ACCOUNT_ID`, `ACCOUNT_NOT_FOUND`, `ACCOUNT_DELETED` | Malformed ID (with hints for EVM addresses, pasted keys and checksums), unknown to the network, or deleted |
| `balance` | `INSUFFICIENT_BALANCE`, `INVALID_MIN_BALANCE` | Below the minimum (default **20 HBAR** testnet, **10** mainnet, **1** local) |
| `network` | `INVALID_NETWORK`, `INVALID_URL`, `NETWORK_MISMATCH` | Unsupported network, malformed endpoint, or an account, key, Mirror or relay endpoint that belongs to another network |
| `key` | `INVALID_OPERATOR_KEY`, `KEY_MISMATCH` | Not a private key, or not the key of that account |
| `connectivity` | `MIRROR_UNAVAILABLE`, `RPC_UNAVAILABLE` | The network did not answer. This is **not** a configuration error (`status: "unverified"`) |

Things worth knowing:

- **Account numbers overlap between networks.** The same `0.0.N` exists on testnet and mainnet as different accounts, so an account that merely exists proves nothing. The key comparison is what detects a wrong network; that is why the private key is required by default (`requireOperatorKey: false` is for read-only consumers).
- **Balances can exceed 2^53 tinybars** (the testnet treasury holds more than 3×10^18). The balance is read from the raw response and carried as `BigInt`/decimal strings, never as a JS number.
- **Nothing sensitive leaves the module.** No result contains a private key; URLs are reduced to their origin; the Hedera SDK's own errors are discarded because they echo the rejected input.
- The minimum balances are starting points, to be tuned when the real cost of the deployment flow is measured (#18).
- The deployer account (`DEPLOYER_PRIVATE_KEY_ENCRYPTED`) needs a password to decrypt, so it is not validated here.

## HCS evidence publisher

`createHcsPublisherFromEnv` / `createHcsPublisher` in `@sh/sdk` publish the settlement attestation to the configured HCS topic and return what is needed to persist and correlate it (transaction id, `HcsRef` claim, HashScan link, audit metadata). It builds on this validator: `preflightHcsPublisher` runs `validateHederaEnvironment` first, then checks the topic.

The envelope schema (v1), identifiers, error codes and retry policy are specified in [hcs-envelope.md](hcs-envelope.md). It is a stable interface: #10 reads messages with `decodeMessage`, #12 renders `PublishSuccess` and `HcsPublishFailure`, and the oracle (#8) signs with `SETTLEMENT_EVENT_TYPES`. None of them may define another format.

Configuration: `HEDERA_HCS_TOPIC_ID` and `HEDERA_SETTLEMENT_ROUTER_ADDRESS` (required), `HEDERA_HCS_PUBLISH_TIMEOUT_MS` (optional).

`yarn hcs:topic` creates the evidence topic (submitKey = operator key) and prints `HEDERA_HCS_TOPIC_ID`; see [hcs-envelope.md](hcs-envelope.md#create-the-topic-with-a-command).

## HTS settlement adapter

`createHtsAdapterFromEnv` / `createHtsSettlementAdapter` in `@sh/sdk` are the single integration layer with the Hedera Token Service: the settlement plan (mint-transfer or pool-transfer, per ADR-001 §6.7), preconditions checked on Mirror Node before anything is sent, token association, idempotency keyed by `eventKey` (coordinated with the router's `statusOf`), and structured HTS errors. `preflightHtsAdapter` runs the #5 validator first, then checks the token and the custody.

Production custody is the `SettlementRouter` (#9), which mints and transfers on-chain; off-chain execution (`HEDERA_HTS_CUSTODY=operator`) is for development and Testnet. Details, error codes and the idempotency rules: [hts-adapter.md](hts-adapter.md).

Configuration: `HEDERA_HTS_TOKEN_ID` (required), `HEDERA_HTS_SETTLEMENT_MODEL`, `HEDERA_HTS_CUSTODY`, `HEDERA_HTS_TREASURY_ID`.
