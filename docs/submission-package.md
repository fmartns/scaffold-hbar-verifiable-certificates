# Bounty submission package

Evidence for the Scaffold-HBAR Template Bounty submission, against the rules in [bounty-rules.md](bounty-rules.md).
Prepared on **2026-10-03** on branch `feat/anoncreds-certificates`. **This is not a submission by itself**: it is the
material for the official submission form, which only the registered participant can send.

## 1. Gate

| ID | Requirement | Evidence | Status |
|---|---|---|---|
| GATE-01 | Scaffolds via `npm create scaffold-hbar@latest -- --template owner/repo` | `node scripts/verify-scaffold.mjs` (published CLI, local export of a clean clone, 2026-10-03): 15/15 structural checks, `harness:validate` `passed=true`, 0 findings ([run 9](scaffold-compat.md#7-validation-record)); the `--remote` run needs the branch merged to `main` | pass (local) |
| GATE-02 | Public repository | <https://github.com/fmartns/scaffold-hbar-verifiable-settlement> | pass |
| GATE-03 | MIT licence | `LICENSE` (full MIT text) | pass |
| GATE-04 | Monorepo, separate `packages/` | `packages/hardhat` (AccreditationRegistry), `packages/nextjs`, `packages/sdk` | pass |
| GATE-05 | Next.js | `packages/nextjs` (App Router) | pass |
| GATE-06 | Hardhat or Foundry | `packages/hardhat` | pass |
| GATE-07 | npm or Yarn workspaces | Yarn Workspaces, `packageManager: yarn@3.2.3` | pass |
| GATE-08 | Node ≥ 20.18.3 | `engines.node: ">=20.19.0"` (Credo requires 20.19) | pass |
| GATE-09 | `template.json` present and valid | `node scripts/validate-template.mjs` | pass |
| GATE-10 / 11 | `README.md`, `AGENTS.md` | present; every `yarn <script>` they cite exists (self-check `docs`) | pass |
| GATE-12 | A real Hedera service | Consensus Service (DID, AnonCreds objects, revocation entries, HCS-1 PDFs) + Smart Contract Service (AccreditationRegistry) + Mirror Node reads | pass |
| GATE-13 / 14 | Verifiable Testnet transactions, HashScan links | §2 | pass |
| GATE-15 – 18 | install, lint, build, boot (`/`, `/api/health`) | `node scripts/self-check.mjs` on 2026-10-03: install, lint, types, tests, build, boot all PASS | pass |
| GATE-19 | No committed secrets or `.env` | only `.env.example` tracked; `.data/` git-ignored; `yarn secrets:scan` in CI (gitleaks) | see §6 |
| GATE-20 | Harness spec + validators | `.harness/spec.yaml`, `validators/{static,yarn}.json`, `prd.md`; `yarn harness:doctor` passes | pass |

## 2. Testnet evidence

All produced by this repository's own commands on 2026-10-03.

| Object | Link |
| --- | --- |
| Issuer `did:hedera` (DID document topic) | [0.0.10835831](https://hashscan.io/testnet/topic/0.0.10835831) |
| CourseCompletion schema (HCS-1) | [0.0.10835833](https://hashscan.io/testnet/topic/0.0.10835833) |
| Credential definition (HCS-1) | [0.0.10835834](https://hashscan.io/testnet/topic/0.0.10835834) |
| Revocation registry definition (HCS-1) | [0.0.10835837](https://hashscan.io/testnet/topic/0.0.10835837) |
| Revocation entries (state verifiers rebuild; includes two revocations) | [0.0.10835836](https://hashscan.io/testnet/topic/0.0.10835836) |
| AccreditationRegistry (`Solidity Basics` → the credential definition above) | [0.0.10837530](https://hashscan.io/testnet/contract/0.0.10837530) |
| Certificate PDFs (HCS-1, 5 chunks each, memo = SHA-256) | [0.0.10836026](https://hashscan.io/testnet/topic/0.0.10836026), [0.0.10837593](https://hashscan.io/testnet/topic/0.0.10837593) |
| Throwaway registry used to test `withdraw` and "as of" history | [0.0.10837541](https://hashscan.io/testnet/contract/0.0.10837541) |

Both API runs (production build, `yarn serve`): issue → ENROLLED revealing only `course` → Bob DENIED → PDF downloaded
from HCS-1 with an identical SHA-256 → tampered PDF MISMATCH → revoke → DENIED → "as of" before revocation ENROLLED →
document MATCH with credential REVOKED. The second run read the accreditation registry through the Mirror Node before
every decision.

## 3. Rubric self-assessment (informs effort only)

| ID | Category | Weight | Honest read |
|---|---|---:|---|
| RUB-01 | Ecosystem Integration | 35 | **Strongly defensible, not certain.** AnonCreds through Credo (OpenWallet Foundation) with `@credo-ts/hedera` and the Hiero DID SDK is the Hedera-native identity stack (HIP-762; the Hiero Heka platform uses it). Removing it removes holder binding, predicates, selective disclosure and non-revocation proofs: the whole demo. Risk: the bounty's examples are DeFi, oracles, bridges and storage, so a judge may not count an identity framework. The template also fixes two real upstream defects (millisecond status-list timestamps that broke every non-revocation proof; a DID awaiter that times out when the clock lags consensus), which is worth reporting upstream. |
| RUB-02 | Documentation Quality | 30 | Strong: README, quick start with real output, architecture with a load-bearing table and decisions, every Hedera object mapped with measured costs, threat model, troubleshooting built from errors actually hit, demo script. |
| RUB-03 | Code Quality | 20 | Strong: one `certificates/` module, typed errors, 84 SDK + 6 contract + 17 app tests, offline in-memory Hedera that runs the real Credo/Hiero code, no legacy left after the pivot. |
| RUB-04 | Hedera Service Depth | 15 | Strong: HCS in five distinct roles (DID state, HCS-1 objects, revocation entries replayed at a consensus timestamp, submit keys as write control, document storage) + a contract on the Smart Contract Service, all read through the Mirror Node. |

## 4. Demo

[demo.md](demo.md): a three-minute script.

## 5. What a human must do

- Re-read the official bounty page to confirm nothing changed (dates, rubric, gate).
- Merge the branch to `main` (the CLI scaffolds from `main`) and run
  `node scripts/verify-scaffold.mjs --remote fmartns/scaffold-hbar-verifiable-settlement --cli latest`.
- Record the final commit SHA and send the submission through the official form before 2026-10-04 23:59 ET.
- Optionally open issues/PRs upstream for the two Hiero defects (architecture.md D6).

## 6. Pending results

- GATE-01: the `--remote` fresh-scaffold run, after the merge to `main`.
- GATE-19: gitleaks is not installed on the machine used for this pivot; the scan runs in CI on push.
