/**
 * HCS evidence envelope: the formal, versioned wire format of a settlement attestation published to HCS.
 *
 * Normative source: ADR-001 (docs/architecture.md) §6.1 (`SettlementEvent`), §6.3 (message format) and §4.3
 * (identifiers). This module is pure: no I/O, no clock, no Hedera SDK. It is the ONLY place that knows how to build,
 * validate, encode and decode the message; the publisher (#6), the Mirror audit (#10) and the console (#12) must reuse
 * it instead of re-deriving the format.
 *
 * Wire format (binary, no JSON canonicalization):
 *
 *     message = 0x01 || abi.encode(SettlementEvent) || signature (65 bytes: r || s || v)
 *
 * Nothing derived is stored in the message. `eventKey`, `settlementId`, `contentHash`, `attestationDigest` and `signer`
 * are recomputed by every reader, so the message cannot disagree with itself.
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
  sha256,
  toUtf8Bytes,
  ZeroHash,
} from "ethers";

// ---------------------------------------------------------------------------------------------------------------------
// Constants (ADR §6.1–§6.3). Changing any of them is a breaking change of the envelope.
// ---------------------------------------------------------------------------------------------------------------------

/** First byte of every HCS message: the version of the message format (not of the event). */
export const HCS_MESSAGE_FORMAT_VERSION = 1;
/** `SettlementEvent.version` supported by this format version. */
export const SETTLEMENT_EVENT_VERSION = 1;
/** Maximum length of `SettlementEvent.data`, in bytes (ADR §6.2). */
export const MAX_DATA_LEN = 512;
export const SIGNATURE_LENGTH = 65;
/** Maximum size of one HCS message on Hedera, in bytes. */
export const HCS_MAX_MESSAGE_BYTES = 1024;

export const EIP712_DOMAIN_NAME = "HederaVerifiableSettlement";
export const EIP712_DOMAIN_VERSION = "1";

/** Exact EIP-712 type string of the event (ADR §6.1). A test pins the SDK types to this string. */
export const SETTLEMENT_EVENT_TYPE_STRING =
  "SettlementEvent(uint16 version,bytes32 eventSource,bytes32 externalEventId,bytes32 streamId,uint64 streamSeq,uint64 observedAt,uint64 validUntil,address submitter,bytes32 policyId,bytes data)";

/**
 * Type string of the content hash. ADR §4.3 names `CONTENT_TYPEHASH` but does not spell the string out; this is the
 * proposal. SettlementRouter (#9) MUST use the same string, or this single constant must change (see docs/hcs-envelope.md).
 */
export const CONTENT_TYPE_STRING =
  "SettlementContent(bytes32 eventSource,bytes32 externalEventId,bytes32 streamId,uint64 streamSeq,bytes32 policyId,bytes32 dataHash)";

export const EVENT_KEY_TAG = keccak256(toUtf8Bytes("hedera-verifiable-settlement.event.v1"));
export const SETTLEMENT_TAG = keccak256(toUtf8Bytes("hedera-verifiable-settlement.settlement.v1"));
export const CONTENT_TYPEHASH = keccak256(toUtf8Bytes(CONTENT_TYPE_STRING));

const EVENT_TUPLE =
  "tuple(uint16 version,bytes32 eventSource,bytes32 externalEventId,bytes32 streamId,uint64 streamSeq,uint64 observedAt,uint64 validUntil,address submitter,bytes32 policyId,bytes data)";

/** EIP-712 types of the event. The oracle adapter (#8) signs with exactly these. */
export const SETTLEMENT_EVENT_TYPES = {
  SettlementEvent: [
    { name: "version", type: "uint16" },
    { name: "eventSource", type: "bytes32" },
    { name: "externalEventId", type: "bytes32" },
    { name: "streamId", type: "bytes32" },
    { name: "streamSeq", type: "uint64" },
    { name: "observedAt", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "submitter", type: "address" },
    { name: "policyId", type: "bytes32" },
    { name: "data", type: "bytes" },
  ],
};

const UINT64_MAX = (1n << 64n) - 1n;
/** secp256k1 group order / 2: signatures with a larger `s` are malleable and rejected (ADR §4.8). */
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const coder = AbiCoder.defaultAbiCoder();

// ---------------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------------

/** `0x`-prefixed lowercase hex. */
export type Hex = `0x${string}`;

/**
 * Canonical event, as encoded on the wire. Field order and names are those of ADR §6.1. uint64 values are `bigint`.
 */
