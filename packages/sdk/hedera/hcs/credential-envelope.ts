/**
 * HCS evidence envelope of the credential lifecycle: the wire format of an issuance or a revocation published to HCS.
 *
 * The issuance struct is v1 of the credential model in docs/credential-schema.md (#38); how its fields are derived lives
 * in `../credentials/schema`. The revocation format is a proposal pending ADR-002 (#39). The type strings, domain and
 * `credentialId` formula are those of `CredentialRegistry` (#9); a Hardhat test pins them against the contract. Like
 * `./envelope`, this module is pure: no I/O, no clock, no Hedera SDK, and it is the ONLY parser of credential messages.
 *
 * Wire format (binary, no JSON canonicalization; the first byte is the message kind and format version):
 *
 *     issuance   = 0x10 || abi.encode(CredentialEvent)      || signature (65 bytes)   // signed by the issuer signer
 *     revocation = 0x11 || abi.encode(CredentialRevocation) || signature (65 bytes)   // signed by the revoker
 *
 * Both are signed with EIP-712 under the `CredentialRegistry` domain. The contract verifies the issuance signature; the
 * revocation signature is evidence only (`revoke(credentialId)` is authorized by `msg.sender`), so the audit compares its
 * signer with the on-chain `revokedBy`.
 */
import {
  AbiCoder,
  TypedDataEncoder,
  getAddress,
  getBytes,
  hexlify,
  isHexString,
  keccak256,
  recoverAddress,
  toUtf8Bytes,
} from "ethers";
import { SIGNATURE_LENGTH, parseBytes32, parseUint64, validateDomain, validateSignature } from "./envelope";
import type { EnvelopeIssue, EnvelopeResult, Hex, SigningDomain } from "./envelope";

// ---------------------------------------------------------------------------------------------------------------------
// Constants. Changing any of them is a breaking change of the envelope AND of the contract's signing format.
// ---------------------------------------------------------------------------------------------------------------------

export const CREDENTIAL_MESSAGE_KIND = { issuance: 0x10, revocation: 0x11 } as const;
export type CredentialMessageKind = keyof typeof CREDENTIAL_MESSAGE_KIND;

export const CREDENTIAL_EVENT_VERSION = 1;
export const CREDENTIAL_REVOCATION_VERSION = 1;

export const CREDENTIAL_EIP712_NAME = "HederaVerifiableCredentials";
export const CREDENTIAL_EIP712_VERSION = "1";

export const CREDENTIAL_KEY_TAG = keccak256(toUtf8Bytes("hedera-verifiable-credentials.credential.v1"));

export const CREDENTIAL_EVENT_TYPE_STRING =
  "CredentialEvent(uint16 version,bytes32 issuer,bytes32 externalCredentialId,bytes32 credentialHash,bytes32 subjectCommitment,bytes32 schemaId,uint64 signedAt,uint64 validUntil,address submitter)";
export const CREDENTIAL_REVOCATION_TYPE_STRING =
  "CredentialRevocation(uint16 version,bytes32 credentialId,bytes32 issuer,bytes32 reasonCode,uint64 signedAt)";

export const CREDENTIAL_EVENT_TYPES = {
  CredentialEvent: [
    { name: "version", type: "uint16" },
    { name: "issuer", type: "bytes32" },
    { name: "externalCredentialId", type: "bytes32" },
    { name: "credentialHash", type: "bytes32" },
    { name: "subjectCommitment", type: "bytes32" },
    { name: "schemaId", type: "bytes32" },
    { name: "signedAt", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "submitter", type: "address" },
  ],
};

export const CREDENTIAL_REVOCATION_TYPES = {
  CredentialRevocation: [
    { name: "version", type: "uint16" },
    { name: "credentialId", type: "bytes32" },
    { name: "issuer", type: "bytes32" },
    { name: "reasonCode", type: "bytes32" },
    { name: "signedAt", type: "uint64" },
  ],
};

