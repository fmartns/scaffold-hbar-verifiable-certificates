# Architecture

Privacy-preserving, revocable course certificates on Hedera. An institution issues an **AnonCreds credential** whose
public objects live on the **Hedera Verifiable Data Registry** (HIP-762), hands the holder a **PDF** stored as an
**HCS-1** file, and a relying party (**Platform B**) decides enrollment from a zero-knowledge proof without ever
contacting the institution.

This document is normative. [hedera.md](hedera.md) maps every Hedera object; [security.md](security.md) is the threat
model.

## 1. The problem

A course certificate is only useful when someone else acts on it: Platform B enrolls Ana in *Advanced Solidity* only if
she completed *Solidity Basics* with a grade of at least 70. Today that means a PDF by e-mail and a phone call to the
issuer, or an API call to the issuer's server. Both make Platform B trust the issuer's server to tell the truth, to be
online, and to tell every verifier the same thing — and both hand Platform B the grade, the name and the student id it
does not need.

The template removes each of those dependencies:

| Platform B must not need… | Because… |
| --- | --- |
| to ask the issuer | it resolves the issuer's public objects and revocation state from Hedera |
| the grade (88) | AnonCreds proves `grade >= 70` without revealing it |
| the name or student id | the proof reveals only `course` |
| to trust a status page hosted by the issuer | revocation state is rebuilt from the issuer's HCS topic, the same for every verifier |
| to trust that the presenter is the holder | the proof requires the holder's link secret; a copied file is useless |
| to hard-code which academy is legitimate | it reads the accreditation authority's registry contract at decision time |

## 2. Components and responsibilities

```
                 ┌─────────────────────── Hedera (read through the Mirror Node) ─────────────────────────────┐
                 │ HCS: did:hedera topic · schema · credential definition · revocation registry definition    │
                 │      (HCS-1 files) · revocation entries topic · certificate PDFs (HCS-1)                   │
                 │ Smart Contract Service: AccreditationRegistry (which credential definitions an authority   │
                 │      recognizes for which course, since/until when)                                        │
                 └──────▲───────────────────────────▲──────────────────────────────────▲──────────────────────┘
                 writes │                     reads │                             reads │
        ┌───────────────┴──────┐     credential ┌───┴───────────────┐   proof   ┌───────┴──────────────┐
        │ Issuer (Hedera       │ ─────────────▶ │ Holder wallet     │ ────────▶ │ Platform B (verifier)│
        │ Academy) Credo agent │   + PDF        │ (Ana) Credo agent │           │ Credo agent → decides │
        └──────────────────────┘                └───────────────────┘           └──────────────────────┘
          Accreditation authority ── accredit / withdraw ──▶ AccreditationRegistry
```

| Technology | Role | Where |
| --- | --- | --- |
| **AnonCreds + Credo** (OpenWallet Foundation) | credential protocol: CL signatures, holder binding (link secret), selective disclosure, predicates, non-revocation proofs | `packages/sdk/certificates/{agents,issuer,presentation}.ts` |
| **Hedera / HCS** via `@credo-ts/hedera` and the Hiero DID SDK | Verifiable Data Registry: DID, schema, credential definition, revocation registry, revocation entries with consensus timestamps | `agents.ts` (`HederaVdrRegistry`) |
| **HCS-1** | storage and delivery of the human-readable certificate | `hcs1.ts` (codec), `ledger.ts` (write/read) |
| **PDF** | the picture of the certificate, for humans | `document.ts` |
| **SHA-256** | binds the PDF to the credential (`document_sha256`) and to its HCS-1 topic memo | `hcs1.ts`, `issuer.ts` |
| **AccreditationRegistry** (Solidity, Hedera Smart Contract Service) | trust anchor: which credential definitions an accreditation authority recognizes for a course, with exact history | `packages/hardhat/contracts`, `accreditation.ts` |
| **Mirror Node** | the read path: every verifier reconstructs Hedera state from it and calls the registry (`contracts/call`) | Hiero SDK, `ledger.ts`, `accreditation.ts` |