export interface SettlementEvent {
  version: number;
  eventSource: Hex;
  externalEventId: Hex;
  /** `0x00…00` = unordered stream. */
  streamId: Hex;
  streamSeq: bigint;
  /** Unix seconds: when the oracle observed the fact. */
  observedAt: bigint;
  /** Unix seconds: attestation expiry. */
  validUntil: bigint;
  /** `0x00…00` address = any caller may submit. */
  submitter: Hex;
  policyId: Hex;
  data: Hex;
}

/** Loose input accepted by {@link buildEnvelope}: numbers and decimal strings are normalized to `bigint`. */
export interface SettlementEventInput {
  version: number;
  eventSource: string;
  externalEventId: string;
  streamId: string;
  streamSeq: bigint | number | string;
  observedAt: bigint | number | string;
  validUntil: bigint | number | string;
  submitter: string;
  policyId: string;
  data: string;
}

/** Where the attestation is bound: the EIP-712 domain of the deployed `SettlementRouter` (ADR §6.1). */
export interface SigningDomain {
  chainId: bigint | number;
  /** EVM address of the `SettlementRouter`. */
  verifyingContract: string;
}

/** Values every reader recomputes from the message (ADR §4.3). */
export interface DerivedIdentifiers {
  /** Idempotency key: identity of the external event. Not bound to a chain. */
  eventKey: Hex;
  /** Global identity of the settlement instance (bound to chain and router). */
  settlementId: Hex;
  /** Business content: detects different facts for the same `eventKey`. */
  contentHash: Hex;
  /** EIP-712 digest that was signed; the deduplication key of HCS messages (ADR §5.5). */
  attestationDigest: Hex;
  /** Address recovered from the signature. Whether it is the *registered* signer is decided by the router. */
  signer: Hex;
}

export interface HcsEnvelope {
  formatVersion: typeof HCS_MESSAGE_FORMAT_VERSION;
  event: SettlementEvent;
  /** 65 bytes, `r || s || v`, low-`s`. */
  signature: Hex;
  derived: DerivedIdentifiers;
}

export type EnvelopeIssueCode =
  | "REQUIRED"
  | "INVALID_FORMAT"
  | "OUT_OF_RANGE"
  | "ZERO_NOT_ALLOWED"
  | "UNSUPPORTED_VERSION"
  | "TOO_LONG"
  | "INCONSISTENT"
  | "MALLEABLE_SIGNATURE"
  | "SIGNER_MISMATCH";

export interface EnvelopeIssue {
  /** Field name, or `signature` / `domain` / `message`. */
  field: string;
  code: EnvelopeIssueCode;
  message: string;
}

export type EnvelopeResult<T> = { ok: true; value: T } | { ok: false; issues: EnvelopeIssue[] };

// ---------------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------------

const is = (value: unknown): value is string => typeof value === "string";

function parseUint64(value: unknown, field: string, issues: EnvelopeIssue[]): bigint {
  let parsed: bigint | null = null;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (is(value) && /^\d+$/.test(value)) parsed = BigInt(value);
  if (parsed === null) {
    issues.push({
      field,
      code: value === undefined || value === null ? "REQUIRED" : "INVALID_FORMAT",
      message: `${field} must be an unsigned integer (bigint, safe integer number or decimal string).`,
    });
    return 0n;
  }
  if (parsed < 0n || parsed > UINT64_MAX) {
    issues.push({ field, code: "OUT_OF_RANGE", message: `${field} must fit in uint64 (0 to ${UINT64_MAX}).` });
    return 0n;
  }
  return parsed;
}

function parseBytes32(value: unknown, field: string, issues: EnvelopeIssue[], nonZero: boolean): Hex {
  if (!is(value) || !isHexString(value, 32)) {
    issues.push({
      field,
      code: value === undefined || value === null ? "REQUIRED" : "INVALID_FORMAT",
      message: `${field} must be a 32-byte hex string (0x + 64 hex characters).`,
    });
    return ZeroHash as Hex;
  }
  const hex = value.toLowerCase() as Hex;
  if (nonZero && hex === ZeroHash) {
    issues.push({ field, code: "ZERO_NOT_ALLOWED", message: `${field} must not be zero.` });
  }
  return hex;
}

/**
 * Validates and normalizes an event. Returns every problem at once so callers can fix them in one pass.
 * Rules are ADR §6.4 check #2 (structure) plus the internal consistency the publisher can decide without state.
 */
