# Event Attendance Certificate demo (`yarn demo:event-attendance`)

Status: **implemented in issue #42**. CLI in [`packages/sdk/cli/demo-event-attendance.ts`](../packages/sdk/cli/demo-event-attendance.ts),
test in [`packages/sdk/cli/demo-event-attendance.test.ts`](../packages/sdk/cli/demo-event-attendance.test.ts). Written to be
reused as-is for the bounty submission (#20): it is the single command a reviewer runs to see the whole credential
lifecycle, with no setup.

`yarn demo:event-attendance` runs one concrete, named example — a hackathon organizer issuing an attendance credential
to a participant — through the exact production code paths this template ships, end to end, **offline**:

- no `.env`, no Hedera account, no credentials, no network access;
- deterministic: the same credential id, QR code and step order every run (see "Why this is safe to document
  verbatim" below);
- finishes in under a second.

It is a seed/demo built *on top of* the generic credential core, never the other way around. It is the one file in
`@sh/sdk` that knows the word "event"; nothing in the issuer console, the contracts or the verifier depends on it, and
deleting it changes nothing else in the template (the acceptance bar for #42).

## What it does

1. **Issue.** `runIssuance` (the same issuer-console flow used by #12, and by `yarn verify:testnet`) builds an
   `event-attendance` credential (`CREDENTIAL_SCHEMA_PRESETS[0]`, `packages/sdk/hedera/credentials/fields.ts`) for a
   hackathon participant, signs it, and — honoring ADR D11 — **publishes the evidence to HCS and captures the
   consensus receipt before** sending the registry transaction that puts it `ACTIVE`.
2. **QR code.** Encodes the credential id (the same encoding the issuer console uses) as both a terminal-renderable
   QR and a `data:image/png` QR, alongside the verifier path (`/verify/<credentialId>`) a participant would scan to.
3. **Verify (first read).** `handleCredentialStatus` — the exact handler the public verifier's
   `GET /api/credentials/status` route calls (#40) — reads the credential back: `ACTIVE`.
4. **Revoke.** `runRevocation` (same flow, same D11 ordering) revokes the credential.
5. **Verify (second read).** The same handler reads it back again: `REVOKED`.

Nothing here re-implements credential derivation, the issuer flow, or the server handlers. The only new piece is the
wiring: a deterministic in-memory Hedera (`@sh/sdk/testing`'s `fakeTestnet`) standing in for the real network, and one
throwaway demo signer (`DEMO_ORGANIZER_PRIVATE_KEY`, hardcoded in the script, valid only on that fake network — never
reuse it for anything real).

## Why this is safe to document verbatim

`fakeTestnet`'s clock starts at a fixed timestamp (`2026-10-01T12:00:00Z`), and the demo's draft input (issuer,
schema, reference, subject, claims) is a fixed literal. The credential id is a pure function of those identifying
fields (`computeCredentialId(issuer, externalCredentialId)`, ADR §4.4) — not of signatures or of
`generateSubjectSalt`'s randomness, which the credential core deliberately keeps out of the id — so the credential id,
the verifier path and the QR code are the same on every run. Transaction hashes are not (ECDSA signing is randomized),
which is why the test in `demo-event-attendance.test.ts` only asserts hash *shape*, not a fixed value.

## Why this is not evidence against the real network

This script's HCS topic id, transaction hashes and HashScan-shaped text are illustrative only — the network behind
them is the in-memory fake, not Hedera Testnet, so none of its links resolve. For real HashScan evidence, run
`yarn verify:testnet` instead ([docs/testnet-validation.md](testnet-validation.md)), which spends real Testnet HBAR
and writes versioned evidence under `docs/evidence/testnet/`.

## Usage

```bash
yarn demo:event-attendance
```

No prior setup, no `.env`, no `yarn setup`. Exits `0` on the full ACTIVE → REVOKED cycle passing, `1` otherwise.

## Example output

Captured from a real run on 2026-10-01 (credential id, HCS sequence and registry transaction hashes vary only in the
sense explained above — re-running reproduces the same credential id and QR code):

```
Event Attendance Certificate demo (#42) — offline, deterministic, no .env and no network needed.

Organizer "hedera-hackathon-sp-2026" issues an event-attendance credential for alice@example.com...
  build: done
  sign: done
  simulate: done
  publish: done
  register: done
  confirm: done
  credentialId = 0xe7a9f74d3814a6176efb68a951fb944ce034da22323850fc547d10e044b45f8e
  HCS evidence: topic 0.0.4567, sequence 1
  Registry transaction: 0x6f00852f663fd70fc4e0555a12a65f63e50e689f2cf7f1f806f2445151bbd456
QR code generated for the credential id (same encoding the issuer console uses):
[... terminal QR code ...]
Verification link: /verify/0xe7a9f74d3814a6176efb68a951fb944ce034da22323850fc547d10e044b45f8e
Participant scans the QR code and checks the verifier's read path (GET /api/credentials/status)...
  status = ACTIVE
Organizer revokes the credential...
  status: done
  sign: done
  simulate: done
  publish: done
  revoke: done
  confirm: done
  Registry transaction: 0x3e055ee2a36b05b0e05cb92c8be99ded0b4342e84d00b5c18f3cf40820048975
Participant checks the verifier again...
  status = REVOKED

ok    issue -> QR -> verify ACTIVE -> revoke -> verify REVOKED, all passed.
```

(The terminal QR code itself is omitted above for readability; it renders as a scannable ASCII QR block in a real
terminal.)

## Reuse, not re-implementation

| Concern | Implementation used |
|---|---|
| Issuance / revocation order (D11), signing, dry-run, registry transaction | `runIssuance` / `runRevocation` (`hedera/credentials/issuer-flow`) |
| Credential status read | `handleCredentialStatus` — the same handler `GET /api/credentials/status` calls (#40) |
| Credential publish (issuer side) | `handlePublishCredential` |
| Credential id, schema, issuer namespace | `computeIssuerId`, `CREDENTIAL_SCHEMA_PRESETS` (`hedera/credentials/schema.ts`, `fields.ts`) |
| In-memory Hedera (HCS topic, registry, Mirror reads) | `fakeTestnet` / `testnetEnv` (`@sh/sdk/testing`, dev/test only) |
| Local signing + relay forwarding | `createRelayWallet` (`hedera/testnet/relay-wallet`) |

This is also why `cli/demo-event-attendance.ts` is the one file excepted from the SDK's `no-restricted-imports` rule
against importing `@sh/sdk/testing` outside a test (`packages/sdk/eslint.config.mjs`): it is dev/demo-only, isolated,
and never imported by anything that ships to production.

## For the bounty submission (#20)

This command is the fastest way for a reviewer to see the full issue → verify → revoke → verify cycle without
touching a wallet, an `.env` file, or the Hedera network — point them at `yarn demo:event-attendance` first, and at
`yarn verify:testnet` ([docs/testnet-validation.md](testnet-validation.md)) for the same cycle with real HashScan
evidence.