The PDF is never the source of truth and HCS-1 never decides validity. **Validity is the AnonCreds credential checked
against the Hedera VDR.**

Process layout: the agents need native libraries (Askar, anoncreds-rs, zstd), so they run only in Next.js route
handlers on the Node.js runtime (`packages/nextjs/app/api`), never in the browser bundle. One `CertificateService` per
server process (`service.ts`) opens four wallets: `issuer`, `platform`, `ana`, `bob`. Holders are separate wallets
because holder binding only means something when the link secret lives where nobody else can read it.

## 3. Issuance

`issueCertificate` (`issuer.ts`) runs, in order:

1. `certificateId = randomUUID()`.
2. Render the PDF (`document.ts`) with the name, course, issuer, date, `certificateId` and a QR code pointing to
   `/certificate/<certificateId>`. Rendering is deterministic: same input, same bytes.
3. `sha256 = SHA-256(pdf)`.
4. Store the PDF as an HCS-1 file: a new topic whose memo is `<sha256>:zstd:base64`, submit key = operator, no admin
   key, chunk messages `{o, c}`. Wait until the Mirror Node serves it and it decodes to the same hash.
5. Issue the AnonCreds credential with attributes `holder_name, student_id, course, grade, certificate_id,
   document_sha256` and a revocation index; the holder's wallet stores it under its link secret.

The PDF is published **before** the credential, so a credential never points at a document that does not exist.

## 4. Binding the PDF to the credential

One relationship, no cycles:

```
certificateId ──▶ PDF bytes ──▶ SHA-256 ──┬──▶ HCS-1 topic memo   (enforced by the HCS-1 format: content addressing)
                                          └──▶ document_sha256    (signed by the issuer inside the credential)
```

- `document_sha256` is a credential attribute (option A). The HCS-1 memo carries the same hash because HCS-1 requires
  it (option B). Two places, two jobs, no extra HCS message (option C) and no circular reference: the PDF does not
  contain its own hash or the credential's.
- The HCS-1 topic id is **not** in the credential: it is a locator, and it does not exist when the PDF is rendered (the
  QR code cannot contain it either). Any copy of the file is checked by its hash, wherever it was found.

**How a third party proves that this PDF is the picture of credential X** (`verifyDownloadedCertificate`,
`platform.ts`):

1. Hash the file it was given: `fileSha256 = SHA-256(file)`.
2. Ask the holder for a proof revealing `certificate_id` and `document_sha256`, non-revoked at a chosen time, from the
   trusted credential definition.
3. Verify the proof against Hedera (section 6).
4. The document is the credential's picture iff `revealed.document_sha256 == fileSha256`; the credential is valid iff
   the proof verifies. The two answers are reported separately: `DOCUMENT INTEGRITY` and `CREDENTIAL STATUS`.

The public certificate page (where the QR code leads) can only show the first half: it re-reads the HCS-1 file and
checks it against its memo. It **cannot** show whether the credential is revoked, on purpose: AnonCreds keeps
revocation indexes private, so a public page that knew the index of certificate X would tell everyone watching the
revocation topic who was revoked. Status is proven by the holder, to a verifier, at a point in time.

## 5. Presentation and Platform B's decision

`decideEnrollment` (`platform.ts`) runs four steps:

1. **Whom to trust.** Read `credentialDefinitions("Solidity Basics")` from the accreditation registry (Mirror Node
   `contracts/call`). No accredited definition, no request.
2. **Ask.** Send the holder:

   ```json
   {
     "requested_attributes": { "course": { "name": "course", "restrictions": [{ "cred_def_id": "<accredited 1>" }, …] } },
     "requested_predicates": { "grade": { "name": "grade", "p_type": ">=", "p_value": 70, "restrictions": [...] } },
     "non_revoked": { "from": T, "to": T }
   }
   ```