export function validateSettlementEvent(input: unknown): EnvelopeResult<SettlementEvent> {
  const issues: EnvelopeIssue[] = [];
  if (typeof input !== "object" || input === null) {
    return { ok: false, issues: [{ field: "event", code: "REQUIRED", message: "event must be an object." }] };
  }
  const e = input as Record<string, unknown>;

  let version = SETTLEMENT_EVENT_VERSION;
  if (typeof e.version !== "number" || !Number.isInteger(e.version)) {
    issues.push({ field: "version", code: "INVALID_FORMAT", message: "version must be an integer." });
  } else if (e.version !== SETTLEMENT_EVENT_VERSION) {
    issues.push({
      field: "version",
      code: "UNSUPPORTED_VERSION",
      message: `Unsupported event version ${e.version}; this SDK supports ${SETTLEMENT_EVENT_VERSION}.`,
    });
  } else {
    version = e.version;
  }

  const eventSource = parseBytes32(e.eventSource, "eventSource", issues, true);
  const externalEventId = parseBytes32(e.externalEventId, "externalEventId", issues, true);
  const streamId = parseBytes32(e.streamId, "streamId", issues, false);
  const policyId = parseBytes32(e.policyId, "policyId", issues, true);
  const streamSeq = parseUint64(e.streamSeq, "streamSeq", issues);
  const observedAt = parseUint64(e.observedAt, "observedAt", issues);
  const validUntil = parseUint64(e.validUntil, "validUntil", issues);

  if (streamId === ZeroHash && streamSeq !== 0n) {
    issues.push({ field: "streamSeq", code: "INCONSISTENT", message: "streamSeq must be 0 when streamId is zero." });
  }
  if (streamId !== ZeroHash && streamSeq === 0n) {
    issues.push({ field: "streamSeq", code: "INCONSISTENT", message: "streamSeq must be >= 1 when streamId is set." });
  }
  if (validUntil <= observedAt) {
    issues.push({ field: "validUntil", code: "INCONSISTENT", message: "validUntil must be later than observedAt." });
  }

  let submitter: Hex = "0x0000000000000000000000000000000000000000";
  if (!is(e.submitter) || !isHexString(e.submitter, 20)) {
    issues.push({
      field: "submitter",
      code: e.submitter === undefined ? "REQUIRED" : "INVALID_FORMAT",
      message: "submitter must be a 20-byte EVM address (use the zero address to allow any caller).",
    });
  } else {
    try {
      submitter = getAddress(e.submitter).toLowerCase() as Hex; // rejects a wrong EIP-55 checksum
    } catch {
      issues.push({ field: "submitter", code: "INVALID_FORMAT", message: "submitter has an invalid EIP-55 checksum." });
    }
  }

  let data: Hex = "0x";
  if (!is(e.data) || !isHexString(e.data) || (e.data.length - 2) % 2 !== 0) {
    issues.push({
      field: "data",
      code: e.data === undefined ? "REQUIRED" : "INVALID_FORMAT",
      message: 'data must be a hex string with an even number of digits (use "0x" for empty).',
    });
  } else if ((e.data.length - 2) / 2 > MAX_DATA_LEN) {
    issues.push({ field: "data", code: "TOO_LONG", message: `data must be at most ${MAX_DATA_LEN} bytes.` });
  } else {
    data = e.data.toLowerCase() as Hex;
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      version,
      eventSource,
      externalEventId,
      streamId,
      streamSeq,
      observedAt,
      validUntil,
      submitter,
      policyId,
      data,
    },
  };
}

/** Checks length, recovery id and low-`s` (ADR §4.8). Returns the normalized signature. */
export function validateSignature(value: unknown): EnvelopeResult<Hex> {
  if (!is(value) || !isHexString(value, SIGNATURE_LENGTH)) {
    return {
      ok: false,
      issues: [
        {
          field: "signature",
          code: value === undefined ? "REQUIRED" : "INVALID_FORMAT",
          message: `signature must be ${SIGNATURE_LENGTH} bytes (r || s || v) as a hex string.`,
        },
      ],
    };
  }
  const bytes = getBytes(value);
  const v = bytes[64];
  const s = BigInt(hexlify(bytes.slice(32, 64)));
  if (v !== 27 && v !== 28) {
    return {
      ok: false,
      issues: [{ field: "signature", code: "INVALID_FORMAT", message: "signature recovery id (v) must be 27 or 28." }],
    };
  }
  if (s === 0n || s > SECP256K1_HALF_N) {
    return {
      ok: false,
      issues: [
        { field: "signature", code: "MALLEABLE_SIGNATURE", message: "signature must use a low, non-zero s value." },
      ],
    };
  }
  return { ok: true, value: hexlify(bytes) as Hex };
}