const EVENT_TUPLE =
  "tuple(uint16 version,bytes32 issuer,bytes32 externalCredentialId,bytes32 credentialHash,bytes32 subjectCommitment,bytes32 schemaId,uint64 signedAt,uint64 validUntil,address submitter)";
const REVOCATION_TUPLE = "tuple(uint16 version,bytes32 credentialId,bytes32 issuer,bytes32 reasonCode,uint64 signedAt)";
const ZERO_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";
const coder = AbiCoder.defaultAbiCoder();

// ---------------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------------

export interface CredentialEvent {
  version: number;
  issuer: Hex;
  externalCredentialId: Hex;
  credentialHash: Hex;
  subjectCommitment: Hex;
  schemaId: Hex;
  signedAt: bigint;
  validUntil: bigint;
  submitter: Hex;
}

export interface CredentialRevocation {
  version: number;
  credentialId: Hex;
  issuer: Hex;
  /** Issuer-defined reason; `0x00…00` = unspecified. */
  reasonCode: Hex;
  signedAt: bigint;
}

interface Derived {
  credentialId: Hex;
  /** EIP-712 digest that was signed; the deduplication key of HCS messages. */
  digest: Hex;
  /** Address recovered from the signature. Whether it is authorized is decided by the registry (or the audit). */
  signer: Hex;
}

export type CredentialMessage =
  | { kind: "issuance"; event: CredentialEvent; signature: Hex; derived: Derived }
  | { kind: "revocation"; revocation: CredentialRevocation; signature: Hex; derived: Derived };

export type CredentialMessageInput =
  | { kind: "issuance"; event: unknown; signature: string }
  | { kind: "revocation"; revocation: unknown; signature: string };

// ---------------------------------------------------------------------------------------------------------------------
// Identifiers and digests
// ---------------------------------------------------------------------------------------------------------------------

/** `keccak256(abi.encode(CREDENTIAL_KEY_TAG, issuer, externalCredentialId))`, as `CredentialRegistry.computeCredentialId`. */
export function computeCredentialId(issuer: string, externalCredentialId: string): Hex {
  return keccak256(
    coder.encode(["bytes32", "bytes32", "bytes32"], [CREDENTIAL_KEY_TAG, issuer, externalCredentialId]),
  ) as Hex;
}

/** EIP-712 domain of a `CredentialRegistry` deployment. */
export function credentialDomain(domain: SigningDomain) {
  return {
    name: CREDENTIAL_EIP712_NAME,
    version: CREDENTIAL_EIP712_VERSION,
    chainId: BigInt(domain.chainId),
    verifyingContract: domain.verifyingContract,
  };
}

export function computeCredentialDigest(event: CredentialEvent, domain: SigningDomain): Hex {
  return TypedDataEncoder.hash(credentialDomain(domain), CREDENTIAL_EVENT_TYPES, event) as Hex;
}

export function computeRevocationDigest(revocation: CredentialRevocation, domain: SigningDomain): Hex {
  return TypedDataEncoder.hash(credentialDomain(domain), CREDENTIAL_REVOCATION_TYPES, revocation) as Hex;
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------------

function checkVersion(value: unknown, supported: number, issues: EnvelopeIssue[]): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    issues.push({ field: "version", code: "INVALID_FORMAT", message: "version must be an integer." });
  } else if (value !== supported) {
    issues.push({
      field: "version",
      code: "UNSUPPORTED_VERSION",
      message: `Unsupported version ${value}; this SDK supports ${supported}.`,
    });
  }
  return supported;
}

