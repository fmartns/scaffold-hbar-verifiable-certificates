# Security: threat model, trust boundaries and Definition of Done

What the template protects, whom each party trusts, how it can fail, and what every change must keep. The design is in
[architecture.md](architecture.md); the Hedera objects are in [hedera.md](hedera.md).

## 1. Assets

| Asset | Where it lives | Exposure if lost |
| --- | --- | --- |
| Operator private key (`HEDERA_OPERATOR_KEY`) | `.env`, server process only | anyone can spend the account and append to the document topics |
| Issuer DID root key | issuer Askar wallet (`.data/wallets/issuer.*`) | anyone can publish AnonCreds objects and revocations as the issuer |
| Credential definition private keys | issuer wallet | anyone can issue valid credentials in the issuer's name |
| Holder link secret | holder wallet | the holder's credentials can be presented by someone else |
| Grade, student id | holder's credential only | privacy of the holder |
| Name, course, date on the PDF | public on HCS (HCS-1) | public by design (profile "minimal public") |
| Accreditation authority key (the deployer; the operator in the demo) | `.env` | anyone can accredit a fake academy or withdraw a real one |
| Wallet keys (`.data/wallets/*.key`) | local disk, mode 600, git-ignored | the wallets above |

## 2. Trust boundaries

| Party | Trusts | Does not trust |
| --- | --- | --- |
| Platform B (verifier) | Hedera consensus (ordering, timestamps, submit keys); a Mirror Node to serve it faithfully; the credential definition it chose to trust | the issuer's server, the holder, the PDF, the public certificate page |
| Holder | its own wallet; Hedera for the issuer's public objects | the verifier with anything beyond what a proof request asks |
| Issuer | its wallet and operator key | holders and verifiers |
| Anyone reading the public page | the HCS-1 memo hash and the topic's keys | the issuer's register (`certificates.json`) for validity |

Input from forms, query strings, uploaded files and the Mirror Node is untrusted until checked: holders are an
allow-list, grades and texts are bounded (`validateIssueInput`), uploads are capped at 1 MB, topic ids are pattern-
checked, every HCS-1 file is hash-checked against its memo, and proof timestamps are checked against the request.

## 3. Threat model

| # | Threat | Impact | Mitigation | Residual risk |
| --- | --- | --- | --- | --- |
| T-1 | **Public PDF** reveals more than intended | permanent disclosure (HCS is public and immutable) | profile "minimal public": the PDF carries name, course, issuer, date, id; grade and student id never; docs say so | the name is public; deployments with stricter needs show a pseudonym or keep the PDF off-chain |
| T-2 | **PII on HCS** through AnonCreds objects | disclosure | only schema, credential definition, registry and accumulator diffs are published; attribute values are never on the ledger | none known |
| T-3 | **Linkability** across presentations | verifiers correlate a holder | CL proofs are unlinkable; enrollment reveals only `course`; `document_sha256` and `certificate_id` are revealed only in a document check, which is linkable by nature | a holder who reveals the document hash is identifiable to that verifier |
| T-4 | **Credential correlation** through the revocation index | public page would reveal who was revoked | the index is never published or shown; the public page cannot show status | the issuer's register knows the index (it must, to revoke) |
| T-5 | **Leaked link secret** | someone else presents the holder's credentials | link secret stays in the holder wallet; never logged or returned by an API | wallet compromise is out of scope; the issuer revokes and re-issues |
| T-6 | **Issuer key compromise** (DID root key or credential definition keys) | forged credentials or revocations under the issuer's identity | keys stay in the issuer wallet; the operator key is separate | no key rotation in the template: publish a new DID and credential definition, and verifiers move their trust to it |
| T-7 | **Holder copies the PDF** to someone else | the copy is presented as proof | the PDF is not the credential; a verifier asks for a proof; Bob's enrollment is denied (tested) | a verifier that only looks at the PDF is fooled — the docs and the public page say not to |
| T-8 | **Copied credential JSON** | presentation by a non-holder | the credential is bound to the link secret; storing it in another wallet fails (tested) | none known |
| T-9 | **Stale Mirror Node** | a just-revoked credential still verifies for a few seconds | proofs pin `non_revoked` to the request time and the verifier checks the proof timestamp; the issuer waits for the Mirror Node after revoking | a revocation is effective once indexed (seconds) |
| T-10 | **Malicious Mirror Node** | a verifier is shown a false revocation state or file | the Mirror Node is the only read path today; HCS-1 files are hash-checked; a cautious verifier compares two Mirror Nodes | Hedera offers no verifiable state proofs; the Mirror Node is trusted (documented limitation) |
| T-11 | **Tails file unavailable** | holders cannot build non-revocation proofs | tails are content-addressed and can be mirrored anywhere; holders cache them | a fresh holder device depends on the tails URL |
| T-12 | **HCS-1 file unavailable** | the PDF cannot be downloaded | the holder keeps the file; any copy is verified by hash; validity does not depend on it | the issuer's public page depends on the Mirror Node |
| T-13 | **Malformed or tampered chunks** | a wrong document is shown | `decodeHcs1` rejects missing, duplicated, malformed chunks and any hash mismatch; topics with an admin key are refused (tested) | none known |
| T-14 | **Hash collision** | two documents with the same `document_sha256` | SHA-256 collision resistance | relies on SHA-256 |
| T-15 | **Issuer revokes unfairly** | a holder loses a valid certificate | revocations are public, timestamped and permanent on HCS; historical verification proves the certificate was valid before | the issuer remains the authority over its own credentials |
| T-16 | **Fake issuer** | a lookalike academy issues "Solidity Basics" | Platform B restricts proofs to the credential definitions the accreditation registry lists for the course, and checks `isAccredited` at the proof's time (tested, and run on Testnet) | Platform B must be configured with the authority's registry address; the authority's judgment is trusted |
| T-20 | **Accreditation tampering** | a fake academy is accredited, or a real one withdrawn | only the authority (contract deployer) can write; every change is a public, timestamped contract call | a leaked authority key: see incident response |
| T-17 | **Credential definition spoofing** | a proof against another definition is accepted | anoncreds-rs enforces the restriction; the definition is resolved by id from its HCS-1 file, hash-checked by the Hiero reader | none known |
| T-18 | **Revoked holder proves with an old state** | revocation bypassed | `non_revoked.from = to = T`, and `verifyPresentation` rejects proof timestamps outside the request (tested) | none known |
| T-19 | **Third party writes to the revocation topic** | forged revocations or un-revocations | the topic's submit key is the issuer DID key, enforced by consensus nodes; older Hiero versions created it without one (fixed upstream in PR #19) | relies on the Hiero SDK version pinned in `yarn.lock` |

