# Scaffold-HBAR compatibility contract

How this repository behaves as a `create-scaffold-hbar` template, what the CLI actually does with it, and which structural rules every later task must keep. Delivered by issue **#4**; consumed by **#14** (self-check/CI) and **#19** (fresh-scaffold validation).

| Field | Value |
|---|---|
| Validated on | **2026-09-18** |
| Against | `create-scaffold-hbar@0.4.0` (npm `latest`; source `hedera-dev/create-scaffold-hbar@5732f5e`, published 2026-09-04) |
| Base conventions | `hedera-dev/scaffold-hbar@5eb46ef` (`main`, `templates/blank-template`) |
| Status | Structure and contract validated locally. **The GitHub download step was not exercised** — see [§8](#8-what-is-not-verified-yet) |
| **Revalidate** | **Before the final submission (#20), as part of #19.** The CLI changes often (0.1.0 → 0.4.0 in five months) — [§9](#9-revalidation-checklist-for-19) |

**Dependencies.** The layout (`packages/hardhat`, `packages/nextjs`, `packages/sdk`) is the same for every direction under discussion in **#21** (RWA, AI agent, settlement): each needs contracts, a frontend and a shared SDK. Nothing in the structure encodes the settlement policy. Conclusions from **#2** ([dx-benchmark.md](dx-benchmark.md), REQ-04-*) are applied where marked.

Evidence in this document was obtained by **running the published CLI** and reading its source (`src/main.ts`, `src/tasks/*`, `src/types.ts`, `src/utils/*` at `5732f5e`), not from documentation alone. Where they disagree, the CLI's behavior wins and the disagreement is recorded in [§5](#5-divergences-between-documentation-cli-and-requests).

---

## 1. How the CLI consumes a template

Order of operations of `create-scaffold-hbar@0.4.0`, in the order they happen:

| # | Step | Behavior | Consequence for the template |
|---|---|---|---|
| 1 | Argument parsing | `commander`; `-t/--template` accepts `owner/repo[#ref]` | See [§2](#2-invocation-what-npm-really-passes) for how npm delivers the flag |
| 2 | System check | Node **≥ 20.18.3**; `git` with `user.name` **and** `user.email`; `yarn` (≥ 1.0.0) or `npm` (≥ 8) on `PATH` | Missing Git identity aborts before anything is created |
| 3 | Capability resolution | Reads `template.json` from **`https://api.github.com/repos/<owner>/<repo>/contents/template.json?ref=<ref>`** (anonymous, 10 s timeout). On **any** failure it silently falls back to permissive defaults | **The repository must be public and the manifest pushed to the ref**, or the prompts/defaults are wrong ([§4](#4-implicit-requirements)) |
| 4 | Download | `giget` downloads `gh:<owner>/<repo>#<ref>` (ref defaults to `main`) into a temp dir | Only **committed** files exist in the download |
| 5 | Copy | Skips `.git`, `node_modules`, `.next`, `.env`, `.yarn/cache` | `.yarn/releases` **is** copied |
| 6 | Prune | Removes `packages/foundry` when Hardhat is chosen (and `packages/hardhat` when Foundry is chosen, or both for `none`); removes `packages/nextjs` when frontend is `none` | Package directories named `hardhat`, `foundry` and `nextjs` carry meaning for the CLI |
| 7 | Root `package.json` filter | Filters `workspaces` (array or `{ packages }`) and root scripts: drops `hardhat:*`/`foundry:*` scripts of the unselected framework, strips `&& yarn <unselected>:…` segments | Root scripts follow the `<framework>:<script>` naming |
| 8 | npm rewrite | Only when npm is chosen: rewrites `yarn` → `npm` in scripts of `hardhat` and `nextjs` **only**, removes `.yarn*`/husky, rewrites text files | **Not applied to other workspaces** (e.g. `sdk`). This template is therefore **Yarn-only** |
| 9 | Manifest processing | `TemplateManifestSchema.parse` (**throws on an invalid manifest**), applies `rename`, writes `.env.example` from `envVars` (**overwriting any existing file**), then **deletes `template.json`** | A scaffolded project has **no** `template.json`; `.env.example` is regenerated |
| 10 | `git init -b main` | Inside the project | — |
| 11 | Install | `yarn install` (`npm install --legacy-peer-deps` for npm) | Must succeed with the committed lockfile |
| 12 | Hedera Skills | `npx skills add hedera-dev/hedera-skills --all` — **on by default with `--yes`/`--ci`** | Extra network step; opt out with `--skip-hedera-skills` |
| 13 | Format | Runs root `yarn format`; a failure is only a warning | A root `format` script must exist |
| 14 | First commit | `git add -A && git commit --no-verify --no-gpg-sign` | Husky hooks do not run on the first commit |

## 2. Invocation: what npm really passes

The bounty page and the task text give the command as `npm create scaffold-hbar@latest --template <owner>/<repo>`. Tested with **npm 11.16.0** (2026-09-18), logging what the CLI process receives:

| Command | `argv` seen by the CLI | Result |
|---|---|---|
| `npm create scaffold-hbar@latest --template fmartns/x` | `["fmartns/x"]`, with `npm_config_template=true` | ❌ **npm consumes `--template` as its own config**; `fmartns/x` arrives as the **project name**. The CLI does not read `npm_config_template`, so the template menu is shown instead |
| `npm create scaffold-hbar@latest -- --template fmartns/x` | `["--template", "fmartns/x"]` | ✅ |
| `npx create-scaffold-hbar@latest --template fmartns/x` | `["--template", "fmartns/x"]` | ✅ |

**Consequence.** Every command written in this repository uses the `--` form (or `npx`). The literal form of the bounty page cannot work with current npm regardless of the template. This affects the eligibility check (GATE-01) and is recorded as an ambiguity in [bounty-rules.md](bounty-rules.md) (D-02).

## 3. The manifest (`template.json`)

Schema of `TemplateManifestSchema` in `src/types.ts@5732f5e` (Zod, non-strict: **unknown keys are silently ignored**). "Consumed" is verified by reading every use in the source.

| Field | Required | Type / accepted values | Consumed by the CLI | This template |
|---|:-:|---|:-:|---|
| `name` | **yes** | non-empty string | validated only | `verifiable-settlement` |
| `description` | no | string | no | set |
| `version` | no | string | no | omitted |
| `create-scaffold-hbar` | no | object (legacy key `create-hbar` is normalized to it) | yes | set |
| ↳ `capabilities.frontend` | no | array of `nextjs-app` \| `none` | prompts, flag validation | `["nextjs-app"]` |
| ↳ `capabilities.solidityFramework` | no | array of `hardhat` \| `foundry` \| `none` | prompts, flag validation | `["hardhat"]` |
| ↳ `capabilities.packageManager` | no | array of `yarn` \| `npm` \| `none` (**not** `pnpm`) | prompts, flag validation | `["yarn"]` |
| ↳ `defaults.frontend` / `.solidityFramework` / `.packageManager` | no | same enums | only when a capability has **several** options and `--yes` is set, or as the prompt's initial value | set; **inert today** (single option each), kept so that widening a capability keeps a defined default |
| ↳ `envVars[]` | no | `{ key: string (min 1), description: string }` | yes → generates `.env.example` (`# description`, `KEY=`, blank line), overwriting | 8 variables |
| ↳ `outro` | no | must define at least one of `sections`, `steps`, `installCommand` | yes → final terminal message | `sections` |
| ↳ `outro.sections[]` | — | `{ title?, steps[] (min 1) }`; each step needs at least one of `label`, `command`, `url`, `text` (non-empty strings) | yes | one "Next steps" section |
| ↳ `outro.steps` | — | array of strings | **deprecated** legacy form | not used |
| ↳ `outro.installCommand` | — | non-empty string | yes (`--skip-install` hint) | not used |
| ↳ `rename` | no | `{ [placeholder]: { to: string, paths: string[] (min 1) } }`; `to` supports `{{projectName}}` | yes, **directories only** (a file path in `paths` is skipped) | not used |
| ↳ `requirements` | no | `{ [tool]: semver range }` | ❌ **accepted, never read** | **removed** |
| ↳ `instructions` | no | array of strings | ❌ **accepted, never read** | **removed** |

Outro placeholders: `{run:script}` → the package manager's command (`yarn script`); `{run:framework:script}` → `{run:hardhat:script}`; `{pm}` → package manager name. A placeholder pointing to a root script that does not exist is printed anyway — it is not checked by the CLI, so `scripts/validate-template.mjs` checks it.

Fields kept only because an older version of the file had them: **none.** The previous `template.json` had no `name`, so **it crashed the real CLI** (reproduced, [§7](#7-validation-record), experiment 1).

## 4. Implicit requirements

Behaviors that are not evident from the repository layout and that the template must satisfy.

| ID | Requirement | Evidence |
|---|---|---|
| **IR-1** | `template.json` **must have `name`.** An invalid manifest crashes step 9 with a `ZodError` stack trace and exit code 1 — **after** the project directory was created | Experiment 1 |
| **IR-2** | The repository must be **public** and `template.json` must exist on the **ref** being scaffolded (default `main`). Otherwise step 3 fails silently, capabilities become permissive, and `--yes` selects **Foundry** as the Solidity default — this template has none and the CLI even demands `forge` | Experiment 2; `template-capabilities.ts` |
| **IR-3** | Everything the project needs must be **committed**: the download is a tarball of the ref. Includes `yarn.lock` and `.yarn/releases/yarn-3.2.3.cjs` | `copy-template-files.ts` |
| **IR-4** | The pinned Yarn release (`.yarnrc.yml` → `yarnPath`) is part of the template. It makes any Yarn ≥ 1.22 on `PATH` delegate to the pinned version (verified with Yarn 1.22.22 reporting `3.2.3`) and works without Corepack | Experiment "classic Yarn" |
| **IR-5** | Workspace names must be `@sh/<name>` (`\w+`, no hyphen). The CLI's script rewriting matches `yarn workspace @sh/\w+` | `transformScriptForPackageManager` |
| **IR-6** | Package directories `hardhat`, `foundry` and `nextjs` are pruned by name. Do not add a package whose path contains `foundry` or, when Foundry is selected, `hardhat` | `filterRootPackageJson` |
| **IR-7** | A root **`format`** script must exist (step 13) and root scripts named in `outro` must exist (not checked by the CLI) | `prettier-format.ts` |
| **IR-8** | `.env.example` is **regenerated** from `envVars` and overwrites the committed one. The committed file must equal the generated one | `generate-env-example.ts` |
| **IR-9** | `template.json` **does not exist in the generated project.** Any script or doc that reads it must tolerate its absence | `processTemplateManifest` |
| **IR-10** | The user needs Git identity (`user.name`, `user.email`) configured, or the CLI stops at the system check | `system-validation.ts` |
| **IR-11** | Yarn-only: for npm the CLI normalizes `hardhat` and `nextjs` package scripts but not `sdk`; the manifest therefore offers `yarn` only | `normalizeWorkspacePackagesForNpm` |
| **IR-12** | The Hedera Skills install is **on by default with `--yes`**; it is separate from this template and needs the network | `main.ts`, `install-hedera-skills.ts` |

## 5. Divergences between documentation, CLI and requests

Behavior of the current CLI takes precedence; each divergence is recorded, not resolved by assumption.

| ID | Documentation / request says | CLI / experiment shows | Applied |
|---|---|---|---|
| **DV-1** | Hedera docs describe the manifest as **optional** and show `"packageManager": ["pnpm", "yarn"]` | `name` is **required** (crash without it); `pnpm` is **not** an accepted value | `name` set; `yarn` only |
| **DV-2** | Schema comments describe `requirements` (e.g. `node`) and `instructions` as features | Neither is read anywhere | Removed; Node ≥ 20.18.3 is enforced by the CLI itself (step 2) and by `engines` |
| **DV-3** | Bounty page and the task: `npm create scaffold-hbar@latest --template <owner>/<repo>` | npm consumes `--template` ([§2](#2-invocation-what-npm-really-passes)) | `--` form everywhere; open ambiguity in [bounty-rules.md](bounty-rules.md) D-02 |
| **DV-4** | The third-party template guide lists only `packages/*`, `.gitignore`, `README.md` and does not mention `template.json` or `AGENTS.md` | The CLI reads `template.json` at the root; `AGENTS.md` is a bounty requirement, not a CLI one | Both present |
| **DV-5** | The guide recommends forking `buidler-labs/scaffold-hbar`; the maintained repository is `hedera-dev/scaffold-hbar` | The CLI constant `TEMPLATE_REPO` still points to `buidler-labs/scaffold-hbar` for **built-in** templates | Irrelevant to community templates; noted |
| **DV-6** | dx-benchmark REQ-04-01 proposed `requirements: { node: ">=20.18.3" }` | Never read (DV-2) | Requirement corrected in [dx-benchmark.md](dx-benchmark.md) |

## 6. Structure contract for later tasks

### 6.1 Layout

```
.
├── package.json          workspaces, engines, packageManager, root scripts (contract, §6.2)
├── .yarnrc.yml           nodeLinker: node-modules, nmHoistingLimits: workspaces, yarnPath
├── .yarn/releases/       pinned Yarn 3.2.3 (committed)
├── yarn.lock             committed
├── template.json         CLI manifest (removed by the CLI in generated projects)
├── .env.example          == generated from template.json envVars
├── packages/
│   ├── hardhat/          @sh/hardhat   contracts/ deploy/ scripts/ test/ + hardhat.config.ts
│   ├── nextjs/           @sh/nextjs    app/ components/ config/ hooks/ services/
│   └── sdk/              @sh/sdk       hedera/ integrations/ generated/ + index.ts
└── scripts/              doctor.mjs · validate-template.mjs · verify-scaffold.mjs
                          (packages/sdk/cli/setup.ts is the `yarn setup` entry point)
```

- **One `.env` at the repository root** feeds every workspace (`hardhat.config.ts` loads it with `dotenv`; `next.config.ts` with `@next/env`). Only `NEXT_PUBLIC_*` variables reach the browser; secrets must never use that prefix.
- **`@sh/sdk` is consumed as TypeScript source** (`main`/`types` → `index.ts`; the Next.js app uses `transpilePackages`; Hardhat loads it through `ts-node`). It has no build output, so no workspace depends on a build order and a fresh clone type-checks without building anything.
- **`packages/sdk/hedera/networks.ts` is the only place** where chain ids and RPC/Mirror/HashScan URLs live (REQ-04-02). Hardhat and Next.js import it; a URL literal anywhere else is a defect.
- **No default deployer key.** `hardhat.config.ts` only gives live networks an account when `__RUNTIME_DEPLOYER_PRIVATE_KEY` is injected at run time; otherwise a deploy fails instead of using a well-known key (REQ-04-03).
- **Hardhat network is not forked by default.** Forking emulates HTS only and is opt-in (REQ-04-06).

### 6.2 Root scripts (stable contracts)

Every root script exits non-zero on failure and chains with `&&`, so a failing step stops the run.

| Script | Behavior today | Contract for later tasks |
|---|---|---|
| `dev` | Next.js dev server | Stays the dev entry point. May start more processes later, never fewer |
| `start` | Next.js dev server (**base convention: `start` = `next dev`**) | Must boot from a clean clone without a prior build. Production server is `serve` |
| `serve` | `next start` (needs `build`) | Production server |
| `build` | `sdk:build` → `hardhat:compile` → `next:build` | Order is sdk → contracts → app; extend, do not reorder |
| `lint` | eslint on `sdk`, `hardhat`, `nextjs` with `--max-warnings=0` | Warnings fail |
| `check-types` | `tsc --noEmit` on the three packages | — |
| `test` | `sdk:test` (Vitest) → `hardhat:test` | `test:integration` / `test:e2e` (#13, #15) get their own scripts |
| `check` | `lint` → `check-types` → `test` | **The script #14 runs.** Must not need network or secrets |
| `format` | prettier on the three packages | Required by the CLI (IR-7); already-formatted files produce no diff |
| `doctor` | Checks Node ≥ `engines.node`, Yarn, `.env` presence. Prints to stderr | — |
| `setup` | `doctor`, then validates network, account and balance through `validateHederaEnvironment` (#5). Exit 0 valid, 1 invalid, 2 network unreachable; `--json` prints the result on stdout | Every step that needs Hedera runs **after** the validation and only when it passes (deployment #9, HCS topic #6, HTS token #7) |
| `<pkg>:<script>` | `hardhat:*`, `next:*`, `sdk:*` mirror the base scaffold naming | The CLI's outro/prune logic relies on this naming |

Not implemented on purpose (absent, so calling them fails with "Couldn't find a script"): `deploy`, `verify:testnet` (#9/#18), `test:integration` (#13), `test:e2e` (#15).

### 6.3 Deliberate differences from the base scaffold

| Difference | Reason |
|---|---|
| No `packages/foundry` | The project is Hardhat-only (capability `["hardhat"]`) |
| No forking plugin, no fallback deployer key, no burner/faucet UI | REQ-04-06, REQ-04-03 |
| `eslint . --max-warnings=0` instead of `next lint` | `next lint` is deprecated in Next 15.5; flat config works for every package |
| Vitest for the SDK | `node --test` does not expand globs on Node 20 — found by running on Node 20.18.3 |
| No wagmi/RainbowKit/`scaffold-hbar-ui`/Tailwind yet | Added by #11, #12, #24 when used; adding them now would be unused dependencies |
| No Yarn plugins committed | Not needed; fewer committed artifacts |

## 7. Validation record

Every run used the **published** CLI (`create-scaffold-hbar@0.4.0` via `npx`) in a clean temporary directory, with `--yes --skip-hedera-skills -f nextjs-app -s hardhat --package-manager yarn`. Local runs use the CLI's own `CREATE_SCAFFOLD_HBAR_TEMPLATE_DIR` seam (it copies a directory instead of downloading with giget), fed with exactly the files git would publish (`git ls-files -co --exclude-standard`). Reproduce with `node scripts/verify-scaffold.mjs`.

| # | Scenario | Result |
|---|---|---|
| 1 | Node 24.18.0 + Yarn via Corepack | ✅ scaffold, install (by the CLI), format, first commit; then `lint`, `check-types`, `test`, `build` in the generated project. Generated tree identical to the template except the removed `template.json` |
| 2 | **Node 20.18.3** (bounty floor) + Corepack | ✅ same steps. *This run found a real defect* (`node --test` globs on Node 20) — fixed before this record |
| 3 | Node 24 + **Yarn 1.22.22** on `PATH` (no Corepack) | ✅ `yarn --version` inside the project reports `3.2.3` (delegated through `yarnPath`) |
| 4 | `yarn install --immutable` on a clean checkout | ✅ lockfile is in sync |
| 5 | Root `check`, `build`, dev server (`yarn start` → `GET /` 200 showing testnet/296, unknown route 404) | ✅ |
| E1 | **Original** `template.json` (initial commit) through the real CLI | ❌ crashes with `ZodError: Required` at `processTemplateManifest`, exit 1 → **IR-1** |
| E2 | Fixed manifest, but the GitHub manifest lookup returns 404 (repo private/unpushed), `--yes` without `-s` | ❌ the CLI selects Foundry and demands `forge` → **IR-2** |
| N1 | npm 11.16.0 argv logging | `--template` without `--` is consumed by npm → **DV-3** |

Known benign output: Yarn 3.2.3 prints `YN0066 typescript … Cannot apply hunk #1` with TypeScript 5.x (its built-in compat patch is older than TS 5). It is a warning, install exits 0, and the base scaffold has the same.

## 8. What is not verified yet

- **The GitHub download step (`giget`) and the manifest lookup (step 3).** The repository is private and nothing is pushed, so the literal flow
  `npm create scaffold-hbar@latest -- --template fmartns/scaffold-hbar-verifiable-settlement`
  could not be run. It requires: everything committed and pushed to the target ref, the repository **public** (also required by the bounty gate, GATE-02), and the manifest reachable anonymously. When that is in place run:

  ```bash
  node scripts/verify-scaffold.mjs --remote fmartns/scaffold-hbar-verifiable-settlement
  ```

  Whether `giget` can fetch a private repository with a token (`GIGET_AUTH`) was not tested; step 3 would still be anonymous and fail.
- Windows and macOS. Only Linux (WSL2) was used.
- The interactive path (prompts). Only the flag-driven path was run.
- `npm` as package manager: unsupported by design (IR-11).

## 9. Revalidation checklist for #19

The CLI is updated frequently; this contract is valid for `0.4.0`. Before the final submission, in this order:

1. `npm view create-scaffold-hbar version` and compare with `0.4.0`. If newer, read the diff of `src/types.ts`, `src/tasks/copy-template-files.ts` and `src/utils/template-capabilities.ts` against `5732f5e`.
2. Update the pinned checks in `scripts/validate-template.mjs` if the schema changed; run it.
3. Push, make the repository public, then run `node scripts/verify-scaffold.mjs --remote fmartns/scaffold-hbar-verifiable-settlement --cli latest` on **Node 20.18.3** and on the current Node LTS.
4. Run the literal `npm create scaffold-hbar@latest -- --template fmartns/scaffold-hbar-verifiable-settlement` interactively once (prompts must not offer Foundry or npm).
5. Re-test the form without `--` and update DV-3/D-02 if npm or the CLI changed how the flag is delivered.
6. Update the date and CLI version at the top of this file and in [bounty-rules.md](bounty-rules.md)'s revalidation log.