/** Structure checks of `CredentialRegistry.issue` (check #2) that need no state. Reports every problem at once. */
export function validateCredentialEvent(input: unknown): EnvelopeResult<CredentialEvent> {
  if (typeof input !== "object" || input === null) {
    return { ok: false, issues: [{ field: "event", code: "REQUIRED", message: "event must be an object." }] };
  }
  const e = input as Record<string, unknown>;
  const issues: EnvelopeIssue[] = [];
  const version = checkVersion(e.version, CREDENTIAL_EVENT_VERSION, issues);
  const issuer = parseBytes32(e.issuer, "issuer", issues, true);
  const externalCredentialId = parseBytes32(e.externalCredentialId, "externalCredentialId", issues, true);
  const credentialHash = parseBytes32(e.credentialHash, "credentialHash", issues, true);
  const subjectCommitment = parseBytes32(e.subjectCommitment, "subjectCommitment", issues, true);
  const schemaId = parseBytes32(e.schemaId, "schemaId", issues, true);
  const signedAt = parseUint64(e.signedAt, "signedAt", issues);
  const validUntil = parseUint64(e.validUntil, "validUntil", issues);
  if (validUntil <= signedAt) {
    issues.push({ field: "validUntil", code: "INCONSISTENT", message: "validUntil must be later than signedAt." });
  }
  let submitter = ZERO_ADDRESS;
  if (typeof e.submitter !== "string" || !isHexString(e.submitter, 20)) {
    issues.push({
      field: "submitter",
      code: e.submitter === undefined ? "REQUIRED" : "INVALID_FORMAT",
      message: "submitter must be a 20-byte EVM address (use the zero address to allow any caller).",
    });
  } else {
    try {
      submitter = getAddress(e.submitter).toLowerCase() as Hex;
    } catch {
      issues.push({ field: "submitter", code: "INVALID_FORMAT", message: "submitter has an invalid EIP-55 checksum." });
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      version,
      issuer,
      externalCredentialId,
      credentialHash,
      subjectCommitment,
      schemaId,
      signedAt,
      validUntil,
      submitter,
    },
  };
}