## 4. Secret scanning

- `.gitleaks.toml` keeps the gitleaks default rules and adds rules for Hedera ED25519 and ECDSA DER private keys, 32-byte
  hex keys assigned to key-like names, and mnemonics. Allowlists are narrow and documented.
- `scripts/secret-scan.mjs` (`yarn secrets:scan`) scans the full history (every ref, merge commits included; a shallow
  clone is refused) and the non-ignored working tree. `--self-test` generates fake keys at runtime and asserts each rule
  fires. Exit codes: `0` clean, `1` findings, `2` could not run. Values are always redacted.
- CI installs gitleaks and runs the self-test and the scan on every push.

## 5. Incident response

**A secret was committed or pushed.** Rotate it first (new account or key; removing it from history does not un-leak
it), then rewrite history, force-push, ask GitHub to purge cached views, and rerun `yarn secrets:scan`.

**The issuer wallet leaked (T-6).** Stop issuing. Publish a new DID and credential definition with `yarn issuer:init`
on a clean data directory, tell relying parties to trust the new credential definition only, re-issue legitimate
certificates and revoke the old ones you can still sign for.

**The accreditation authority key leaked (T-20).** Deploy a new registry from a new authority account, accredit the
legitimate credential definitions there, and point relying parties at the new address. The old registry's history stays
public, including any forged change.

**The operator key leaked.** Move the funds, create a new operator account, update `.env`. The document topics keep
their old submit key; new certificates use the new one.

## 6. Prohibited practices

- Committing secrets, private keys, mnemonics, real account credentials, a filled `.env` or the `.data/` directory.
  Test keys are generated at runtime or obviously synthetic.
- `NEXT_PUBLIC_` on any secret; importing `@sh/sdk/certificates` (server-only) from a client component.
- Putting a private key, a link secret, a grade, a student id or a URL beyond its origin into a log, an error, a report
  or an HTTP response.
- Putting the grade, the student id or any private attribute into the PDF or any HCS message.
- Presenting the PDF, the public page or the issuer's register as proof of validity.
- Accepting a proof without `non_revoked`, with an open interval, or with a timestamp outside the request.
- Re-implementing environment validation, the HCS-1 codec or proof verification outside their module (`AGENTS.md`).
- Tests that send Testnet or Mainnet transactions (`yarn test` is offline; use `@sh/sdk/testing`).

## 7. Security Definition of Done (every pull request)

**Secrets**
- [ ] `yarn secrets:scan` exits `0`, and `--self-test` passes if `.gitleaks.toml` changed.
- [ ] A new secret-bearing variable has a `template.json` entry whose description says it is secret and server-side
      only, and never uses the `NEXT_PUBLIC_` prefix.
- [ ] New logs, errors and API responses are tested to exclude key material and private attributes.

**Trust boundaries**
- [ ] Every new input (form, query string, upload, Mirror Node response) is validated before use.
- [ ] Anything a user relies on for validity is checked against Hedera by the verifier, not only in the UI.
- [ ] Client components import only types from `@sh/sdk/certificates`.

**Credentials and documents**
- [ ] New proof requests restrict `cred_def_id` and pin `non_revoked` to one instant.
- [ ] New attributes are classified: public (may go on the PDF) or private (credential only).
- [ ] New documents are hash-bound to the credential and stay small enough for HCS-1 (see hedera.md).

**Process**
- [ ] `yarn check` passes; this threat model is updated when the PR changes a trust boundary, a key or a party.
- [ ] Testnet changes include HashScan evidence, and nothing runs on mainnet without `--allow-mainnet`.
