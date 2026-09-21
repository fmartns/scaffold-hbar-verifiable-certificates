# HTS settlement adapter

Status: **implemented in issue #7**, consumed by #9 (`SettlementRouter`), #10 (Mirror audit), #12 (console) and #13/#14 (tests, self-check).
Normative source: [ADR-001](architecture.md) §6.7 (HTS obligations), D5/D9/D12, §4 (identity, idempotency), §5.5 (recovery invariant), §6.4–§6.5 (router interface and `HtsFailed`).
Code: [`packages/sdk/hedera/hts/`](../packages/sdk/hedera/hts/), re-exported from `@sh/sdk`. It is the **only** place in the project that talks to the Hedera Token Service; do not call HTS from anywhere else.

The settled asset is a **Hedera Token Service token** (a native HTS fungible token), not a generic ERC-20.

## 1. What runs where (read this first)

ADR-001 puts the credit **on-chain**: the `SettlementRouter` is the token treasury and holds the supply key, and `settle` does *mint → transfer* through the HTS system contract (`0x167`), atomically with the "processed" mark (D5, D9). The router is the **single enforcement point** for replay protection, and no off-chain role can settle, mint or alter a record (D12).

A contract cannot call TypeScript, so this adapter is not "called by the router". It is the router's **off-chain counterpart**:

