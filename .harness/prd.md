# Feature brief (edit the "Feature to implement" section)

## Goal

Extend this verifiable-certificates project with one feature, using
`hedera-harness run`. Do **not** rebuild the app, replace its architecture or
re-implement a module that already exists.

## Who it is for

Developers who scaffolded this template and add their own certificate use case
on top of it: another credential schema, another relying-party rule, a holder
wallet, a different document layout.

## Existing app (preserve)

Read `AGENTS.md` and `docs/architecture.md` first; they are normative. In
particular:

- Packages: `packages/hardhat` (`AccreditationRegistry` and its tests), `packages/sdk` (Credo agents, the Hedera Verifiable Data Registry,
  HCS-1 documents, issuer, presentations, Platform B, CLIs) and
  `packages/nextjs` (console, public certificate page, route handlers).
- Single-source modules — import them, never write a second version:
  `validateHederaEnvironment` (environment), `packages/sdk/certificates/agents.ts`
  (agents and the `HederaVdrRegistry` timestamp fix),
  `packages/sdk/certificates/hcs1.ts` (the HCS-1 codec),
  `packages/sdk/certificates/presentation.ts` (proof requests and verification),
  `packages/sdk/hedera/networks.ts` (every Mirror Node and HashScan URL),
  `packages/sdk/certificates/accreditation.ts` (the registry client),
  `packages/sdk/testing/hedera.ts` (the in-memory Hedera and registry for tests).
- Trust and privacy guarantees: validity is the AnonCreds credential checked
  against Hedera, never the PDF or the issuer's register; verifiers resolve
  schema, credential definition and revocation state from Hedera themselves;
  proof requests set `non_revoked` to a single point in time; the grade, the
  student id and the link secret never leave the holder's wallet; the PDF holds
  only data the holder accepts to make public.
- Routes: `/` and `/certificate/[id]` render, and the API routes under
  `/api` answer with typed errors.

## Feature to implement

Replace this section with the delta you want: the new schema attribute, proof
rule, route or adapter, its inputs and outputs, and the observable behaviour
that proves it works.

## Non-goals

- Do not switch the package manager away from Yarn or add a lockfile for
  another manager.
- Do not add a `.env`, a private key, a mnemonic or a real account credential
  to any file; secrets never use the `NEXT_PUBLIC_` prefix.
- Do not send Testnet or Mainnet transactions from tests; use the in-memory
  Hedera of `@sh/sdk/testing`.

## Acceptance (deterministic)

1. New SDK modules and routes ship with tests.
2. Documentation for the feature is added or updated under `docs/`.
3. `yarn harness:validate` passes: the static invariants and secret scan in
   `.harness/`, then `yarn install --immutable`, `yarn lint`,
   `yarn check-types`, `yarn test` and `yarn build`.