function validateDomain(domain: SigningDomain): EnvelopeResult<{ chainId: bigint; verifyingContract: Hex }> {
  const issues: EnvelopeIssue[] = [];
  let chainId = 0n;
  try {
    chainId = BigInt(domain.chainId);
    if (chainId <= 0n) throw new Error("non-positive");
  } catch {
    issues.push({ field: "domain", code: "INVALID_FORMAT", message: "domain.chainId must be a positive integer." });
  }
  let verifyingContract: Hex = "0x0000000000000000000000000000000000000000";
  try {
    verifyingContract = getAddress(domain.verifyingContract).toLowerCase() as Hex;
    if (/^0x0{40}$/.test(verifyingContract)) throw new Error("zero");
  } catch {
    issues.push({
      field: "domain",
      code: "INVALID_FORMAT",
      message: "domain.verifyingContract must be a non-zero EVM address (the SettlementRouter).",
    });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { chainId, verifyingContract } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Derived identifiers (ADR §4.3)
// ---------------------------------------------------------------------------------------------------------------------

/** `keccak256(abi.encode(EVENT_KEY_TAG, eventSource, externalEventId))` */
export function computeEventKey(eventSource: string, externalEventId: string): Hex {
  return keccak256(
    coder.encode(["bytes32", "bytes32", "bytes32"], [EVENT_KEY_TAG, eventSource, externalEventId]),
  ) as Hex;
}

/** `keccak256(abi.encode(SETTLEMENT_TAG, chainId, router, eventKey))` */
export function computeSettlementId(domain: { chainId: bigint; verifyingContract: string }, eventKey: string): Hex {
  return keccak256(
    coder.encode(
      ["bytes32", "uint256", "address", "bytes32"],
      [SETTLEMENT_TAG, domain.chainId, domain.verifyingContract, eventKey],
    ),
  ) as Hex;
}

export function computeContentHash(event: SettlementEvent): Hex {
  return keccak256(
    coder.encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "uint64", "bytes32", "bytes32"],
      [
        CONTENT_TYPEHASH,
        event.eventSource,
        event.externalEventId,
        event.streamId,
        event.streamSeq,
        event.policyId,
        keccak256(event.data),
      ],
    ),
  ) as Hex;
}

/** The EIP-712 domain object for a router deployment, e.g. for `wallet.signTypedData(eip712Domain(d), SETTLEMENT_EVENT_TYPES, event)`. */
export function eip712Domain(domain: SigningDomain): {
  name: string;
  version: string;
  chainId: bigint;
  verifyingContract: string;
} {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId: BigInt(domain.chainId),
    verifyingContract: domain.verifyingContract,
  };
}

export function computeAttestationDigest(
  event: SettlementEvent,
  domain: { chainId: bigint; verifyingContract: string },
): Hex {
  return TypedDataEncoder.hash(
    { name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, ...domain },
    SETTLEMENT_EVENT_TYPES,
    event,
  ) as Hex;
}

// ---------------------------------------------------------------------------------------------------------------------
// Build, encode, decode
// ---------------------------------------------------------------------------------------------------------------------

export interface BuildEnvelopeOptions {
  /** When set, the recovered signer MUST equal this address (case-insensitive). */
  expectedSigner?: string;
}

/**
 * Validates the event and signature, derives the identifiers and recovers the signer. Deterministic: the same inputs
 * always produce the same envelope and the same bytes.
 */
