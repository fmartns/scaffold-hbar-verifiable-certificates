# Bounty submission package (#20)

Consolidated evidence for the Scaffold-HBAR Template Bounty submission, derived from
[bounty-rules.md](bounty-rules.md) Part C. Prepared on **2026-10-01** against commit
[`a49b8bb`](https://github.com/fmartns/scaffold-hbar-verifiable-settlement/commit/a49b8bb86809bb2e9a9c1463f6d660068cbd594c)
on `main`. **This is not a submission by itself** — it is the package to paste into the bounty's official submission
form, which only a human with access to that form/account can send (see [§5](#5-what-i-did-not-do)).

## 1. Gate (Part A) — all 20 items, verified against this commit

| ID | Requirement | Evidence |
|---|---|---|
| GATE-01 | Scaffolds via `npm create scaffold-hbar@latest --template owner/repo` | Real remote run, repo made public for this: [`node scripts/verify-scaffold.mjs --remote fmartns/scaffold-hbar-verifiable-settlement --cli latest`](scaffold-compat.md#7-validation-record), run #8 — 0 harness findings |
| GATE-02 | Public repository | `gh repo view --json visibility` → `PUBLIC`. <https://github.com/fmartns/scaffold-hbar-verifiable-settlement> |
| GATE-03 | MIT licence | `gh repo view --json licenseInfo` → `MIT License` (fixed 2026-10-01: the file was missing the second half of the standard disclaimer, so GitHub read it as "Other" until then — PR #64) |
| GATE-04 | Monorepo, separate `packages/` | `packages/hardhat`, `packages/nextjs`, `packages/sdk`, all with real content |
| GATE-05 | Next.js | `packages/nextjs` (App Router) |
| GATE-06 | Hardhat or Foundry | `packages/hardhat` |
| GATE-07 | npm or Yarn workspaces | Yarn Workspaces, `packageManager: yarn@3.2.3` |
| GATE-08 | Node ≥ 20.18.3 | `engines.node: ">=20.18.3"`; self-check passed on the current toolchain |
| GATE-09 | `template.json` present and valid | `node scripts/validate-template.mjs` → passes; validated against the real CLI's schema in #19 (local + remote runs) |
| GATE-10 | `README.md` | Present, with quickstart, architecture, env vars, commands, troubleshooting |
| GATE-11 | `AGENTS.md` | Present, project-specific, kept truthful against existing commands |
| GATE-12 | At least one real Hedera service in play | HCS (evidence topic) + a deployed Solidity contract (`CredentialRegistry`) + Mirror Node audit, all exercised for real in #18 |
| GATE-13 | A verifiable real Testnet transaction | 4 real transactions with `SUCCESS` (2 issuances, 2 revocations), see [§2](#2-testnet-evidence-gate-13-14) |
| GATE-14 | HashScan or Mirror Node link | Same — links below |
| GATE-15 | Clean install | `yarn install --immutable` → exit 0 (self-check) |
| GATE-16 | Clean lint | `yarn lint` → exit 0, no warnings (self-check) |
| GATE-17 | Clean build | `yarn build` → exit 0 (self-check) |
| GATE-18 | App boots, core routes return OK | `yarn serve` + `/`, `/dashboard`, `/api/env/status` → 200 (self-check); `/issuer`, `/verify` additionally covered by the Playwright E2E suite (#15) |
| GATE-19 | No committed secrets, no committed `.env` | `git ls-files \| grep -E '(^\|/)\.env($\|\.)'` → only `.env.example`; `yarn secrets:scan` → 0 findings over full history + working tree |
| GATE-20 | Harness spec + validators (used → required) | `.harness/spec.yaml`, `.harness/validators/{static,yarn}.json`, `.harness/prd.md` committed; `yarn harness:doctor` → ready; `yarn harness:validate` on a clean clone → `passed=true`, 0 findings (#25) |

Reproduce the whole gate in one command: **`node scripts/self-check.mjs`** → `All requirements passed.` (12/12).

## 2. Testnet evidence (GATE-13/14)

Real run against Hedera Testnet, not mock, via `yarn verify:testnet --yes` (#18). Full report:
[`docs/evidence/testnet/20261001T181216Z.md`](evidence/testnet/20261001T181216Z.md) /
[`.json`](evidence/testnet/20261001T181216Z.json).

- CredentialRegistry: [`0.0.10812888`](https://hashscan.io/testnet/contract/0.0.10812888)
- HCS evidence topic: [`0.0.10812882`](https://hashscan.io/testnet/topic/0.0.10812882)
- Run 1 — issuance: [HCS](https://hashscan.io/testnet/transaction/1790878342.550224803) ·
  [registry](https://hashscan.io/testnet/transaction/1790878343.849259443); revocation:
  [HCS](https://hashscan.io/testnet/transaction/1790878350.830367104) ·
  [registry](https://hashscan.io/testnet/transaction/1790878353.074479834)
- Run 2 — issuance: [HCS](https://hashscan.io/testnet/transaction/1790878359.727987346) ·
  [registry](https://hashscan.io/testnet/transaction/1790878362.710101104); revocation:
  [HCS](https://hashscan.io/testnet/transaction/1790878370.228018939) ·
  [registry](https://hashscan.io/testnet/transaction/1790878372.190174104)
- Both runs additionally proved replay protection on the real network: a repeated signed issuance refused
  (`AlreadyIssued`), a same-reference re-issue refused (`ConflictingCredential`), a second revoke refused
  (`AlreadyRevoked`) — nothing published or paid for any of the three.

## 3. Harness (GATE-20 / CHK-24)

Used at tiers 0–1 (#25, ADR-003). Submitted alongside the repo: `.harness/spec.yaml`, `.harness/validators/static.json`,
`.harness/validators/yarn.json`, `.harness/prd.md`. Rationale and coverage: [harness.md](harness.md).

## 4. Rubric self-assessment (Part B — not a gate, informs effort only)

| ID | Category | Weight | Honest self-read |
|---|---|---:|---|
| RUB-01 | Ecosystem Integration | 35 | **Weak, and worth your judgment call before submitting.** `bounty-rules.md` was written for the project's earlier "settlement" direction, where a third-party oracle was the load-bearing integration. After the pivot to Verifiable Credentials (#21) and the explicit decision in #26 **not** to add decentralized document storage, this project's integrations are all **native Hedera services** (HCS, Solidity, Mirror Node) — real depth, but not a third-party DEX/oracle/bridge/storage integration of the kind RUB-01's examples describe. I did not invent one to chase points: #26 was an explicit, reasoned decision against adding an integration without a real use-case need, and manufacturing one now would be exactly the "AI slop" RUB-03 penalizes. This is a scope decision only you can make — see [§6](#6-open-decision-for-you-rub-01).
| RUB-02 | Documentation Quality | 30 | Strong: README quickstart, `docs/quick-start.md`, `docs/hedera.md`, `docs/architecture.md` (ADR-001/002/003/004), `docs/security.md`, `docs/testing.md`, `docs/troubleshooting.md`, all kept in sync with real commands. |
| RUB-03 | Code Quality | 20 | Strong: 122 frontend + 918 SDK + 76 contract tests, typed end-to-end (generated ABIs, no hand-written addresses), `yarn check` clean, no dead scaffolding found during this submission pass. |
| RUB-04 | Hedera Service Depth | 15 | Strong: HCS (evidence) + Solidity (`CredentialRegistry`, authorization + replay protection) + Mirror Node (audit correlation), composed end-to-end and proven live on Testnet (§2), well beyond a single token transfer. |

## 5. What I did not do

- **Re-browse S1 (the official bounty page) to re-verify every `[OFICIAL]` quote in `bounty-rules.md`.** That page was last read via automated extraction on 2026-09-18 (`bounty-rules.md` §1.2 already flags this as needing a human re-read in a browser). I have no way to browse it myself — **please open it and confirm nothing changed** before submitting (dates, rubric wording, gate list).
- **The dev-ex survey.** `bounty-rules.md` records its link as unknown at the time of writing ("URL TBC"). Find it on the official bounty page and fill it in — I can't guess a submission-form URL.
- **Decide RUB-01.** See [§6](#6-open-decision-for-you-rub-01) below.
- **Send the submission.** That's through the bounty's own channel, tied to your registration/account.

## 6. Open decision for you: RUB-01

Three honest options, none of them acted on for you:

1. **Submit as-is.** The project's real strength is RUB-02/03/04 (30+20+15 = 65 of 100 well-covered); RUB-01 scores on its real merits as a native-Hedera-depth project, which is a legitimate, defensible position — "a single service used with real depth" is explicitly called out as valuable in RUB-04, and nothing requires every category to be maximized.
2. **Add a genuinely load-bearing third-party integration** (e.g. decentralized storage for a holder-held document, revisiting #26 with a real demand rather than a points grab) if you have time before 2026-10-04 and believe it reflects the project honestly.
3. **Reframe the narrative** in the README/submission text to make the case that composing HCS + Solidity + Mirror Node *is* the "capability a developer could not easily build alone" — a documentation change, not a code change — if you believe that's a fair reading of RUB-01's intent.

## 7. Checklist cross-reference

This package covers `bounty-rules.md` CHK-01 through CHK-20 (gate) and CHK-27–30 (rubric self-assessment). Still open,
blocking final submission per `bounty-rules.md` C.4:

- **CHK-00a/00b** — human re-browse of S1 (§5)
- **CHK-00e / CHK-23** — dev-ex survey link and registration confirmation (§5)
- **CHK-21** — freeze the submitted commit (tag or just record the SHA at send time)
- **CHK-25/26** — the actual send, before 2026-10-04 23:59 ET, with proof archived
