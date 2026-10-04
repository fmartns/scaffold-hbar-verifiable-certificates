# Bounty submission package

Evidence for the Scaffold-HBAR Template Bounty submission, against the rules in [bounty-rules.md](bounty-rules.md).
Prepared on **2026-10-03**; revalidated the same day against `main` (`6db7fc6`) and the final working tree. **This is not a submission by itself**: it is the
material for the official submission form, which only the registered participant can send.

## 1. Gate

| ID | Requirement | Evidence | Status |
|---|---|---|---|
| GATE-01 | Scaffolds via `npm create scaffold-hbar@latest -- --template owner/repo` | Real GitHub download of `main` with the published CLI (0.4.1), `npm create scaffold-hbar@latest certs-app -- --template fmartns/scaffold-hbar-verifiable-certificates --yes` (run under the repository's previous name, which GitHub redirects) on Windows 11 / Node 24.19: scaffold, install, Hedera Skills, format and first commit succeed; then every self-check requirement passes in the generated project ([run 10](scaffold-compat.md#7-validation-record)) | pass |
| GATE-02 | Public repository | <https://github.com/fmartns/scaffold-hbar-verifiable-certificates> | pass |
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
| GATE-15 – 18 | install, lint, build, boot (`/`, `/api/health`) | inside the generated project (run 10): `install --immutable`, lint, types, tests, build, boot all PASS; `/`, `/api/health` 200; API routes without a `.env` answer typed 400s; unknown route 404; the public `/certificate/<id>` page explains a missing configuration instead of a 500 (fixed and re-run: [run 11](scaffold-compat.md#7-validation-record), with `harness:validate` `passed=true`) | pass |
| GATE-19 | No committed secrets or `.env` | only `.env.example` tracked; `.data/` git-ignored; gitleaks 8.30.1 (checksum-verified) over all 148 commits on every ref + the working tree: 0 findings; no `.env`, wallet or `.data` path in any commit | pass |
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

Transaction-level links (all `SUCCESS`, payer `0.0.9327439`), checked on the Mirror Node and HashScan on 2026-10-03:

| Transaction | HashScan | Mirror Node |
| --- | --- | --- |
| `ConsensusCreateTopic` (issuer DID) | [1790996836.245900104](https://hashscan.io/testnet/transaction/1790996836.245900104) | [0.0.9327439-1790996829-444905325](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.9327439-1790996829-444905325) |
| `ConsensusCreateTopic` (certificate PDF, HCS-1) | [1790997758.417264894](https://hashscan.io/testnet/transaction/1790997758.417264894) | [0.0.9327439-1790997751-345835606](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.9327439-1790997751-345835606) |
| `ConsensusSubmitMessage` (revocation entry) | [1790997781.896472394](https://hashscan.io/testnet/transaction/1790997781.896472394) | [0.0.9327439-1790997774-512140330](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.9327439-1790997774-512140330) |
| `ContractCreate` (AccreditationRegistry) | [1791005637.187703104](https://hashscan.io/testnet/transaction/1791005637.187703104) | [0.0.9327439-1791005629-433832773](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.9327439-1791005629-433832773) |
| `ContractCall` `accredit("Solidity Basics", …/PUBLIC_CRED_DEF/0.0.10835834)` | [1791005639.291434104](https://hashscan.io/testnet/transaction/1791005639.291434104) | [0.0.9327439-1791005629-009818278](https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.9327439-1791005629-009818278) |

For the submission form's single "HashScan or mirror node link", use the `ContractCall` above (it shows the Hedera
service, the contract and the accredited credential definition in one transaction) or the revocation entries topic.

Both API runs (production build, `yarn serve`): issue → ENROLLED revealing only `course` → Bob DENIED → PDF downloaded
from HCS-1 with an identical SHA-256 → tampered PDF MISMATCH → revoke → DENIED → "as of" before revocation ENROLLED →
document MATCH with credential REVOKED. The second run read the accreditation registry through the Mirror Node before
every decision.

## 3. Rubric self-assessment (informs effort only)

| ID | Category | Weight | Honest read |
|---|---|---:|---|
| RUB-01 | Ecosystem Integration | 35 | **Strongly defensible, not certain.** AnonCreds through Credo (OpenWallet Foundation) with `@credo-ts/hedera` and the Hiero DID SDK is the Hedera-native identity stack (HIP-762; the Hiero Heka platform uses it). Removing it removes holder binding, predicates, selective disclosure and non-revocation proofs: the whole demo. Risk: the bounty's examples are DeFi, oracles, bridges and storage, so a judge may not count an identity framework. The template also fixes two real upstream defects (millisecond status-list timestamps that broke every non-revocation proof; a DID awaiter that times out when the clock lags consensus), which is worth reporting upstream. |
| RUB-02 | Documentation Quality | 30 | Strong: README, quick start with real output, architecture with a load-bearing table and decisions, every Hedera object mapped with measured costs, threat model, troubleshooting built from errors actually hit, demo script. |
| RUB-03 | Code Quality | 20 | Strong: one `certificates/` module, typed errors, 84 SDK + 6 contract + 21 app tests, offline in-memory Hedera that runs the real Credo/Hiero code, no legacy left after the pivot. |
| RUB-04 | Hedera Service Depth | 15 | Strong: HCS in five distinct roles (DID state, HCS-1 objects, revocation entries replayed at a consensus timestamp, submit keys as write control, document storage) + a contract on the Smart Contract Service, all read through the Mirror Node. |

## 4. Demo

[demo.md](demo.md): a three-minute script.

## 5. What a human must do

- Re-read the official bounty page to confirm nothing changed (dates, rubric, gate).
- Review and commit the final changes, push to `main` (the CLI scaffolds from `main`), and let CI pass.
- Optionally re-run `node scripts/verify-scaffold.mjs --remote fmartns/scaffold-hbar-verifiable-certificates --cli latest`
  after the push.
- Record the final commit SHA and send the submission through the official form before 2026-10-04 23:59 ET, with the
  repository link, one HashScan/Mirror Node link from §2, the dev-ex survey, and `.harness/spec.yaml` +
  `.harness/validators/{static,yarn}.json`.
- Optionally open issues/PRs upstream for the two Hiero defects (architecture.md D6).