export function buildEnvelope(
  input: { event: SettlementEventInput | SettlementEvent; signature: string },
  domain: SigningDomain,
  options: BuildEnvelopeOptions = {},
): EnvelopeResult<HcsEnvelope> {
  const issues: EnvelopeIssue[] = [];
  const event = validateSettlementEvent(input.event);
  if (!event.ok) issues.push(...event.issues);
  const signature = validateSignature(input.signature);
  if (!signature.ok) issues.push(...signature.issues);
  const dom = validateDomain(domain);
  if (!dom.ok) issues.push(...dom.issues);
  if (!event.ok || !signature.ok || !dom.ok) return { ok: false, issues };

  const attestationDigest = computeAttestationDigest(event.value, dom.value);
  let signer: Hex;
  try {
    signer = recoverAddress(attestationDigest, signature.value).toLowerCase() as Hex;
  } catch {
    return {
      ok: false,
      issues: [{ field: "signature", code: "INVALID_FORMAT", message: "signature does not recover to an address." }],
    };
  }
  if (options.expectedSigner !== undefined && options.expectedSigner.toLowerCase() !== signer) {
    return {
      ok: false,
      issues: [
        {
          field: "signature",
          code: "SIGNER_MISMATCH",
          message: `signature was not produced by the expected signer (recovered ${signer}). Check the signing domain (chain id and router address) and the signer key.`,
        },
      ],
    };
  }

  const eventKey = computeEventKey(event.value.eventSource, event.value.externalEventId);
  return {
    ok: true,
    value: {
      formatVersion: HCS_MESSAGE_FORMAT_VERSION,
      event: event.value,
      signature: signature.value,
      derived: {
        eventKey,
        settlementId: computeSettlementId(dom.value, eventKey),
        contentHash: computeContentHash(event.value),
        attestationDigest,
        signer,
      },
    },
  };
}

function encodeEvent(event: SettlementEvent): Uint8Array {
  return getBytes(
    coder.encode(
      [EVENT_TUPLE],
      [
        [
          event.version,
          event.eventSource,
          event.externalEventId,
          event.streamId,
          event.streamSeq,
          event.observedAt,
          event.validUntil,
          event.submitter,
          event.policyId,
          event.data,
        ],
      ],
    ),
  );
}

/** Serializes an envelope to the HCS message: `0x01 || abi.encode(event) || signature`. Deterministic. */
export function encodeMessage(envelope: Pick<HcsEnvelope, "event" | "signature">): Uint8Array {
  const abi = encodeEvent(envelope.event);
  const signature = getBytes(envelope.signature);
  const message = new Uint8Array(1 + abi.length + signature.length);
  message[0] = HCS_MESSAGE_FORMAT_VERSION;
  message.set(abi, 1);
  message.set(signature, 1 + abi.length);
  return message;
}

/** SHA-256 of the message bytes; lets an auditor confirm that the message fetched from Mirror is the one published. */
export function messageSha256(message: Uint8Array): Hex {
  return sha256(message) as Hex;
}

/**
 * Decodes an HCS message (e.g. fetched from the Mirror Node by #10) and, given the domain, derives its identifiers.
 * Strict: the message must be byte-for-byte the canonical encoding, so trailing bytes or non-canonical offsets fail.
 */
export function decodeMessage(
  message: Uint8Array,
  domain: SigningDomain,
  options: BuildEnvelopeOptions = {},
): EnvelopeResult<HcsEnvelope> {
  const fail = (m: string): EnvelopeResult<HcsEnvelope> => ({
    ok: false,
    issues: [{ field: "message", code: "INVALID_FORMAT", message: m }],
  });
  if (message.length < 1 + 32 + SIGNATURE_LENGTH) return fail("message is too short.");
  if (message[0] !== HCS_MESSAGE_FORMAT_VERSION) {
    return {
      ok: false,
      issues: [
        {
          field: "message",
          code: "UNSUPPORTED_VERSION",
          message: `Unsupported message format version ${message[0]}; this SDK supports ${HCS_MESSAGE_FORMAT_VERSION}.`,
        },
      ],
    };
  }
  const abi = message.slice(1, message.length - SIGNATURE_LENGTH);
  const signature = hexlify(message.slice(message.length - SIGNATURE_LENGTH));
  let decoded;
  try {
    decoded = coder.decode([EVENT_TUPLE], abi)[0];
  } catch {
    return fail("message does not contain a valid ABI-encoded SettlementEvent.");
  }
  const event = {
    version: Number(decoded[0]),
    eventSource: decoded[1],
    externalEventId: decoded[2],
    streamId: decoded[3],
    streamSeq: decoded[4],
    observedAt: decoded[5],
    validUntil: decoded[6],
    submitter: decoded[7],
    policyId: decoded[8],
    data: decoded[9],
  };
  const built = buildEnvelope({ event, signature }, domain, options);
  if (!built.ok) return built;
  const canonical = encodeMessage(built.value);
  if (canonical.length !== message.length || canonical.some((byte, i) => byte !== message[i])) {
    return fail("message is not in canonical encoding.");
  }
  return built;
}

/** Exact size of the message an envelope will produce: `450 + pad32(len(data))` bytes (ADR §6.3). */
export function messageSize(event: Pick<SettlementEvent, "data">): number {
  const dataLen = (event.data.length - 2) / 2;
  return 450 + Math.ceil(dataLen / 32) * 32;
}
