# Hedera Harness (#25)

**Decision: adopted, at the deterministic tiers (0–1) only.** This repository ships a Hedera Harness recipe in
[`.harness/`](../.harness/) — the *harness spec* (`.harness/spec.yaml`) and its *validators*
(`.harness/validators/static.json`, `.harness/validators/yarn.json`) — and runs them as part of its self-check. The
decision record is [ADR-003 in architecture.md](architecture.md#adr-003--hedera-harness-adopt-the-deterministic-tiers).

Bounty context ([bounty-rules.md](bounty-rules.md), GATE-20): the harness is "strongly recommended for this bounty and it
is not required", and "Harness spec and validators submitted, if the harness was used" is an eligibility item. Because
the recipe is used, the spec and validators above are the files to submit with the repository (CHK-20, CHK-24).

## What the harness is

[`hedera-harness`](https://github.com/hedera-dev/hedera-harness) (npm `hedera-harness`, MIT, pinned here as
`^1.2.2`) is a CLI that builds a feature into a scaffold-hbar project from a product brief: it drives a coding agent
(Cursor `agent` or Claude Code), then decides by itself whether the result passed, and asks the agent to repair on
failure. "The harness decides whether a run passed, not the agent." Validation is tiered:

| Tier | What it proves | Cost | This repository |
|---|---|---|---|
| 0–1 deterministic | files present, static assertions, no secrets, commands pass | seconds to minutes | **enabled** |
| 2 Playwright gate | the app boots and its routes render | a dev server boot + Playwright | not enabled |
| 3 acceptance contract | an adversarial agent grades the running app | an agent session | not enabled |
| 3.5 chain validation | an ephemeral funded Testnet account completes real transactions | Testnet HBAR | not enabled |

The deterministic tiers run without an agent through `hedera-harness validate`, which is what this repository uses.

## Why adopt it

1. **The validators encode this template's invariants, not generic ones.** They fail when an agent (or a person) breaks
   something the gate or `AGENTS.md` depends on, and each finding names the requirement that broke.
2. **They run in the generated project, not only here.** The CLI copies `.harness/` into every scaffolded project
   ([scaffold-compat.md](scaffold-compat.md) §1, step 5), so a developer who scaffolds this template can extend it with
   `npx hedera-harness run` and the same invariants guard the agent's work. `scripts/verify-scaffold.mjs` proves the
   recipe passes in a freshly generated project.
3. **It already found a real defect.** The first `yarn harness:validate` on a clean tree failed at `check-types`,
   because a generated artifact was missing on a fresh clone. The gate exists to catch exactly that.
4. **Cost is negligible.** One devDependency (its only runtime dependency is `yaml`); no agent, browser, credentials or
   HBAR needed for the tiers in use.

## What the validators check

`yarn harness:validate` runs, in order, and reports every finding at once:

| Validator | Checks | Requirement it protects |
|---|---|---|
| `spec.yaml` · `forbiddenFiles` / `secretScan.failOnFiles` | no `.env` at the root or in any workspace | GATE-19 |
| `spec.yaml` · `secretScan.patterns` | no hex/DER private key assigned to `*PRIVATE_KEY`/`*OPERATOR_KEY`; no `NEXT_PUBLIC_` variable named like a key, mnemonic or secret | GATE-19, `AGENTS.md` (secrets never use `NEXT_PUBLIC_`) |
| `static.json` · `jsonAssertions` | Yarn 3.2.3, `engines.node >=20.19.0`, MIT, the three workspaces and their `@sh/*` names, the `check`, `harness:validate`, `issuer:init` and `codegen` scripts | GATE-03, 07, 08; [scaffold-compat.md](scaffold-compat.md) naming contract |
| `static.json` · `fileAssertions` | `README.md`, `AGENTS.md`, `LICENSE`, `.env.example`, lockfile, pinned Yarn release, the registrar patch, the architecture document, the contract and its generated ABI, the single-source SDK modules (`networks.ts`, `environment.ts`, `certificates/agents.ts`, `hcs1.ts`, `issuer.ts`, `presentation.ts`, `platform.ts`, `accreditation.ts`, `testing/hedera.ts`); no `.data`, `packages/foundry`, `package-lock.json` or `pnpm-lock.yaml` | GATE-04, 10, 11; `AGENTS.md` single-source rules |
| `static.json` · `textAssertions` | README and `AGENTS.md` still document the commands and normative rules; `.gitignore` covers `.env`, `.data/` and harness runtime; `.env.example` keeps the Hedera keys | RUB-02, GATE-19 |
| `yarn.json` | `yarn install --immutable`, `yarn lint`, `yarn check-types`, `yarn test`, `yarn build` — one command per requirement | GATE-15, 16, 17 |

`template.json` is deliberately **not** asserted: the CLI deletes it in a generated project, and the recipe must pass
there too. Its validation stays in `node scripts/validate-template.mjs` (template repository only).

## How to run it

| Command | When | What it does |
|---|---|---|
| `yarn harness:doctor` | always; part of `yarn check` | Loads `.harness/spec.yaml` and fails on a schema error (`hedera-harness doctor --recipe-only`). Seconds, offline |
| `yarn harness:validate` | clean clone, CI, generated project, before submission | Full Tier 0–1 validation (table above). About a minute on a warm machine |
| `node scripts/verify-scaffold.mjs` | before a release | Scaffolds a project with the real CLI and runs `yarn harness:validate` inside it |

`yarn harness:validate` **fails when a `.env` exists**, on purpose: it validates the state a judge or a fresh scaffold
sees, and the harness keeps secrets out of the agent's workspace. Run it in a clean clone, or move `.env` aside first.
`yarn check` stays usable with a local `.env` because it only loads the recipe.

## Extending the template with an agent

```bash
$EDITOR .harness/prd.md     # replace "Feature to implement"; keep the invariants listed there
npx hedera-harness doctor   # needs an authenticated agent CLI (Cursor `agent` or `claude`)
npx hedera-harness run      # works on a harness/run-* branch; never pushes or merges
```

The PRD lists what must be preserved (single-source modules, the trust and privacy guarantees of architecture.md, the
routes). `run` requires a clean git tree and no `.env` in the workspace; it never reads `.env` and never writes
credentials. Run artifacts go to `.harness/runs/` (git-ignored).

## What is deliberately not enabled

- **Tier 2 (Playwright gate).** It needs the `playwright` package and a browser, and its check — the app boots and
  `/` and `GET /api/health` answer — is the self-check's job (GATE-18). Enabling it is one file
  (`validators.playwright`) if route checks move to the harness.
- **Tier 3 (acceptance contract).** It grades with an agent session: non-deterministic, needs agent credentials, and
  cannot run in CI. A template has no single feature to grade; the feature belongs to whoever writes the PRD.
- **Tier 3.5 (chain validation).** It injects an ephemeral ECDSA key as the browser burner wallet and spends Testnet
  HBAR. This template signs server-side with the operator (`validateHederaEnvironment`) and keeps keys out of the
  browser; the verifiable Testnet transaction and HashScan evidence come from the explicit Testnet validation (#18).

Revisit these when #14, #15 or #18 land; each is opt-in in `spec.yaml` and needs no change to the existing validators.

## Honesty note

The code in this repository was **not** generated by `hedera-harness run`. The harness is used as the validation recipe
of the template and as the agent-extension path for developers who scaffold it. That is the use the submission
declares.
