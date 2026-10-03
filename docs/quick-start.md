# Quick start

From nothing to a revoked certificate on Testnet in about fifteen minutes. Every command exists in the root
`package.json`; when one fails, the message and its fix are in [troubleshooting.md](troubleshooting.md).

Prerequisites: Node.js ≥ 20.19, Git with `user.name`/`user.email` set, and Yarn (`corepack enable` turns on the Yarn
pinned by the repository). For `yarn self-check` and `yarn secrets:scan` you also need
[gitleaks](https://github.com/gitleaks/gitleaks).

## 1. Scaffold and install

```bash
npm create scaffold-hbar@latest -- --template fmartns/scaffold-hbar-verifiable-settlement
cd <project-name>
yarn install     # if the CLI did not run it
yarn test        # offline, no account needed: the whole flow against an in-memory Hedera
```

The `--` before `--template` is required: without it npm swallows the flag. `yarn install` downloads prebuilt native
libraries for Askar, AnonCreds and zstd (macOS x64/arm64, Linux x64/arm64, Windows x64) from their GitHub releases.

## 2. Create and fund a Testnet account

Create an account at <https://portal.hedera.com> (ED25519 or ECDSA both work) and top it up at the faucet. The whole
walkthrough spends about 13 HBAR (the accreditation contract's creation fee is about 10 of it); `yarn setup` asks for at least 20 by default (`HEDERA_MIN_BALANCE_HBAR` changes it).

## 3. Configure and validate

```bash
cp .env.example .env
```

Set `HEDERA_OPERATOR_ID` (`0.0.x`) and `HEDERA_OPERATOR_KEY`. The key can be DER (`302e…` / `3030…`) or raw hex (with or
without `0x`); for raw hex the curve is read from the account on the Mirror Node. `.env` is git-ignored.

```bash
yarn setup
```

```
Setup: validating the Hedera environment
  Network:  testnet
  Account:  0.0.xxxxxxx (https://hashscan.io/testnet/account/0.0.xxxxxxx)
  Balance:  997.85 HBAR (minimum 20 HBAR)
…
Environment validated.
No issuer on testnet yet. Next: yarn issuer:init (publishes the issuer on Hedera).
```

Exit code 0 means valid, 1 invalid (each problem is listed with its fix), 2 network unreachable.

## 4. Publish the issuer

```bash
yarn issuer:init
```

It shows the plan and the cost and asks before paying (`--yes` skips the question):

```
Publishes on Hedera (HCS), paid by the operator account:
  1. did:hedera of the issuer (a topic holding the DID document)
  2. CourseCompletion schema (HCS-1 file)
  3. Revocable credential definition (HCS-1 file)
  4. Revocation registry definition (HCS-1 file) and its entries topic (the state verifiers rebuild)
  5. AccreditationRegistry contract (Smart Contract Service), accrediting that credential definition for the course
Estimated cost: about 12 HBAR on Testnet (≈ US$ 1.20; the contract creation fee is about US$ 1 of it).
Publish the issuer on testnet? [y/N] y
Publishing… (about a minute: every step waits for consensus and the Mirror Node)
Issuer published:
Issuer DID:              did:hedera:testnet:6ynG…6qQP_0.0.10835831
Schema:                  did:hedera:testnet:6ynG…_0.0.10835831/anoncreds/v1/SCHEMA/0.0.10835833
Credential definition:   did:hedera:testnet:6ynG…_0.0.10835831/anoncreds/v1/PUBLIC_CRED_DEF/0.0.10835834
Revocation registry:     did:hedera:testnet:6ynG…_0.0.10835831/anoncreds/v1/REV_REG/0.0.10835837
Revocation entries:      https://hashscan.io/testnet/topic/0.0.10835836
DID document topic:      https://hashscan.io/testnet/topic/0.0.10835831
Accreditation registry:  https://hashscan.io/testnet/contract/0.0.10837530 (Solidity Basics)
```

Running it again costs nothing: it prints the published issuer. The issuer's wallet (with the DID key and the credential
definition's private keys) is in `.data/wallets/` — back it up; without it you cannot issue or revoke for this issuer.

## 5. Issue, verify, revoke

```bash
yarn dev    # http://localhost:3000
```

1. **Issue certificate** with the defaults (Ana Example, Solidity Basics, 88). About 20 s: the PDF goes to HCS-1
   first, then the credential goes into Ana's wallet.
2. **Download PDF**: it is rebuilt from its HCS-1 topic and checked against the memo hash before you get it. **Public
   page** is where the QR code leads.
3. **ana applies** → **ENROLLED**. The card lists what Platform B received (`course = Solidity Basics`,
   `grade >= 70: true`) and what it never received.
4. **bob applies** → **DENIED**: Bob has no credential, only (perhaps) a copy of the PDF.
5. **Revoke** → one message on the revocation entries topic.
6. **ana applies** → **DENIED**. Set **Was it valid at (UTC)?** to a time between issuing and revoking →
   **ENROLLED**: the same proof checked against the state at that consensus time.
7. **Check a downloaded certificate** with the PDF from step 2 → document **MATCH**, credential **REVOKED OR INVALID**.
8. Optional, and permanent for this issuer: issue a new certificate, then **Withdraw (authority)** in the issuer panel →
   **ana applies** → **DENIED** ("not accredited"), although her new credential is valid. A withdrawn credential
   definition is never re-accredited; to start over, use a fresh `CERTIFICATES_DATA_DIR` and run `yarn issuer:init`.

The same flow without a browser:

```bash
curl -X POST localhost:3000/api/certificates -H 'Content-Type: application/json' \
  -d '{"holder":"ana","holderName":"Ana Example","studentId":"123456","course":"Solidity Basics","grade":88}'
curl -X POST localhost:3000/api/enroll -H 'Content-Type: application/json' -d '{"holder":"ana"}'
```

## 6. Before you change anything

`yarn check` (lint, types, tests and the harness recipe) is the inner loop. Read [architecture.md](architecture.md) and
[AGENTS.md](../AGENTS.md) first: the rules about proof requests, private attributes and the PDF are normative.