3. **Verify** the proof against Hedera (section 6).
4. **Accreditation at `T`.** `isAccredited("Solidity Basics", <credential definition the proof used>, T)` on the
   registry: an academy whose accreditation was withdrawn before `T` does not qualify, even with valid credentials.

It enrolls only if the proof verifies, `course == "Solidity Basics"` and the issuer was accredited at `T`. Platform B learns `course` and the fact that
`grade >= 70`; it never receives the name, the student id, the grade or the document hash. A holder whose grade is 68
cannot build the proof at all, and a holder without the credential (someone who only has the PDF) has nothing to
present.

`non_revoked` is a single instant on purpose: the holder chooses which revocation state to prove against, and an open
interval would let a revoked holder use an older state. `verifyPresentation` also rejects any proof whose timestamp is
outside the requested interval, independently of anoncreds-rs.

## 6. Why HCS is state, not a log

The verifier never asks the issuer anything. For each proof it resolves, through its own agent:

| Object | Resolved by | From |
| --- | --- | --- |
| schema | `getSchema` | HCS-1 file (topic in the schema id) |
| credential definition | `getCredentialDefinition` | HCS-1 file |
| revocation registry definition | `getRevocationRegistryDefinition` | HCS-1 file, whose metadata names the entries topic |
| revocation status list at `T` | `getRevocationStatusList(id, T)` | **replay of the entries topic up to consensus time `T`** |

In `@hiero-did-sdk/anoncreds` (`hedera-anoncreds-registry.ts`, `resolveRevocationStatusList`), the registry fetches the
messages of the entries topic with `toDate = T`, applies every `issued`/`revoked` diff in consensus order, and takes the
accumulator of the last entry. That list is what anoncreds-rs checks the non-revocation proof against. There is no other
copy of this state: remove HCS and there is nothing to verify against. The topic's submit key is the issuer DID's root
key, and the consensus nodes refuse messages signed by anyone else.

Historical verification falls out of this: "was the certificate valid on 1 October?" is the same proof with
`T = 1 October`, checked against the state the Mirror Node rebuilds at that consensus timestamp.

## 7. What is load-bearing

| Component | Remove it | What breaks | Load-bearing? |
| --- | --- | --- | --- |
| AnonCreds | plain signed JSON | holder binding, predicates, selective disclosure, non-revocation proofs: Platform B would receive the grade and accept a copied file | **yes** |
| Credo | anoncreds-rs by hand | agents, wallets, registries and the Hedera integration would be rewritten by every developer | **yes** (integration layer) |
| Hedera HCS (VDR) | a database at the issuer | verifiers trust the issuer's server: it can show different revocation lists to different verifiers, rewrite history, or go offline | **yes** |
| `did:hedera` | an unregistered key | the issuer's key that controls the AnonCreds topics would not be publicly resolvable | yes |
| Mirror Node | — | the read path for every verifier; a trusted dependency (see security.md) | yes (trusted) |
| HCS-1 | file at the issuer | the PDF would live on storage the issuer controls; validity is unaffected | **useful, not load-bearing** |
| PDF | — | humans lose the certificate they can read and print; validity is unaffected | product, not trust |
| SHA-256 binding | — | a PDF could not be tied to the credential that decides its validity | yes (for document checks) |
| Next.js | — | the console; the SDK works without it | no |
| tails server | — | holders cannot build non-revocation proofs for new devices; verifiers do not need it | yes (holder side) |
| AccreditationRegistry | a list of trusted credential definitions in Platform B's code | any academy that publishes a "Solidity Basics" credential definition is as good as another unless every verifier is redeployed; no public, timestamped record of who was recognized when | **yes** (who to trust, not whether a certificate is valid) |

## 8. Decisions

**D1 — AnonCreds over W3C VC + status lists.** A W3C credential with a Bitstring Status List gives the verifier a list
hosted by the issuer, which the verifier cannot tell apart from a list kept in a private database. AnonCreds on Hedera
makes the verifier rebuild revocation state from consensus-ordered, issuer-only HCS messages, and adds holder binding
and predicates.

