# Testing strategy

## Principles

- **Offline and credential-free.** `yarn test` needs no `.env`, account or network.
- **Real code, fake transport.** `InMemoryHedera` (`packages/sdk/testing/hedera.ts`) replaces only the HCS transport of
  the Hiero SDK (`HederaHcsService`: topics, ordered messages, consensus timestamps, the `toDate` filter the Mirror Node
  applies) and the Mirror Node REST endpoints used for HCS-1. Credo, anoncreds-rs, Askar, the Hiero AnonCreds registry
  that rebuilds revocation state, `HederaVdrRegistry`, the HCS-1 codec and the PDF renderer all run as in production.
  Issuer DIDs are imported into the issuer wallet instead of registered.
- **One fixture.** Every test that needs Hedera uses `InMemoryHedera`; runtime code never imports `testing/`.
- **Live runs are manual.** Testnet is exercised by `yarn issuer:init` and the console; the links go in the README.

Vitest processes `@credo-ts/*` and `@hiero-did-sdk/*` through one module graph (`server.deps.inline` in
`packages/sdk/vitest.config.mts`). Without it Vitest may load two copies of the Hiero SDK, the fake would replace the
wrong one, and a test could reach the network.

## The matrix

| Area | File | What it proves |
| --- | --- | --- |
| Issuer on the VDR | `certificates/certificates.test.ts` | schema, credential definition and revocation registry resolve from Hedera for any agent; initialization is idempotent; no issuance before initialization; invalid input rejected before any write |
| Document binding | `certificates.test.ts` | the PDF stored on HCS-1 is byte-identical; its hash is the credential's `document_sha256` |
| Enrollment (Platform B) | `certificates.test.ts` | grade 88 → ENROLLED revealing only `course`; the proof contains no name, student id, grade or document hash; grade 68 → no proof possible; PDF copy without a credential → DENIED; copied credential JSON cannot be stored without the link secret; a proof against another time's revocation state is rejected |
| Revocation and history | `certificates.test.ts` | after revocation: DENIED now, ENROLLED as of before; document check reports MATCH with the credential revoked; the PDF stays available; one HCS entry per change; revoking twice is a no-op |
| Accreditation | `certificates.test.ts`, `certificates/accreditation.test.ts` | no accredited issuer → no request; a valid credential stops qualifying after its issuer is withdrawn and still qualifies as of before; Mirror Node `contracts/call` encoding and decoding against the generated ABI; read failures typed |
| Contract | `packages/hardhat/test/AccreditationRegistry.test.ts` | authority-only writes, empty values, accredit/withdraw history, no re-accreditation, ordered listing, generated ABI and bytecode up to date |
| Downloaded document | `certificates.test.ts` | exact PDF → MATCH; one flipped byte → MISMATCH while the credential still verifies |
| HCS-1 codec | `certificates/hcs1.test.ts` | round trip with several chunks in any order; missing, duplicated, malformed, tampered chunks; wrong memo; no data URI; Mirror pagination; unavailable chunk; admin key; unknown topic; bad id; Mirror Node down or failing |
| PDF and attributes | `certificates/document.test.ts` | deterministic bytes; depends on the certificate id; small enough for HCS-1; AnonCreds attribute encoding; input validation; operator key normalization (raw hex ECDSA/ED25519 → DER) |
| Environment | `hedera/environment.test.ts`, `hedera/networks.test.ts` | network, account, key, balance, Mirror Node failures, curve detection, no secret in any result or report |
| CLI | `cli/setup.test.ts` | exit codes, JSON output, published issuer or the next command |
| API boundary | `nextjs/app/api/_lib/server.test.ts` | typed errors → HTTP status; unexpected errors never leak their text; holder allow-list |
| Console | `nextjs/app/_components/PlatformPanel.test.tsx`, `app/_lib/api.test.ts` | what Platform B asked for, received and never received; denial without a proof; historical query in UTC seconds; client error mapping |
| Public certificate page | `nextjs/app/certificate/[id]/page.test.tsx` | public data and the HCS-1 integrity check, never a validity claim; unknown certificate or unpublished issuer → 404; a typed failure (no `.env`, Mirror Node down) is explained instead of a 500; unexpected errors go to the error boundary |

## Commands

```bash
yarn test                         # every workspace
yarn workspace @sh/sdk test       # SDK only (about a minute: Credo creates real credential definitions)
yarn hardhat:test                 # the contract on the in-process Hardhat network
yarn coverage                     # with coverage
```
