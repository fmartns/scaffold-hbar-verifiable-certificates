# Issuer console

Status: **implemented in issue #12**. Route `/issuer` in `packages/nextjs`; logic in `packages/sdk/hedera/credentials`
(minimal module that #41 extends into the full credentials SDK).

The console issues and revokes credentials on the `CredentialRegistry` ([credential-registry.md](credential-registry.md))
with HCS evidence ([credential-audit.md](credential-audit.md)), shows each step as it happens, and audits the result with
the shared audit (#10). It does not register issuers: that is an `ADMIN_ROLE` action (`registerIssuer`).

## Who does what

| Actor | Key | Does |
|---|---|---|
| Browser wallet (MetaMask, HashPack in EVM mode) | The issuer's **registered signer** | Signs the credential / revocation (EIP-712, `eth_signTypedData_v4`) and sends `issue` / `revoke` |
| Console server (`/api/credentials/*`) | The operator (`HEDERA_OPERATOR_*`, server only) | Publishes the signed message to the HCS topic and returns the consensus receipt |
| Browser | none | Derives every identifier and hash, decodes contract errors, polls the receipt |

The server only spends operator HBAR for the **current active signer** of the namespace: before publishing it reads
`issuerOf` (and `statusOf` for a revocation) and answers `403 issuer_not_registered` otherwise. It never sees a private
key of the issuer, and the browser never sees the operator key (no `NEXT_PUBLIC_` secret).

## Issuance flow

```text
build → sign → dry-run → publish to HCS (consensus receipt) → send issue(...) → confirm
```

1. **Build** (`buildCredentialDraft`). From the form: issuer namespace, credential type (a schema preset), reference,
   the type's claims, holder identifier type and value, issue/expiry dates and signature window. Every identifier is
   derived by `deriveCredential` in `packages/sdk/hedera/credentials/schema.ts`, following
   [docs/credential-schema.md](credential-schema.md); the console never computes one itself.
   - The holder identifier is committed with a **random 32-byte salt** into `subjectCommitment`. The identifier is
     never sent, logged or stored; the salt ("holder secret") is shown once, and the holder document (JSON with the
     identifier, salt and claims) can be downloaded for the holder only.
   - `submitter` is always the connected issuer wallet, never `address(0)`. The signed event is public on HCS before
     `issue()` runs and the `HcsRef` is not covered by the signature, so an unpinned event could be submitted first by
     anyone with a forged `HcsRef` ([docs/security.md](security.md)). With the pin, any other caller reverts with
     `SubmitterMismatch` (tested against the compiled contract).
2. **Sign**. The wallet signs the typed `CredentialEvent`; the console checks the recovered signer is the account.
3. **Dry-run**. `eth_call` of `issue` with a placeholder `HcsRef`. Contract errors (unknown issuer, wrong signer,
   duplicate, expired window...) are reported **before** anything is published or paid.
4. **Publish** (ADR D11). The server encodes the message with `hcs/credential-envelope.ts` (the only parser), publishes
   it and waits for the consensus receipt. The transaction ID and HashScan URL are shown and kept.
5. **Register**. The wallet sends `issue(event, signature, hcsRef)` with the real sequence and consensus timestamp.
6. **Confirm**. The receipt is polled (default deadline 90 s). A reverted receipt is replayed with `eth_call` to show
   the contract's reason.

The result shows the credential ID (text, copy button and a QR code generated locally), the HCS evidence on HashScan,
the registry transaction and the holder secret. The browser keeps a short activity list (`localStorage`) with **only
identifiers and links**.

Revocation is the same with `status` first (the credential must exist and still be issued), then an explicit
confirmation dialog. Revocation is final. Admin revocation is not exposed in the console.

## Errors

Every failure is an `IssuerError` (`packages/sdk/hedera/credentials/errors.ts`) with a title, message, remediation
and the identifiers to reconcile with (HCS transaction ID, transaction hash). Raw provider text is never echoed.

| Category | Typical cause |
|---|---|
| `rpc_unavailable` | Relay or console server unreachable |
| `timeout` | No receipt / no answer before the deadline (the tx hash is kept: check HashScan before retrying) |
| `wallet_disconnected` | No wallet, no connected account, wallet locked |
| `wrong_network` | Wallet on another chain; the console offers to switch |
| `rejected` | Signature or transaction rejected in the wallet |
| `hedera` | Hedera status from the relay or the HCS publication (e.g. `INSUFFICIENT_PAYER_BALANCE`) |
| `issuer_not_registered` | `UnknownIssuer`, `InactiveIssuer`, `UnauthorizedSigner`, `UnauthorizedRevoker`, or the server's pre-check |
| `contract_rejected` | Other `CredentialRegistry` custom errors, decoded by name |
| `invalid_input` | A form field; nothing was signed or sent |
| `not_configured` | Missing server configuration |

An HCS publication with an unknown outcome is not retried automatically (the publisher never retries); the console
shows the transaction ID so the issuer can check it before trying again.

## Audit

After an issuance or revocation the console calls `/api/credentials/audit`, which runs `auditCredential` from
`packages/sdk/hedera/audit` and returns its report unchanged. The panel shows the on-chain status (authoritative), the
`CredentialIssued` / `CredentialRevoked` events, the timeline and findings. While the Mirror Node has not indexed recent
facts the report is `pending_index` and the panel asks again. HCS is evidence, not validity.

## Configuration

No new variables. The server needs, in the root `.env`:

- `HEDERA_NETWORK`, `HEDERA_HCS_TOPIC_ID` (`yarn hcs:topic`), `HEDERA_CREDENTIAL_REGISTRY_ADDRESS` (deploy);
- `HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_KEY` to publish (the status and audit routes work without them).

Without them the page shows what is missing and disables the forms; the API answers `503 not_configured`.

## Tests

- `packages/sdk/hedera/credentials/*.test.ts`: derivation, typed data, error taxonomy, flows (fake wallet signing with a
  real key) and server handlers; `client-bundle.test.ts` asserts the browser entry pulls no server module.
- `packages/hardhat/test/CredentialIssuerFlow.test.ts`: ABI selectors pinned to the compiled contract; issue and revoke
  end to end through the Hardhat EIP-1193 provider; real reverts decoded.
- `packages/nextjs/app/issuer/_components/*.test.tsx` (`yarn next:test`): placeholders, not configured, happy path
  (progress, credential ID, QR, HashScan, no PII sent or stored), and every error state above, revocation confirmation
  and the audit panel.