| Piece | Who | What the adapter provides |
|---|---|---|
| Mint and transfer of the credit, replay protection, `HtsFailed(op, code)` | `SettlementRouter` (#9), on-chain | `planOperations` and `expectedEffects`: the specification the router and the audit are checked against (parity) |
| Checks before `settle` (ADR §5.2 step 6) | Relayer, off-chain | `preflight`, `checkSetup`, `preflightHtsAdapter` |
| Account-side step the router cannot do (a third-party account must authorize its own association) | The account owner, off-chain | `associate` |
| Reading what happened | Relayer, console, audit | `decodeHtsFailed`, `interpretHtsResponseCode`, error normalization, result metadata |
| Executing the operations itself | **Operator custody only (development / Testnet)** | `settle` |

**Custody** (`HEDERA_HTS_CUSTODY`):

- `router` (default, ADR v1, production): the router mints and transfers on-chain. This process has no supply key, so `settle` **refuses** to execute (`CONFIG_INVALID`) and the adapter is preflight-only.
- `operator` (development and Testnet only): the operator account is treasury and supply key, so the adapter can execute mint/transfer itself. It contradicts the production trust model (an off-chain key that can mint), so it is **refused on mainnet**. It exists to validate the real HTS operations on Testnet before #9 exists and to serve as the executable reference of the strategy.

Token creation for router custody happens in the contract (the base scaffold's `HtsTokenCreator` pattern gives the router the supply key), so it is part of #9's deployment, not of this adapter.

## 2. The settlement strategy (ADR §6.7)

Not every settlement is *mint + transfer*. The model is configuration (`HEDERA_HTS_SETTLEMENT_MODEL`):

| Model | Operations, in order | Effects on the ledger |
|---|---|---|
| `mint-transfer` (**ADR v1**, default) | 1. `mint(amount)` to the treasury 2. `transfer(amount)` treasury → beneficiary | supply `+amount`; beneficiary `+amount`; the treasury nets zero |
| `pool-transfer` (documented alternative) | 1. `transfer(amount)` from the pre-funded treasury → beneficiary | supply unchanged; beneficiary `+amount`; treasury `-amount` |
| any model, `amount == 0` | none: a valid **no-op** that still consumes the key (ADR §4.9) | none |

`planOperations(model, …)` returns the ordered operations and `expectedEffects(model, …)` the net effects as decimal strings. #9 must produce exactly these, and #10 compares child records against them (`HTS_MISMATCH`). Audit invariant (ADR §6.7): `totalSupply(token) = Σ amount` of the settlements (plus the initial supply).

`amount` is in the token's smallest unit and must fit **int64** (`INT64_MAX = 2^63-1`, ADR `MAX_AMOUNT`); larger or negative values are rejected before anything is sent. Balances above 2^53 are read exactly (from the raw JSON) and carried as `bigint`.

Allowances are **not** used by either model, so none is checked. A failing allowance status is still classified (`INSUFFICIENT_ALLOWANCE`) so a flow that adopts allowances never surfaces a generic error.

## 3. Provision a development token: `yarn hts:token`

Before `yarn hts:settle` can do anything, a token must exist. This command creates one for `HEDERA_HTS_CUSTODY=operator`
(development/Testnet): the operator is treasury, and — for the `mint-transfer` model — supply key. In production the
`SettlementRouter` (#9) is deployed with its own token, treasury and supply key (ADR §6.7); this command never creates
that token, and is not meant to run against mainnet without `--allow-mainnet`.

```bash
yarn hts:token                          # shows the plan and cost, asks [y/N], then creates a mint-transfer token
yarn hts:token --write                  # also sets HEDERA_HTS_TOKEN_ID (and the model, for pool-transfer) in .env
yarn hts:token --model pool-transfer    # no supply key; starts with an initial supply (1,000,000 by default) as a pool
```

Options: `--name "<text>"`, `--symbol "<text>"`, `--decimals <n>` (0–18), `--initial-supply <n>`, `--with-supply-key`
(force one even for `pool-transfer`), `--no-supply-key` (refuse for `mint-transfer`: that token could never be minted, so
it needs `--initial-supply`), `--with-admin-key`, `--yes`/`-y`, `--allow-mainnet`, `--json`. Like `yarn hts:token` never
creates a second topic-equivalent: if `HEDERA_HTS_TOKEN_ID` is already set to a usable token (treasury and, for
mint-transfer, supply key = operator), it reports that and creates nothing.

Measured on Testnet: creating a token (treasury + supply key) costs about US$ 1 (matching Hedera's published fee); the
estimate and the real charge are shown the same way as `yarn hts:token`'s other costs.

## 4. Try it for real: `yarn hts:settle`

A manual testing CLI, not part of the production flow: it lets you associate, check or run one real settlement from the
terminal, against the same adapter #9 will use. `transfer` only sends anything under `HEDERA_HTS_CUSTODY=operator`
(development/Testnet); under `router` custody it reports the same `CONFIG_INVALID` that points to `SettlementRouter.settle`,
without spending anything. `preflight` and `associate` work regardless of custody.

```bash
yarn hts:settle preflight --to 0.0.x --amount 100                # checks, sends nothing
yarn hts:settle associate --to 0.0.x [--account-key <hex>]       # associates the account with the token
yarn hts:settle transfer  --to 0.0.x --amount 100                # shows the plan and cost, asks [y/N], then runs it
```

Options: `--token 0.0.x` (overrides `HEDERA_HTS_TOKEN_ID` for this call), `--yes`/`-y` (skip the question; required without a
terminal), `--allow-mainnet`, `--json`. `--account-key <hex>` supplies the private key of a beneficiary that is not the
operator, so `associate` can sign on its behalf (never printed; used only to sign that transaction).

**Identity of a manual settlement.** Pass `--label "<text>"`: the same label (with the same token, beneficiary and amount)
always derives the same `eventKey`/`settlementId`/`contentHash`, so running the command again on purpose tests
idempotency (`already_settled`, nothing sent or charged); a different label is a different settlement; the same label with
a different amount is a `CONFLICTING_SETTLEMENT`. Without `--label`, a fresh one is generated and printed so you can reuse
it. These identifiers are a **convenience for this CLI only** (`manualSettlementIdentifiers`), not the ADR's identity
computation — a real settlement's identity always comes from the oracle event via `settlementInputFromEnvelope`
(`hedera/hcs/envelope.ts`).

Before sending anything, it shows what will happen and the estimated cost (measured on Testnet: association ≈ $0.05,
mint ≈ $0.02, transfer ≈ $0.0002; see `hedera/hts/cost.ts`) and asks; after, it shows the transaction ids, HashScan links
and the fee actually charged, read back from Mirror Node.

## 5. Public interface

```ts
import { createHtsAdapterFromEnv, preflightHtsAdapter, settlementInputFromEnvelope } from "@sh/sdk";

// Startup: the environment validator (#5), the HTS configuration, then the token and the custody on Mirror Node.
const setup = await preflightHtsAdapter(process.env);          // { ok: true, setup } | { ok: false, error: HtsFailure }

const { adapter, close } = await createHtsAdapterFromEnv(process.env, { ledger });  // throws HtsError CONFIG_INVALID

// Same identifiers as the envelope the router will settle (#6), plus the policy's outcome (#9):
const input = settlementInputFromEnvelope(envelope, { tokenId, beneficiary, amount });

const check = await adapter.preflight(input);                  // sends nothing
const assoc = await adapter.associate({ accountId });          // idempotent; needs the account's own key
const result = await adapter.settle(input);                    // operator custody only; never throws for HTS problems
```

Configuration (nothing hardcoded; the operator key is read only to create the client):

| Variable | Required | Meaning |
|---|---|---|
| `HEDERA_HTS_TOKEN_ID` | yes | The HTS token of the settled asset |
| `HEDERA_HTS_SETTLEMENT_MODEL` | no | `mint-transfer` (default) or `pool-transfer` |
| `HEDERA_HTS_CUSTODY` | no | `router` (default) or `operator` (dev/Testnet) |
| `HEDERA_SETTLEMENT_ROUTER_ADDRESS` | router custody | Router EVM address. Also used, when set, to read `statusOf` (the authority) |
| `HEDERA_HTS_TREASURY_ID` | no | Treasury for operator custody; defaults to the operator |
| `HEDERA_NETWORK`, `HEDERA_OPERATOR_ID`, `HEDERA_OPERATOR_KEY` | operator custody / associate | As in [integration.md](integration.md#environment-validation) |

Everything is pure or takes injected dependencies (Mirror client, executor, ledger, status reader, clock): no `console`, CLI, prompts or storage. Links come from `hedera/explorer.ts` and the network table of #5 (`networks.ts`), the same code the HCS publisher uses.

## 6. Preconditions (checked before anything is sent)

`preflight` and `settle` run these against Mirror Node. A failed check sends nothing (`outcome: "not_sent"`). They are a preventive convenience, **never the enforcement**: Mirror lags, and the HTS response codes remain the final word.

| Check | Fails with | Notes |
|---|---|---|
| `token-exists` | `TOKEN_NOT_FOUND` | Token ids are per network: usually a wrong id or network |
| `token-usable` | `TOKEN_INVALID` / `TOKEN_PAUSED` | Must be `FUNGIBLE_COMMON`, not deleted, not paused |
| `custody-treasury` | `CONFIG_INVALID` | The token's treasury must be the router contract (router custody: resolved from the router address) or the configured treasury. Also fails if no contract exists at the router address |
| `mint-permission` (mint model) | `NO_MINT_PERMISSION` | Router: the supply key must be a contract-id key equal to the router. Operator: must be the operator key. No supply key at all also fails. A complex key that cannot be confirmed is a warning |
| `supply-headroom` (finite supply) | `SUPPLY_EXCEEDED` | Says how much can still be minted |
| `beneficiary-exists` | `ACCOUNT_NOT_FOUND` | Account id or EVM address (resolved through Mirror); the beneficiary cannot be the treasury (`INVALID_SETTLEMENT`) |
| `beneficiary-associated` | `NOT_ASSOCIATED` / `ACCOUNT_FROZEN` / `KYC_NOT_GRANTED` | An account with automatic associations enabled is a **warning** (`auto_association_possible`): the transfer can associate it |
| `pool-balance` (pool model) | `INSUFFICIENT_BALANCE` | The treasury must hold at least `amount` |

Mirror Node encodes contract keys as `ProtobufEncoded`. Observed on Testnet: token `0.0.10589073` has the admin key `42051890a78605`, i.e. a *delegatable contract id* key for contract `0.0.10589072`. Both `contractID` (field 1) and `delegatableContractId` (field 8) keys are accepted.

## 7. Idempotency, coordinated with ADR-001 and the router

**One rule:** the router is the authority; the adapter is a second line of defense and protection against off-chain retries. The adapter holds no state itself (ADR §6.7); the caller may supply persistence.

**Which identifier.** The idempotency key is **`eventKey`** = `keccak256(abi.encode(EVENT_KEY_TAG, eventSource, externalEventId))` (ADR D4): permanent, independent of timing and of the deployment. `settlementId` (bound to chain and router) travels with it for correlation, and `contentHash` detects different facts for the same key.

**How it arrives.** From the same envelope the router settles: `settlementInputFromEnvelope(envelope, outcome)` copies `eventKey`, `settlementId` and `contentHash` from `envelope.derived`, computed by the shared envelope code (#6). The adapter and the router therefore cannot disagree about which settlement it is.

**How a repeat is detected**, in this order:

1. **The router's `statusOf(eventKey)`** (authority, ADR §5.5), when configured (`createRouterStatusReader`, JSON-RPC `eth_call`).
2. **The caller's ledger** (`IdempotencyLedger`, optional): `get`, an atomic `begin`, `save`.
3. **The settlement memo on Mirror Node.** Every operation carries the memo `hvs:1:<eventKey>:<mint|transfer>`; the adapter scans the treasury's recent transactions for it. This works without any ledger, within Mirror's indexing lag.

**What is returned when it was already done:** `status: "already_settled"`, `replay: true`, `source: "router" | "ledger" | "network"`, and the earlier operations (transaction ids, timestamps, links). **Nothing is sent.**

**Legitimate retry versus duplicate:**

| Situation | Behaviour |
|---|---|
| Same key, same `contentHash`, already complete | Returns the previous result. Nothing sent (`replay: true`) |
| Same key, **different** `contentHash` | `CONFLICTING_SETTLEMENT`. Never executed (equivocation or an oracle bug; audit `HCS_EQUIVOCATION`) |
| Refused by a precondition (`not_sent`) or rejected by the network (`rejected`) | A **legitimate retry** once the cause is fixed: it executes |
| Mint applied, transfer failed (`partial`) | The retry **resumes**: it sends only the transfer. The mint is found in the ledger or by its memo and is never repeated |
| Outcome unknown (timeout after a transaction id exists) | **Not resent.** `SETTLEMENT_IN_PROGRESS` until the transaction is seen on Mirror Node (then it completes) or has certainly expired (a transaction is valid for at most 180 s; the adapter waits 4 minutes) |
| Another attempt is running (fresh claim) | `SETTLEMENT_IN_PROGRESS`. A claim older than 4 minutes is treated as a crashed process |
| The same settlement twice at once in one process | One execution |

The step is written to the ledger as `sent` **before** the transaction is sent, so a crash mid-send leaves a trace.

**What to persist or return for correlation.** Every result carries `idempotencyKey`, `settlementId`, `contentHash`, `tokenId`, `from`, `to`, `amount`, the `operations` (`mint`/`transfer` with `transactionId`, `mirrorTransactionId`, `consensusTimestamp`, `hashscanUrl`), and the last `transactionId`/`hashscanUrl`. Results are JSON-safe: store them as they are, keyed by `idempotencyKey`. The `LedgerRecord` (state, per-step transaction ids and timestamps) is the durable form.

**Limits.** Without a ledger, protection against a retry *within Mirror's indexing lag* (seconds) relies on the caller not retrying concurrently; provide a ledger for that (`createInMemoryLedger` exists for tests and development and is **not durable**). The router remains the only guarantee against double settlement on-chain.

## 8. Errors

Branch on `failure.code` and `failure.outcome`, never on message text or Hedera SDK classes. Messages name the problem and the action, and never contain keys or the raw text of SDK errors. Every failure carries `idempotencyKey`/`settlementId`/`tokenId`/`accountId` when known.

| `code` | Cause | Typical action |
|---|---|---|
| `NOT_ASSOCIATED` | `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT` | The account owner associates the token, then submit again |
| `TOKEN_NOT_FOUND` | `INVALID_TOKEN_ID`, or a token id from another network | Check `HEDERA_HTS_TOKEN_ID` and the network |
| `TOKEN_INVALID` / `TOKEN_PAUSED` | Deleted, immutable, not fungible / paused | Create a new token / unpause |
| `INSUFFICIENT_BALANCE` | `INSUFFICIENT_TOKEN_BALANCE` (pool) | Fund the pool, or use mint-transfer |
| `INSUFFICIENT_ALLOWANCE` | Allowance statuses (flows that use allowances) | Approve a larger allowance |
| `NO_MINT_PERMISSION` | No supply key, or the custodian does not hold it | Create the token with the router (or operator in dev) as supply key |
| `SUPPLY_EXCEEDED` | `TOKEN_MAX_SUPPLY_REACHED` | Reduce the amount or raise the cap |
| `ACCOUNT_FROZEN` / `KYC_NOT_GRANTED` | Freeze/KYC on the beneficiary | Unfreeze / grant KYC |
| `ACCOUNT_NOT_FOUND` | Beneficiary missing or deleted | Check the id and network |
| `AMOUNT_OUT_OF_RANGE`, `INVALID_SETTLEMENT` | Input validation (`issues` lists the fields) | Fix the input |
| `CONFIG_INVALID` | Environment or custody misconfigured (`configIssues`), router not deployed, executing under router custody | Fix the variable named |
| `ASSOCIATION_NOT_AUTHORIZED` | The account's own key is not held here | The owner associates from its wallet |
| `CONFLICTING_SETTLEMENT` | Same key, different content | Do not execute; investigate |
| `SETTLEMENT_IN_PROGRESS` | An earlier attempt is unresolved | Wait and call again; do not resend |
| `NETWORK_UNAVAILABLE` / `TIMEOUT` | Network, Mirror or router unreachable / deadline | Retry per policy; after `unknown`, reconcile |
| `TRANSACTION_FAILED` / `UNEXPECTED_RESPONSE` | Another Hedera status (`hederaStatus`) / unclassifiable | See the status |

`outcome` says what is known about the ledger: `not_sent` (nothing left), `rejected` (refused or failed at consensus; that operation applied nothing), `unknown` (may or may not have been applied: reconcile, do not resend blindly), `partial` (an earlier operation was applied and a later one was not; `appliedTransactions` lists what was; `code` still names the cause; resume, do not restart). The service never retries by itself.

`decodeHtsFailed(revertData)` turns the router's `HtsFailed(uint8 op, int64 responseCode)` revert (ADR §6.5; op 1 mint, 2 transfer) into the same structured failure; `interpretHtsResponseCode(code, ctx)` does it for a numeric code. The numeric table is pinned by a test to the Hedera SDK's own.

## 9. Contract for #9

- `settle` must revert `HtsFailed(op, code)` for any HTS response code ≠ 22 (op 1 mint, 2 transfer), so relayers and the console can decode it with `decodeHtsFailed`.
- It must produce exactly the effects of `expectedEffects` for the configured model (supply, beneficiary, treasury).
- It must expose `statusOf(bytes32) returns (bool settled, bytes32 contentHash, uint64 settledAt)`; the adapter reads it as the authority.
- The router is treasury and holds the supply key as a **contract-id key** (or delegatable contract id); `preflight` verifies it.
- The router-executed HTS transactions carry no settlement memo (they are child records of the `settle` call): they are correlated through `SettlementExecuted` and the parent record (#10). The memo reconciliation applies to operator custody.

## 10. Tests

| Suite | Command | Network |
|---|---|---|
| Unit: input, plan, errors, config, cost, Mirror, preflight, executor, router status, adapter (incl. every idempotency scenario), factory, token/topic-style provisioning, `yarn hts:token` and `yarn hts:settle` CLIs | `yarn test` | none: an in-memory world (Mirror view and executor share state, so operations really change balances, supply and memos) |
| Integration | `HTS_INTEGRATION=1 yarn workspace @sh/sdk test:integration` | Hedera Testnet |

The integration test uses `HEDERA_OPERATOR_ID`/`KEY` from the environment or the root `.env`, and `HEDERA_HTS_TOKEN_ID` if you provide one (it must have the operator as treasury and supply key; it is never deleted). Without it, it creates a throwaway token (operator custody) and a fresh beneficiary account **without** automatic association, and deletes both at the end. It then: validates the setup with the #5 validator; classifies **real** errors (not associated, token not found, insufficient balance); checks that the preflight refuses a non-associated beneficiary without sending; associates it with its own key (twice: the second is a no-op); settles (mint then transfer), checks the transaction ids, the HashScan links and the resulting balance and supply on Mirror Node; finds the settlement memo on the real Mirror Node and shows that a repeat without a ledger sends nothing; and that a repeat with the ledger, and a conflicting `contentHash`, are handled. It prints the HashScan links so you can inspect them. Creating the token and account costs some Testnet HBAR (no monetary value).

## 11. Open items

- **[NV] Router custody on a real router.** The contract-key check is validated against the encoding observed on Testnet but has not run against a real `SettlementRouter` (#9).
- **Off-chain mint → transfer is not atomic** (two transactions), unlike the router's. That is why `partial` and resume exist; operator custody is for development.
- **Automatic association.** A beneficiary with automatic associations enabled is accepted with a warning; if its slots are exhausted the network answers `TOKENS_PER_ACCOUNT_LIMIT_EXCEEDED`, which surfaces as `TRANSACTION_FAILED` with that status.
