# Testing strategy

One test matrix for the whole system (issue #13). Every implementation issue (#6, #9, #10, #11, #12, the public
verifier) adds its tests to the layers below and reuses the shared fixtures instead of inventing its own.

## Principles

- **Deterministic and offline.** `yarn test` needs no `.env`, credentials, testnet or internet. Throwaway keys and
  RFC 6979 signatures make every byte reproducible; clocks are injected (`now`, `sleep`, fake `Date`).
- **Real code, fake edges.** Only the network is replaced: Mirror Node REST, the JSON-RPC relay, HCS consensus and the
  EIP-1193 wallet. The SDK, the compiled contract, the single HCS parser and the audit run as in production.
- **One source of fixtures.** `@sh/sdk/testing` (below). A second fake Mirror Node, credential factory or identifier
  formula is a bug, for the same reason a second parser is (AGENTS.md).
- **Live tests are opt-in.** `*.integration.test.ts` files talk to the real Hedera Testnet and are skipped unless enabled
  (`HCS_INTEGRATION=1`, `AUDIT_INTEGRATION=1`, … with `yarn workspace @sh/sdk test:integration`). They are evidence for
  #18 (whose end-to-end run is `yarn verify:testnet`, [testnet-validation.md](testnet-validation.md)), never a CI requirement.

## The matrix

| Layer        | Tooling                         | Where                                                         | Covers                                                                                                                                                       |
| ------------ | ------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit         | Vitest                          | `packages/sdk/**/*.test.ts`                                   | environment validator, networks, HCS envelope/credential envelope/publisher/transport, oracle, HTS, Mirror client, audit, health, wallet helpers, CLIs       |
| Contract     | Hardhat + chai matchers         | `packages/hardhat/test/CredentialRegistry.test.ts`            | issuance, authenticity, re-issuance/conflict, structure, freshness, pause, revocation by issuer/stranger/relayer/admin, rotation, admin limits, ABI surface   |
| Integration  | Hardhat + `@sh/sdk/testing`     | `packages/hardhat/test/*.flow.test.ts`, `CredentialAudit.test.ts` | issuer → HCS → `CredentialRegistry` → verifier on the compiled contract (below); SDK identifiers and event ABI pinned to the contract                       |
| Frontend     | Vitest + jsdom + Testing Library | `packages/nextjs/app/**/*.test.tsx`, `app/api/**/route.test.ts` | dashboard page and every component, loading state, home page, `/api/env/status`, `/api/wallet/account`, error states, no secret rendered                    |

### Integration: the credential lifecycle

`packages/hardhat/test/CredentialLifecycle.flow.test.ts` runs the whole flow against the compiled `CredentialRegistry`
on the Hardhat network:

1. **Issuer** signs a `CredentialEvent`, validates it with `buildCredentialMessage` and publishes the validated message
   through the production `HcsTransport` port (an in-memory topic). The `HcsRef` comes only from the consensus receipt,
   and the contract is called only after it (ADR D11).
2. **Contract** records the issuance or revocation.
3. **Mirror Node** (fake) serves the topic messages and the **real** receipt logs at their block time; `statusOf` is
   relayed to the Hardhat node.
4. **Verifier** is `auditCredential` / `auditHcsMessage` (#10), exactly as the public verifier and issuer console use it.

Scenarios: issuance and revocation with consistent evidence; failed HCS publication never reaches the contract; a
published message by a stranger is never registered (HCS is evidence, not validity); Mirror lag reported as
`pending_index`, then `consistent`; an `HcsRef` pointing at different content is `inconsistent`; replays and
unauthorized revocations change nothing; admin revocation.

### Frontend

Components render reports produced by the **real** `checkHederaHealth` against the fake network
(`HEALTH_SCENARIOS`), so a change in the SDK's report shape breaks the dashboard tests too. The dashboard page and API
routes run end to end with `process.env` and `fetch` stubbed; the setup file blanks every `HEDERA_*` variable first, so
a developer's shell never leaks into a test. The wallet panel is driven by a scripted EIP-1193 provider (no wallet,
connect, rejection `4001`, pending `-32002`, wrong chain, unknown chain `4902`, account lookup states).

The issuer console (#12) and the public verifier add their tests here when they land, using the same fixtures.

## Shared fixtures: `@sh/sdk/testing`

Test-only (`packages/sdk/testing`); the package root does not export it and ESLint forbids importing it from runtime
SDK code.

| Module           | Provides                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `credentials.ts` | throwaway signers, `makeCredentialEvent`, `makeRevocation`, `signIssuance`/`signRevocation`, Mirror-shaped `issuedLog`/`revokedLog`, `consistentWorld` |
| `mirror.ts`      | `FakeWorld` + `fakeFetch` (topics/messages, contracts/results/logs, `eth_call`, indexing lag, forced HTTP failures, offline), `virtualClock`, `auditContext` |
| `hcs.ts`         | `createInMemoryTopic`: an `HcsTransport` that sequences messages, reports the transaction id first, can fail, and feeds the fake Mirror Node      |
| `network.ts`     | `fakeHederaNetwork` (Mirror + relay for `checkHederaHealth`), `healthEnv`, `healthReport`, `HEALTH_SCENARIOS`                                    |
| `testnet.ts`     | `fakeTestnet` + `testnetEnv`: a JSON-RPC relay backed by an in-memory `CredentialRegistry` (generated ABI; its checks, custom errors and events), signed transactions decoded and executed, wired to the in-memory topic, the fake Mirror Node and a virtual clock. Drives `yarn verify:testnet` end to end offline |

Settlement-side fixtures (`hedera/hcs/test-fixtures.ts`, `hedera/hts/test-fixtures.ts`, `hedera/oracle/test-fixtures.ts`)
stay next to their modules until the `SettlementRouter` flow needs them across packages; move them here then.

## Coverage targets

Enforced by `yarn coverage` (Vitest thresholds for the SDK and frontend, `scripts/check-coverage.mjs` for the
contracts). A drop below target fails the command; raise a target when coverage rises, never lower it to merge.

| Scope                                    | Lines | Statements | Functions | Branches | Measured (#13) |
| ---------------------------------------- | ----- | ---------- | --------- | -------- | --------------------------------- |
| Contracts (`CredentialRegistry`)         | 100%  | 100%       | 100%      | 95%      | 100 / 100 / 100 / 100             |
| SDK (`hedera/**`, `cli/**`)              | 90%   | 90%        | 90%       | 85%      | 94.7 / 94.7 / 94.0 / 89.0         |
| Frontend (`packages/nextjs/app/**`)      | 90%   | 90%        | 90%       | 85%      | 99.8 / 99.8 / 100 / 93.0          |

Security-relevant code (signature checks, replay/idempotency, access control, HTS response codes) is held to its
own bar regardless of the totals: every revert and every rejected input must have a named test.

## Commands

| Command                                   | Runs                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------- |
| `yarn test`                               | SDK, contract + integration, frontend (offline)                      |
| `yarn check`                              | lint + types + test (what CI runs)                                   |
| `yarn coverage`                           | the same suites with coverage, failing below the targets             |
| `yarn sdk:test` / `hardhat:test` / `next:test` | one package                                                     |
| `yarn workspace @sh/sdk test:integration` | opt-in live Testnet tests (need the variables each file documents)   |
| `yarn verify:testnet`                     | opt-in live end-to-end credential validation on Testnet; writes evidence ([testnet-validation.md](testnet-validation.md)) |

CI (#14) runs `yarn check` and `yarn coverage` with no secrets; the live tests stay manual.