**D2 — The contract holds trust, not status.** The previous version of this template kept certificate status in an EVM
`CredentialRegistry`. With AnonCreds, revocation state already lives on HCS, and a second status source would
contradict the first, so that contract was removed. What a verifier still lacked was a public answer to "which academy
may certify this course?": `AccreditationRegistry` (packages/hardhat) records which credential definitions an
accreditation authority recognizes for a course, with `grantedAt`/`withdrawnAt` in consensus time, so "was this issuer
accredited at `T`" is exact. A withdrawn definition is never re-accredited (a new one is). The authority is the deployer
and is immutable; in the demo the operator plays the authority. Deployment and writes use the Hedera SDK (works with
ED25519 or ECDSA keys, no JSON-RPC relay); reads use the Mirror Node's `contracts/call`.

**D3 — PDF profile "minimal public".** The PDF shows the name, course, issuer, date and id — data the holder accepts to
make public, because HCS is public and permanent. The grade and student id exist only in the credential. Encrypted
documents were rejected for this template: key distribution and recovery would dominate the design.

**D4 — Small, deterministic PDF.** Standard fonts and a vector QR code keep the file around 3.6 KB: five HCS messages.
A 1 MB PDF would need about 1,450 messages; see [hedera.md](hedera.md#costs).

**D5 — Tails files over HTTP.** AnonCreds revocation needs a tails file, which only holders download. The template
serves it at `/api/tails/<hash>` (content-addressed by its hash), the standard AnonCreds arrangement. Moving it to HCS-1
would need a custom tails service in every holder and adds nothing a hash check does not already give.

**D6 — Two upstream fixes, applied explicitly.**
- `@hiero-did-sdk/anoncreds` 0.1.8 stamps revocation status lists with milliseconds; AnonCreds uses seconds, so every
  non-revocation proof failed. `HederaVdrRegistry` (`agents.ts`) returns the requested timestamp in seconds.
- `@hiero-did-sdk/registrar` 0.1.8 waits for a new DID with a time window frozen at the start of the wait; when the
  local clock lags consensus, the DID never appears and creation times out. A `yarn patch`
  (`.yarn/patches/@hiero-did-sdk-registrar-*.patch`) makes the window move.
- Not Hedera-specific: `async-function`, `generator-function` and `async-generator-function` (pulled in by
  `get-intrinsic` inside Next.js's own server) export a `module-sync` condition that points to an ESM-only build. On
  Node 20.19 Next.js's require hook resolves it and crashes `GET /` and `/api/health` with `ERR_REQUIRE_ESM` (Node 24 is
  unaffected). Three `yarn patch`es (`.yarn/patches/{async-function,generator-function,async-generator-function}-*.patch`)
  drop that condition so the packages load their CommonJS `index.js`.

Each patch is wired through `resolutions` in the root `package.json`; remove it once the upstream release fixes the
problem.

**D7 — Issuance by default, one registry.** Every index of the registry starts as "issued". Capacity is
`maximumCredentialNumber − 1` (AnonCreds indexes run from 1); the template stops with `REGISTRY_FULL` and does not rotate
registries.

## 9. Limitations

- The Mirror Node is trusted to serve what consensus produced. Hedera offers no state proofs a verifier can check today;
  a cautious verifier queries two Mirror Nodes.
- Holders are server-side demo wallets in the console. In production the holder is a mobile wallet that supports
  `did:hedera` (the Heka Wallet of the Hiero ecosystem, or any Credo/Bifold-based wallet with the Hedera module).
- Issuance by default means a proof "as of" a time before the credential was issued also succeeds; relying parties
  that care about the issue date ask for it.
- No DIDComm or OpenID4VC transport: issuer, holders and verifier exchange objects in-process.
- In the demo one operator account is both the issuer's payer and the accreditation authority. In production the
  authority deploys and controls its own registry, and Platform B is configured with that registry's address.