export function validateCredentialRevocation(input: unknown): EnvelopeResult<CredentialRevocation> {
  if (typeof input !== "object" || input === null) {
    return {
      ok: false,
      issues: [{ field: "revocation", code: "REQUIRED", message: "revocation must be an object." }],
    };
  }
  const r = input as Record<string, unknown>;
  const issues: EnvelopeIssue[] = [];
  const version = checkVersion(r.version, CREDENTIAL_REVOCATION_VERSION, issues);
  const credentialId = parseBytes32(r.credentialId, "credentialId", issues, true);
  const issuer = parseBytes32(r.issuer, "issuer", issues, true);
  const reasonCode = parseBytes32(r.reasonCode, "reasonCode", issues, false);
  const signedAt = parseUint64(r.signedAt, "signedAt", issues);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { version, credentialId, issuer, reasonCode, signedAt } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Build, encode, decode
// ---------------------------------------------------------------------------------------------------------------------

/** Validates, derives `credentialId` and the digest, and recovers the signer. Deterministic. */
export function buildCredentialMessage(
  input: CredentialMessageInput,
  domain: SigningDomain,
): EnvelopeResult<CredentialMessage> {
  const issues: EnvelopeIssue[] = [];
  const body =
    input.kind === "issuance" ? validateCredentialEvent(input.event) : validateCredentialRevocation(input.revocation);
  if (!body.ok) issues.push(...body.issues);
  const signature = validateSignature(input.signature);
  if (!signature.ok) issues.push(...signature.issues);
  const dom = validateDomain(domain);
  if (!dom.ok) issues.push(...dom.issues);
  if (!body.ok || !signature.ok || !dom.ok) return { ok: false, issues };

  let digest: Hex;
  let credentialId: Hex;
  if (input.kind === "issuance") {
    const event = body.value as CredentialEvent;
    digest = computeCredentialDigest(event, dom.value);
    credentialId = computeCredentialId(event.issuer, event.externalCredentialId);
  } else {
    const revocation = body.value as CredentialRevocation;
    digest = computeRevocationDigest(revocation, dom.value);
    credentialId = revocation.credentialId;
  }
  let signer: Hex;
  try {
    signer = recoverAddress(digest, signature.value).toLowerCase() as Hex;
  } catch {
    return {
      ok: false,
      issues: [{ field: "signature", code: "INVALID_FORMAT", message: "signature does not recover to an address." }],
    };
  }
  const derived = { credentialId, digest, signer };
  return input.kind === "issuance"
    ? {
        ok: true,
        value: { kind: "issuance", event: body.value as CredentialEvent, signature: signature.value, derived },
      }
    : {
        ok: true,
        value: {
          kind: "revocation",
          revocation: body.value as CredentialRevocation,
          signature: signature.value,
          derived,
        },
      };
}

/** Serializes to the HCS message bytes. Deterministic. */
export function encodeCredentialMessage(
  message:
    | { kind: "issuance"; event: CredentialEvent; signature: string }
    | { kind: "revocation"; revocation: CredentialRevocation; signature: string },
): Uint8Array {
  const abi =
    message.kind === "issuance"
      ? coder.encode(
          [EVENT_TUPLE],
          [
            [
              message.event.version,
              message.event.issuer,
              message.event.externalCredentialId,
              message.event.credentialHash,
              message.event.subjectCommitment,
              message.event.schemaId,
              message.event.signedAt,
              message.event.validUntil,
              message.event.submitter,
            ],
          ],
        )
      : coder.encode(
          [REVOCATION_TUPLE],
          [
            [
              message.revocation.version,
              message.revocation.credentialId,
              message.revocation.issuer,
              message.revocation.reasonCode,
              message.revocation.signedAt,
            ],
          ],
        );
  const body = getBytes(abi);
  const signature = getBytes(message.signature);
  const out = new Uint8Array(1 + body.length + signature.length);
  out[0] = CREDENTIAL_MESSAGE_KIND[message.kind];
  out.set(body, 1);
  out.set(signature, 1 + body.length);
  return out;
}

/**
 * Decodes a credential message (e.g. fetched from the Mirror Node) and derives its identifiers for the given registry
 * domain. Strict: only the canonical encoding is accepted, so trailing bytes or non-canonical offsets fail.
 */
export function decodeCredentialMessage(message: Uint8Array, domain: SigningDomain): EnvelopeResult<CredentialMessage> {
  const fail = (code: "INVALID_FORMAT" | "UNSUPPORTED_VERSION", m: string): EnvelopeResult<CredentialMessage> => ({
    ok: false,
    issues: [{ field: "message", code, message: m }],
  });
  if (message.length < 1 + 32 + SIGNATURE_LENGTH) return fail("INVALID_FORMAT", "message is too short.");
  const kind = (Object.keys(CREDENTIAL_MESSAGE_KIND) as CredentialMessageKind[]).find(
    k => CREDENTIAL_MESSAGE_KIND[k] === message[0],
  );
  if (!kind) {
    return fail(
      "UNSUPPORTED_VERSION",
      `0x${message[0].toString(16).padStart(2, "0")} is not a credential message kind.`,
    );
  }
  const abi = message.slice(1, message.length - SIGNATURE_LENGTH);
  const signature = hexlify(message.slice(message.length - SIGNATURE_LENGTH));
  let built: EnvelopeResult<CredentialMessage>;
  try {
    if (kind === "issuance") {
      const d = coder.decode([EVENT_TUPLE], abi)[0];
      const event = {
        version: Number(d[0]),
        issuer: d[1],
        externalCredentialId: d[2],
        credentialHash: d[3],
        subjectCommitment: d[4],
        schemaId: d[5],
        signedAt: d[6],
        validUntil: d[7],
        submitter: d[8],
      };
      built = buildCredentialMessage({ kind, event, signature }, domain);
    } else {
      const d = coder.decode([REVOCATION_TUPLE], abi)[0];
      const revocation = { version: Number(d[0]), credentialId: d[1], issuer: d[2], reasonCode: d[3], signedAt: d[4] };
      built = buildCredentialMessage({ kind, revocation, signature }, domain);
    }
  } catch {
    return fail("INVALID_FORMAT", `message does not contain a valid ABI-encoded credential ${kind}.`);
  }
  if (!built.ok) return built;
  const canonical = encodeCredentialMessage(built.value);
  if (canonical.length !== message.length || canonical.some((byte, i) => byte !== message[i])) {
    return fail("INVALID_FORMAT", "message is not in canonical encoding.");
  }
  return built;
}
