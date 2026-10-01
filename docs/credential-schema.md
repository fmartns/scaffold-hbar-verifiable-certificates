# Credential data model and identity (`CredentialEvent`, `credentialId`)

| Field | Value |
|---|---|
| Status | **Specified** by issue #38. This is the data-model part of ADR-002; the privacy and trust parts are [ADR-002 in architecture.md](architecture.md#adr-002--credentials-privacy-on-chain-vs-off-chain-and-data-model) (#39). |
| Normative for | `CredentialRegistry` (#9), the credential SDK (#41), the issuer console (#12), the public verifier (#40), the audit (#10) |
| Implementation | `packages/sdk/hedera/credentials/schema.ts` (the only implementation of these formulas) |
| Supersedes | For credentials, ADR-001 §4.4 (R1–R6 for `externalEventId`). The reasoning is the same, applied to credentials. |

The key words MUST, MUST NOT, SHOULD and MAY follow RFC 2119.

## 1. Principles

1. **Identity is not content.** `credentialId` says *which* credential this is. `credentialHash` says *what it states*.
   A credential keeps its id when it is re-signed or re-published. If the same id is signed with different content,
   the registry reports a conflict (`ConflictingCredential`). It never treats that as a new credential.
2. **No JSON is ever hashed.** Every hash is `keccak256(abi.encode(...))` over fixed, typed fields. `abi.encode` is
   injective for a fixed type list, so two different values can never encode to the same bytes. This is the same
   lesson as ADR-001 R4.
3. **No personal data on-chain.** The holder appears only as a salted commitment. Names, e-mails, CPF numbers and the
   document itself stay off-chain ([ADR-002](architecture.md#adr-002--credentials-privacy-on-chain-vs-off-chain-and-data-model)
   CD2 lists what is public).
4. **Every hash has a domain tag.** Each formula starts with its own `keccak256("hedera-verifiable-credentials.<kind>.v1")`,
   so a value computed for one purpose can never be valid for another.

## 2. The model

`CredentialEvent` is the logical model of a credential. In the SDK it is the `CredentialModel` type.

| Field | Type | Definition | Where it lives |
|---|---|---|---|
| `issuer` | `bytes32` | `keccak256(bytes(issuerName))` ([§3.1](#31-issuer)) | On-chain (registry key, record, log) and HCS |
| `credentialId` | `bytes32` | `keccak256(abi.encode(CREDENTIAL_KEY_TAG, issuer, externalCredentialId))` ([§3.4](#34-credentialid)) | On-chain storage key, log topic |
| `credentialHash` | `bytes32` | Hash of the canonical content ([§4.2](#42-credentialhash)) | On-chain record, log, HCS |
| `subjectCommitment` | `bytes32` | Salted hash of the holder's identifier ([§4.1](#41-subjectcommitment)) | On-chain record, log, HCS |
| `schemaId` | `bytes32` | `keccak256(bytes(schemaDescriptor))` ([§3.2](#32-schemaid)) | On-chain log, HCS |
| `issuedAt` | `uint64` | Unix seconds. The date the issuer granted the credential (the date printed on it) | Committed in `credentialHash` |
| `expiresAt` | `uint64` | Unix seconds. `0` means the credential never expires | Committed in `credentialHash` |

### 2.1 Mapping onto the signed message (v1)

The registry and the HCS issuance message carry the model in the v1 signed struct, which already exists and is
unchanged ([credential-registry.md](credential-registry.md), [credential-audit.md](credential-audit.md)):

```solidity
struct CredentialEvent {                // EIP-712, signed by the issuer's registered signer
    uint16  version;                    // 1 (message format)
    bytes32 issuer;                     // model.issuer
    bytes32 externalCredentialId;       // model input to credentialId (§3.3); the registry derives credentialId
    bytes32 credentialHash;             // model.credentialHash (commits issuedAt and expiresAt)
    bytes32 subjectCommitment;          // model.subjectCommitment
    bytes32 schemaId;                   // model.schemaId
    uint64  signedAt;                   // signature freshness, NOT issuedAt
    uint64  validUntil;                 // signature expiry, NOT expiresAt
    address submitter;                  // relayer pin, address(0) = anyone
}
```

There are two deliberate differences from the issue's field list:

- **`externalCredentialId` is carried instead of `credentialId`.** The registry recomputes `credentialId` from it.
  An off-chain caller can therefore never supply an id that disagrees with its inputs.
- **`issuedAt` and `expiresAt` are committed inside `credentialHash`, not stored as separate fields.** They are facts
  stated by the credential, like its claims. Because they are in the hash, they are signed by the issuer and cannot
  change once recorded. A verifier who has the document checks them. They are kept apart from `signedAt`/`validUntil`,
  which only bound how long one *signature* can be submitted (ADR-001 D7). Mixing the two would let an expired
  signature window look like an expired credential, or the reverse.
  *Trade-off:* a verifier holding only a `credentialId` sees `issued` or `revoked`, but not the expiry date. Showing
  expiry without the document would require a v2 struct. ADR-002 CD5 keeps v1 ([§7](#7-open-points)).

## 3. Identifiers

### 3.1 `issuer`

`issuer = keccak256(bytes(issuerName))`. `issuerName` is a lowercase ASCII namespace: words of `[a-z0-9]` separated
by a single `.` or `-`, at most 64 bytes (e.g. `acme-university`, `cloud-cert.org`). This is the namespace registered
in `CredentialRegistry.registerIssuer`.

### 3.2 `schemaId`

A schema is a credential type: event attendance, a course, a professional certification, a diploma, a badge, a
corporate training. Its identity is its **descriptor**:

```
<name>.v<version>(<type> <field>,<type> <field>,…)
schemaId = keccak256(bytes(descriptor))
```

- `name`: lowercase words of `[a-z0-9]` separated by `-`. `version`: an integer ≥ 1 with no leading zeros.
- 1 to 32 fields. Field names match `^[a-z][A-Za-z0-9]*$` and are unique. The types are `string`, `bytes32`, `bool`,
  `uint64`, `uint256` and `address`.
- Only the canonical spelling is valid: one `,` between fields, one space between type and name, no padding.

Because the field layout is part of `schemaId`, two readers can never decode the same claims with different types.
Changing a field (its name, type or order) is a new version, and so a new `schemaId`.

### 3.3 `externalCredentialId` — identity rules (C1–C6)

```
externalCredentialId = keccak256(abi.encode(EXTERNAL_CREDENTIAL_ID_TAG, schemaId, reference))
EXTERNAL_CREDENTIAL_ID_TAG = keccak256("hedera-verifiable-credentials.external-id.v1")
```

`reference` is a `string`: the issuer's own permanent, unique identifier for this credential.

- **C1** It MUST be a deterministic function of the fields that **identify** the credential (`schemaId`, `reference`)
  and of nothing else.
- **C2** It MUST be stable when a credential is re-signed, re-published or re-submitted. Correcting a credential is
  not re-issuing it: revoke the old one, then issue a new credential with a new `reference` (e.g. a revision suffix).
- **C3** It MUST NOT include volatile or content fields: `signedAt`, `validUntil`, `submitter`, the HCS sequence or
  transaction id, the salt, `issuedAt`, `expiresAt`, the claims or `credentialHash`.
- **C4** `reference` SHOULD be the issuer's native id (serial number, certificate number, enrollment id). If the
  issuer only has a composite natural key, it MUST assign a serial for it. It MUST NOT build ad-hoc strings such as
  `"a/b"`, because delimiters are ambiguous.
- **C5** `schemaId` is always part of the identity. One `reference` can therefore back two credential types (e.g. the
  attendance and the completion of one enrollment) without colliding. The issuer namespace keeps two issuers apart
  through `credentialId`.
- **C6** `reference` is public through its hash and can be brute-forced if guessable, so it MUST NOT contain personal
  data (e-mail, CPF, name). It MUST be non-empty, NFC-normalized, without leading or trailing whitespace, and at most
  128 UTF-8 bytes.

### 3.4 `credentialId`

```
credentialId = keccak256(abi.encode(CREDENTIAL_KEY_TAG, issuer, externalCredentialId))
CREDENTIAL_KEY_TAG = keccak256("hedera-verifiable-credentials.credential.v1")
```

It is the idempotency key of the registry (AGENTS.md). It is permanent and is not bound to a chain or a deployment,
so the same credential has the same id in every audit. It is never a payload hash, a signature or a nonce.
`CredentialRegistry.computeCredentialId` and `computeCredentialId` in `hcs/credential-envelope.ts` are the only two
implementations, and a Hardhat test pins them against each other.

## 4. Commitments

### 4.1 `subjectCommitment`

```
subjectCommitment = keccak256(abi.encode(SUBJECT_COMMITMENT_TAG, salt, idType, idValue))
SUBJECT_COMMITMENT_TAG = keccak256("hedera-verifiable-credentials.subject.v1")
```

- `idType`: the kind of identifier, in lowercase words separated by `-` (`email`, `cpf`, `student-id`, `employee-id`, `did`).
- `idValue`: the identifier, hashed exactly as given. The issuer MUST normalize it for its type before issuing
  (e.g. lowercase an e-mail, keep digits only in a CPF). It must be NFC, without surrounding whitespace, and at most
  256 bytes.
- `salt`: 32 random bytes, non-zero, **unique per credential** (`generateSubjectSalt`). Without the salt, an
  identifier with low entropy (e-mail, CPF) could be found by brute force from the public hash. A unique salt per
  credential also stops anyone from linking two credentials of the same holder on-chain. The salt travels in the
  holder's document. Showing it to a verifier is how the holder proves that the credential is theirs.

### 4.2 `credentialHash`

The **canonical content** is the typed tuple below. Nothing else is hashed, and JSON is never hashed.

```
claimsHash     = keccak256(abi.encode(<claim values in schema field order, with the schema's types>))
credentialHash = keccak256(abi.encode(
    CREDENTIAL_CONTENT_TAG,              // keccak256("hedera-verifiable-credentials.content.v1")
    issuer, externalCredentialId, schemaId, subjectCommitment,   // bytes32
    issuedAt, expiresAt,                                         // uint64
    claimsHash                                                   // bytes32
))
```

- The content includes its own identity (`issuer`, `externalCredentialId`, `schemaId`) and its holder
  (`subjectCommitment`). A valid document of one credential therefore cannot be presented as the content of another.
- Claims: the document MUST contain exactly the schema's fields, with no extra or missing field, because an extra
  field would be unsigned data. Strings must be NFC, without surrounding whitespace, and at most 1024 bytes. Integers
  may be written as `bigint`, safe numbers or decimal strings. Hex values are case-insensitive. These spellings all
  encode to the same ABI value, so they produce the same hash.
- Optional claims do not exist. A schema that needs one documents a sentinel value (`""`, `0`) for "absent".

## 5. The credential document (off-chain)

The holder receives the document and the verifier recomputes every identifier from it. It may be sent as JSON,
because readers parse it into typed values before hashing.

```ts
interface CredentialDocument {
  version: 1;
  issuer: string;            // issuerName
  schema: string;            // canonical descriptor
  reference: string;         // §3.3
  subject: { idType: string; idValue: string; salt: string };
  issuedAt: number | string | bigint;
  expiresAt: number | string | bigint;  // 0 = never
  claims: Record<string, unknown>;
}
```

`deriveCredential(document)` validates the document, reporting every problem at once, and returns the
`CredentialModel`. `toCredentialEvent(model, { signedAt, validUntil, submitter })` builds the v1 signed struct.

**Verifying a credential:** derive the model from the document, read `statusOf(credentialId)`, and require
`status == Issued`, an equal `credentialHash` and `subjectCommitment`, and `expiresAt == 0 || now < expiresAt`
(`isCredentialExpired`). The on-chain status is the authority. The document only proves what the credential says.

## 6. Examples: three credential types, one schema model

These are the test vectors in `packages/sdk/hedera/credentials/test-fixtures.ts`. The subjects are fictitious and the
salts are fixed so the vectors are reproducible: never reuse them. `schema.test.ts` pins every value below, and
`packages/hardhat/test/CredentialSchema.test.ts` issues all three examples through one `CredentialRegistry` unchanged.

| | Event attendance | Course completion | Professional certification |
|---|---|---|---|
| `issuer` (name) | `hedera-hackathon` | `acme-university` | `cloud-cert.org` |
| `schema` | `event-attendance.v1(string eventName,uint64 eventDate,string role)` | `course-completion.v1(string courseCode,string courseName,uint64 completedOn,uint64 hours,string grade)` | `professional-certification.v1(string certification,string level,uint64 examPassedOn,bytes32 examResultHash)` |
| `reference` | `HH-2026-ATT-000123` | `ENR-2026-0042` | `CC-ARCH-2026-9F3K` |
| subject | `email` / `alice@example.com` | `student-id` / `2026-000777` | `cpf` / `00000000191` |
| `issuedAt` / `expiresAt` | `1789171200` / `0` (never) | `1790000000` / `0` | `1790100000` / `1853172000` (two years) |
| claims | `"Hedera Hackathon São Paulo 2026"`, `1789171200`, `"participant"` | `"CS-301"`, `"Distributed Ledgers"`, `1789900000`, `60`, `"A"` | `"Cloud Solutions Architect"`, `"professional"`, `1790000000`, `0x44…44` |

Derived values:

| | Event attendance | Course completion | Professional certification |
|---|---|---|---|
| `schemaId` | `0x0735d5cd…000c666a` | `0xd23903e5…75866393` | `0x8ebe9bdd…aebcaad8` |
| `credentialId` | `0xe0b511e6…d17fe878` | `0x814f99ee…18cb824c` | `0xd08444db…77f5969b` |
| `subjectCommitment` | `0xd5ba823f…c37b2dc9` | `0xd3741e34…44803199` | `0x89fd1abf…92cadc9f` |
| `credentialHash` | `0xa7473093…59ed1bc9` | `0x954bf257…a29a6a5f` | `0x1ded73ec…83335fc1` |

The core has no field specific to any of these types. Everything type-specific lives in the schema descriptor and
the claims, which is the genericity the demo (#42) relies on.

## 7. Open points

- **Expiry visible from `credentialId` alone.** *Decided in
  [ADR-002 CD5](architecture.md#adr-002--credentials-privacy-on-chain-vs-off-chain-and-data-model):* v1 stays. Expiry
  is committed in `credentialHash` and checked with the document; #40 shows "expired" only when it has the document.
  Status-only expiry would be a `version = 2` struct accepted alongside v1, never a change of v1.
- **Deterministic salts.** An issuer MAY derive the salt as `HMAC(issuerSecret, credentialId)` instead of drawing it
  at random, so that it can re-send a lost document. It must still be unique per credential and kept secret.
