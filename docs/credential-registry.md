# CredentialRegistry

`packages/hardhat/contracts/CredentialRegistry.sol` is the authoritative on-chain state of verifiable credentials: it
authorizes issuers per namespace, records each issuance exactly once, and lets the issuer (or the admin) revoke it. It
replaces the planned `SettlementRouter` for the credential flow and keeps its guarantees from ADR-001 (EIP-712
authenticity, a permanent idempotency key, authenticity before uniqueness, non-issuing admin roles), without
settlement policy, value caps or HTS.

> **Status.** How each field of `CredentialEvent` is derived (`issuer`, `schemaId`, `externalCredentialId`,
> `credentialId`, `subjectCommitment`, `credentialHash`) is specified in [credential-schema.md](credential-schema.md)
> (#38, the data-model part of ADR-002). The signed struct below is v1 of that model. The type string, domain and tag
> are pinned by tests. Changing any of them breaks the signing format and must be mirrored in
> `packages/sdk/hedera/hcs/credential-envelope.ts`.

## Flow

1. The issuer builds a `CredentialEvent` and signs it (EIP-712) with the signer registered for its namespace.
2. The HCS publisher commits the attestation and captures the consensus receipt **before** it is released (ADR D11).
3. Any relayer calls `issue(event, signature, hcsRef)`. The contract validates and records it.
4. Verifiers read `statusOf(credentialId)`; HCS and Mirror Node are evidence, not the source of truth.

`HcsRef` is the publisher's claim of where the attestation sits in HCS. The contract cannot read HCS: it only checks
`sequence != 0` and emits the claim. Never present it as verified on-chain.

## `CredentialEvent` and signing

```solidity
struct CredentialEvent {
    uint16  version;              // 1
    bytes32 issuer;               // keccak256(bytes(<lowercase ASCII organization name>)), registered
    bytes32 externalCredentialId; // keccak256(abi.encode(tag, schemaId, reference)); rules C1–C6
    bytes32 credentialHash;       // canonical content, incl. issuedAt/expiresAt and claims; never JSON
    bytes32 subjectCommitment;    // keccak256(abi.encode(tag, salt, idType, idValue)); never raw personal data
    bytes32 schemaId;             // keccak256(bytes("<name>.v<N>(<type> <field>,…)"))
    uint64  signedAt;             // unix seconds; when this issuance was signed, not the credential's issuedAt
    uint64  validUntil;           // expiry of this signed issuance, not of the credential (expiresAt)
    address submitter;            // address(0) = any caller
}
```

- Type string: `CredentialEvent(uint16 version,bytes32 issuer,bytes32 externalCredentialId,bytes32 credentialHash,bytes32 subjectCommitment,bytes32 schemaId,uint64 signedAt,uint64 validUntil,address submitter)`
- Domain: `name = "HederaVerifiableCredentials"`, `version = "1"`, `chainId = block.chainid`, `verifyingContract = CredentialRegistry`.
- Signature: 65 bytes, secp256k1, low-`s` (OpenZeppelin `ECDSA`; malleable signatures revert `InvalidSignature`).
- Idempotency key: `credentialId = keccak256(abi.encode(keccak256("hedera-verifiable-credentials.credential.v1"), issuer, externalCredentialId))`. It is permanent and not bound to chain or deployment. It is never a payload hash, signature or nonce.

## Order of checks in `issue`

| # | Check | Error |
|---|---|---|
| 1 | Not paused | `Paused` |
| 2 | `version == 1`; `issuer`, `externalCredentialId`, `credentialHash`, `subjectCommitment`, `schemaId` ≠ 0; `validUntil > signedAt`; `hcs.sequence ≠ 0`; submitter pin | `UnsupportedVersion`, `InvalidField`, `SubmitterMismatch` |
| 3 | Issuer registered and active; signature recovers the issuer's current signer | `UnknownIssuer`, `InactiveIssuer`, `InvalidSignature`, `UnauthorizedSigner` |
| 4 | Uniqueness of `credentialId`: same `credentialHash` and `subjectCommitment` ⇒ duplicate, otherwise conflict | `AlreadyIssued`, `ConflictingCredential` |
| 5 | Freshness: `now ≤ validUntil`; `signedAt ≤ now + 30 s`; `validUntil − signedAt ≤ maxValidity` of the issuer | `Expired`, `SignedInFuture`, `ValidityWindowTooLong` |
| 6 | Record `{issuer, credentialHash, subjectCommitment, signer, issuedAt, status = Issued}`; emit `CredentialIssued` | — |

Authenticity is checked before uniqueness, so `ConflictingCredential` always means the registered signer signed two
different contents for one credential (equivocation or an issuer bug), never forged noise. A revoked `credentialId` is
never issued again. Re-submitting it reverts `AlreadyIssued` or `ConflictingCredential`.

## Access control

| Action | Who | Notes |
|---|---|---|
| `issue` | Anyone (relayer) | The signature is the authority; `submitter` can pin the caller |
| `revoke` | Current signer of the issuing namespace while active, or `ADMIN_ROLE` | Final; works while paused; the event records `byAdmin` |
| `registerIssuer` | `ADMIN_ROLE` | Once per namespace; `0 < maxValidity ≤ 30 days` |
| `setIssuerActive`, `setIssuerMaxValidity`, `setPaused` | `ADMIN_ROLE` | Pause blocks issuance only |
| `rotateIssuerSigner` | Current signer of an active namespace | Old key loses issue and revoke power at once |

No role can issue, and no function changes the `credentialHash`, `subjectCommitment`, `issuer` or `signer` of an existing
record. The admin cannot rotate an existing issuer's signer or re-register its namespace, so it cannot forge an
issuance under a namespace it does not control. A test pins the full list of state-changing functions.

**Residual risk.** An admin can register a *new* namespace with a key it controls. Mapping a namespace to a real
organization is off-chain trust. Every registration emits `IssuerRegistered`, and a multisig admin is recommended. If
an issuer key leaks, the admin deactivates the namespace, which freezes both issuance and rotation, and revokes as
needed. It must not reactivate the namespace while the compromised key is still its signer.

## Deployment

`packages/hardhat/deploy/00_deploy_credential_registry.ts` deploys with the deployer as admin and
`hcsTopicNum` taken from `HEDERA_HCS_TOPIC_ID` (required on live networks; `0` on the in-process network). The deployer
key is injected at runtime (`__RUNTIME_DEPLOYER_PRIVATE_KEY`); there is no default key. `yarn deploy --network
<hederaTestnet|hederaLocal>` ends by recording the address, contract id and ABI in `packages/sdk/generated`
([integration.md](integration.md#contract-abi-and-address-codegen)); no address is copied by hand.

## Tests

`packages/hardhat/test/CredentialRegistry.test.ts` covers valid issuance, unregistered or inactive issuers, forged,
tampered, malleable and cross-deployment signatures, re-issuance (`AlreadyIssued`) and conflicts
(`ConflictingCredential`), revocation by the issuer, by unauthorized parties, after rotation and by the admin,
admin limits, structure, freshness and pause. `CredentialLifecycle.flow.test.ts` runs issuer → HCS → registry →
verifier end to end on the compiled contract. Coverage target: 100% (95% branches), see [testing.md](testing.md).
