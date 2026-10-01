/**
 * Credential data model and identity rules: how a credential document becomes the identifiers and commitments that go
 * on-chain (`issuer`, `schemaId`, `externalCredentialId`, `credentialId`, `subjectCommitment`, `credentialHash`).
 *
 * Normative source: docs/credential-schema.md (#38, part of ADR-002). This module is pure: no I/O, no clock, no network
 * (except {@link generateSubjectSalt}, the only source of randomness, which callers run once per credential). The same
 * document always yields the same identifiers. Nothing here hashes JSON: every value is ABI-encoded from typed fields.
 *
 * `credentialId` itself is computed by `../hcs/credential-envelope` (`computeCredentialId`), the single implementation
 * shared with the registry and the audit.
 */
import { AbiCoder, getAddress, hexlify, isHexString, keccak256, toUtf8Bytes, ZeroHash } from "ethers";
import { CREDENTIAL_EVENT_VERSION, computeCredentialId } from "../hcs/credential-envelope";
import type { CredentialEvent } from "../hcs/credential-envelope";
import { parseBytes32, parseUint64 } from "../hcs/envelope";
import type { EnvelopeIssue, EnvelopeResult, Hex } from "../hcs/envelope";

// ---------------------------------------------------------------------------------------------------------------------
// Constants. Changing any of them changes every identifier derived from them: a breaking change.
// ---------------------------------------------------------------------------------------------------------------------

/** Version of the off-chain {@link CredentialDocument} format. */
export const CREDENTIAL_DOCUMENT_VERSION = 1;

export const EXTERNAL_CREDENTIAL_ID_TAG = keccak256(toUtf8Bytes("hedera-verifiable-credentials.external-id.v1"));
export const SUBJECT_COMMITMENT_TAG = keccak256(toUtf8Bytes("hedera-verifiable-credentials.subject.v1"));
export const CREDENTIAL_CONTENT_TAG = keccak256(toUtf8Bytes("hedera-verifiable-credentials.content.v1"));

export const CLAIM_TYPES = ["string", "bytes32", "bool", "uint64", "uint256", "address"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

export const MAX_ISSUER_NAME_BYTES = 64;
export const MAX_REFERENCE_BYTES = 128;
export const MAX_SUBJECT_ID_BYTES = 256;
export const MAX_CLAIM_STRING_BYTES = 1024;
export const MAX_SCHEMA_FIELDS = 32;

/** Lowercase ASCII words separated by single `.` or `-` (issuer namespaces). */
const ISSUER_NAME = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
/** Lowercase ASCII words separated by single `-` (schema names, subject id types). */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/;
const DESCRIPTOR = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.v([1-9][0-9]*)\((.*)\)$/;
const UINT256_MAX = (1n << 256n) - 1n;
const coder = AbiCoder.defaultAbiCoder();

// ---------------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------------

export interface SchemaField {
  name: string;
  type: ClaimType;
}

/**
 * A credential type: participation in an event, a course, a professional certification, a diploma, a badge… Its
 * identity is the descriptor `<name>.v<version>(<type> <field>,…)`, so the claim layout is part of `schemaId`.
 */
export interface CredentialSchema {
  name: string;
  version: number;
  fields: SchemaField[];
}

/** The holder's identifier, committed with a per-credential salt. Never published. */
export interface CredentialSubject {
  /** Kind of identifier, e.g. `email`, `cpf`, `employee-id`, `did`. */
  idType: string;
  /** The identifier, already normalized by the issuer for its type (e.g. lowercase e-mail). Hashed exactly as given. */
  idValue: string;
  /** 32 random bytes, unique per credential (see {@link generateSubjectSalt}). */
  salt: string;
}

/**
 * Off-chain credential document: everything a verifier needs to recompute the on-chain identifiers. It may be
 * transported as JSON, but it is never hashed as JSON; uint64 values may be `bigint`, safe integers or decimal strings.
 */
export interface CredentialDocument {
  version: number;
  /** Issuer namespace name, e.g. `acme-university`. `issuer = keccak256(bytes(name))`. */
  issuer: string;
  /** Schema descriptor, e.g. `course-completion.v1(string courseCode,string courseName,uint64 completedOn,uint64 hours)`. */
  schema: string;
  /** The issuer's permanent, unique reference of this credential (serial number, enrollment id). No PII. */
  reference: string;
  subject: CredentialSubject;
  /** Unix seconds: when the issuer granted the credential (the date printed on it). */
  issuedAt: bigint | number | string;
  /** Unix seconds; `0` = never expires. */
  expiresAt: bigint | number | string;
  /** Exactly the schema's fields, no more and no fewer. */
  claims: Record<string, unknown>;
}

/**
 * The credential model (ADR-002 `CredentialEvent`): what identifies and commits to a credential. Everything here except
 * `issuedAt`/`expiresAt` is public on-chain; those two are committed inside `credentialHash`.
 */
export interface CredentialModel {
  issuer: Hex;
  credentialId: Hex;
  externalCredentialId: Hex;
  credentialHash: Hex;
  subjectCommitment: Hex;
  schemaId: Hex;
  issuedAt: bigint;
  /** `0n` = never expires. */
  expiresAt: bigint;
  /** Off-chain only: `keccak256(abi.encode(<claims in schema order>))`. */
  claimsHash: Hex;
}

/** Signing parameters of one issuance message; not part of the credential's identity or content. */
export interface IssuanceWindow {
  signedAt: bigint;
  validUntil: bigint;
  /** Zero address = any relayer may submit. */
  submitter: string;
}

export class CredentialSchemaError extends Error {
  constructor(readonly issues: EnvelopeIssue[]) {
    super(issues.map(i => `${i.field}: ${i.message}`).join(" "));
    this.name = "CredentialSchemaError";
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation helpers (collect every issue, never throw)
// ---------------------------------------------------------------------------------------------------------------------

const utf8Length = (value: string) => toUtf8Bytes(value).length;

/** Text that is hashed must have one byte representation: NFC, no surrounding whitespace, bounded length. */
function checkText(value: unknown, field: string, maxBytes: number, issues: EnvelopeIssue[]): string {
  if (typeof value !== "string") {
    issues.push({
      field,
      code: value === undefined || value === null ? "REQUIRED" : "INVALID_FORMAT",
      message: `${field} must be a string.`,
    });
    return "";
  }
  if (value.length === 0) issues.push({ field, code: "REQUIRED", message: `${field} must not be empty.` });
  else if (value.trim() !== value) {
    issues.push({ field, code: "INVALID_FORMAT", message: `${field} must not start or end with whitespace.` });
  } else if (value.normalize("NFC") !== value) {
    issues.push({ field, code: "INVALID_FORMAT", message: `${field} must be Unicode NFC-normalized.` });
  }
  if (utf8Length(value) > maxBytes) {
    issues.push({ field, code: "TOO_LONG", message: `${field} must be at most ${maxBytes} UTF-8 bytes.` });
  }
  return value;
}

function checkPattern(value: unknown, field: string, pattern: RegExp, maxBytes: number, issues: EnvelopeIssue[]) {
  const before = issues.length;
  const text = checkText(value, field, maxBytes, issues);
  if (issues.length === before && !pattern.test(text)) {
    issues.push({ field, code: "INVALID_FORMAT", message: `${field} must match ${pattern}.` });
  }
  return text;
}

function assertValid(issues: EnvelopeIssue[]): void {
  if (issues.length > 0) throw new CredentialSchemaError(issues);
}

// ---------------------------------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------------------------------

function checkSchema(schema: CredentialSchema, issues: EnvelopeIssue[], field = "schema"): void {
  checkPattern(schema.name, `${field}.name`, SLUG, 64, issues);
  if (!Number.isSafeInteger(schema.version) || schema.version < 1) {
    issues.push({ field: `${field}.version`, code: "OUT_OF_RANGE", message: "version must be an integer ≥ 1." });
  }
  if (!Array.isArray(schema.fields) || schema.fields.length === 0 || schema.fields.length > MAX_SCHEMA_FIELDS) {
    issues.push({
      field: `${field}.fields`,
      code: "OUT_OF_RANGE",
      message: `a schema has 1 to ${MAX_SCHEMA_FIELDS} fields.`,
    });
    return;
  }
  const seen = new Set<string>();
  schema.fields.forEach((f, i) => {
    if (typeof f.name !== "string" || !FIELD_NAME.test(f.name) || f.name.length > 64) {
      issues.push({
        field: `${field}.fields[${i}]`,
        code: "INVALID_FORMAT",
        message: `field name must match ${FIELD_NAME}.`,
      });
    } else if (seen.has(f.name)) {
      issues.push({ field: `${field}.fields[${i}]`, code: "INCONSISTENT", message: `duplicate field "${f.name}".` });
    }
    seen.add(f.name);
    if (!CLAIM_TYPES.includes(f.type)) {
      issues.push({
        field: `${field}.fields[${i}]`,
        code: "INVALID_FORMAT",
        message: `type must be one of ${CLAIM_TYPES.join(", ")}.`,
      });
    }
  });
}

/** `<name>.v<version>(<type> <field>,…)`, the canonical text whose hash is `schemaId`. */
export function schemaDescriptor(schema: CredentialSchema): string {
  const issues: EnvelopeIssue[] = [];
  checkSchema(schema, issues);
  assertValid(issues);
  return `${schema.name}.v${schema.version}(${schema.fields.map(f => `${f.type} ${f.name}`).join(",")})`;
}

/** Parses a descriptor. Only the canonical spelling is accepted (single `,`, single space, no padding). */
export function parseSchemaDescriptor(descriptor: unknown): EnvelopeResult<CredentialSchema> {
  const fail = (message: string): EnvelopeResult<CredentialSchema> => ({
    ok: false,
    issues: [{ field: "schema", code: "INVALID_FORMAT", message }],
  });
  if (typeof descriptor !== "string") return fail("schema must be a descriptor string.");
  const match = DESCRIPTOR.exec(descriptor);
  if (!match) return fail("schema must look like `name.v1(type field,…)`.");
  const fields = match[3] === "" ? [] : match[3].split(",").map(part => part.split(" "));
  if (fields.some(parts => parts.length !== 2)) return fail("each field must be `<type> <name>`.");
  const schema: CredentialSchema = {
    name: match[1],
    version: Number(match[2]),
    fields: fields.map(([type, name]) => ({ type: type as ClaimType, name })),
  };
  const issues: EnvelopeIssue[] = [];
  checkSchema(schema, issues);
  if (issues.length > 0) return { ok: false, issues };
  if (schemaDescriptor(schema) !== descriptor) return fail("schema descriptor is not canonical.");
  return { ok: true, value: schema };
}

/** `schemaId = keccak256(bytes(descriptor))`. Accepts a schema or its canonical descriptor. */
export function computeSchemaId(schema: CredentialSchema | string): Hex {
  if (typeof schema === "string") {
    const parsed = parseSchemaDescriptor(schema);
    if (!parsed.ok) throw new CredentialSchemaError(parsed.issues);
    return keccak256(toUtf8Bytes(schema)) as Hex;
  }
  return keccak256(toUtf8Bytes(schemaDescriptor(schema))) as Hex;
}

// ---------------------------------------------------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------------------------------------------------

/** `issuer = keccak256(bytes(name))`, `name` = lowercase ASCII namespace, as registered in `CredentialRegistry`. */
export function computeIssuerId(name: string): Hex {
  const issues: EnvelopeIssue[] = [];
  checkPattern(name, "issuer", ISSUER_NAME, MAX_ISSUER_NAME_BYTES, issues);
  assertValid(issues);
  return keccak256(toUtf8Bytes(name)) as Hex;
}

/**
 * `externalCredentialId = keccak256(abi.encode(EXTERNAL_CREDENTIAL_ID_TAG, schemaId, reference))`. `reference` is the
 * issuer's permanent unique id of the credential; the schema keeps two credential types of one reference apart.
 */
export function computeExternalCredentialId(schemaId: string, reference: string): Hex {
  const issues: EnvelopeIssue[] = [];
  const id = parseBytes32(schemaId, "schemaId", issues, true);
  checkText(reference, "reference", MAX_REFERENCE_BYTES, issues);
  assertValid(issues);
  return keccak256(coder.encode(["bytes32", "bytes32", "string"], [EXTERNAL_CREDENTIAL_ID_TAG, id, reference])) as Hex;
}

function checkSubject(subject: unknown, issues: EnvelopeIssue[]): CredentialSubject {
  if (typeof subject !== "object" || subject === null) {
    issues.push({ field: "subject", code: "REQUIRED", message: "subject must be an object." });
    return { idType: "", idValue: "", salt: ZeroHash };
  }
  const s = subject as Record<string, unknown>;
  const idType = checkPattern(s.idType, "subject.idType", SLUG, 32, issues);
  const idValue = checkText(s.idValue, "subject.idValue", MAX_SUBJECT_ID_BYTES, issues);
  const salt = parseBytes32(s.salt, "subject.salt", issues, true);
  return { idType, idValue, salt };
}

/**
 * `subjectCommitment = keccak256(abi.encode(SUBJECT_COMMITMENT_TAG, salt, idType, idValue))`. Without the salt the
 * commitment reveals nothing about the holder and two credentials of one holder are unlinkable.
 */
export function computeSubjectCommitment(subject: CredentialSubject): Hex {
  const issues: EnvelopeIssue[] = [];
  const s = checkSubject(subject, issues);
  assertValid(issues);
  return keccak256(
    coder.encode(["bytes32", "bytes32", "string", "string"], [SUBJECT_COMMITMENT_TAG, s.salt, s.idType, s.idValue]),
  ) as Hex;
}

/** 32 random bytes for {@link CredentialSubject.salt}. The only non-deterministic step: run once, store in the document. */
export function generateSubjectSalt(): Hex {
  return hexlify(globalThis.crypto.getRandomValues(new Uint8Array(32))) as Hex;
}

// ---------------------------------------------------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------------------------------------------------

function checkClaim(type: ClaimType, value: unknown, field: string, issues: EnvelopeIssue[]): unknown {
  switch (type) {
    case "string":
      return checkText(value, field, MAX_CLAIM_STRING_BYTES, issues);
    case "bytes32":
      return parseBytes32(value, field, issues, false);
    case "uint64":
      return parseUint64(value, field, issues);
    case "bool":
      if (typeof value !== "boolean")
        issues.push({ field, code: "INVALID_FORMAT", message: `${field} must be a boolean.` });
      return value === true;
    case "uint256": {
      let parsed: bigint | null = null;
      if (typeof value === "bigint") parsed = value;
      else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
      else if (typeof value === "string" && /^\d+$/.test(value)) parsed = BigInt(value);
      if (parsed === null || parsed < 0n || parsed > UINT256_MAX) {
        issues.push({ field, code: "INVALID_FORMAT", message: `${field} must be an unsigned 256-bit integer.` });
        return 0n;
      }
      return parsed;
    }
    case "address":
      if (typeof value !== "string" || !isHexString(value, 20)) {
        issues.push({ field, code: "INVALID_FORMAT", message: `${field} must be a 20-byte EVM address.` });
        return ZeroHash.slice(0, 42);
      }
      try {
        return getAddress(value);
      } catch {
        issues.push({ field, code: "INVALID_FORMAT", message: `${field} has an invalid EIP-55 checksum.` });
        return ZeroHash.slice(0, 42);
      }
  }
}

function checkClaims(schema: CredentialSchema, claims: unknown, issues: EnvelopeIssue[]): unknown[] {
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
    issues.push({ field: "claims", code: "REQUIRED", message: "claims must be an object." });
    return [];
  }
  const c = claims as Record<string, unknown>;
  const known = new Set(schema.fields.map(f => f.name));
  for (const key of Object.keys(c)) {
    if (!known.has(key)) {
      issues.push({ field: `claims.${key}`, code: "INCONSISTENT", message: `"${key}" is not a field of the schema.` });
    }
  }
  return schema.fields.map(f => checkClaim(f.type, c[f.name], `claims.${f.name}`, issues));
}

/** `claimsHash = keccak256(abi.encode(<claim values, in schema field order, with the schema's types>))`. */
export function computeClaimsHash(schema: CredentialSchema, claims: Record<string, unknown>): Hex {
  const issues: EnvelopeIssue[] = [];
  checkSchema(schema, issues);
  const values = issues.length === 0 ? checkClaims(schema, claims, issues) : [];
  assertValid(issues);
  return keccak256(
    coder.encode(
      schema.fields.map(f => f.type),
      values,
    ),
  ) as Hex;
}

export interface CredentialContent {
  issuer: string;
  externalCredentialId: string;
  schemaId: string;
  subjectCommitment: string;
  issuedAt: bigint;
  expiresAt: bigint;
  claimsHash: string;
}

/**
 * `credentialHash = keccak256(abi.encode(CREDENTIAL_CONTENT_TAG, issuer, externalCredentialId, schemaId,
 * subjectCommitment, issuedAt, expiresAt, claimsHash))`. Binds the content to its identity and holder, so one document
 * cannot be presented as another credential.
 */
export function computeCredentialHash(content: CredentialContent): Hex {
  const issues: EnvelopeIssue[] = [];
  const v = [
    parseBytes32(content.issuer, "issuer", issues, true),
    parseBytes32(content.externalCredentialId, "externalCredentialId", issues, true),
    parseBytes32(content.schemaId, "schemaId", issues, true),
    parseBytes32(content.subjectCommitment, "subjectCommitment", issues, true),
    parseUint64(content.issuedAt, "issuedAt", issues),
    parseUint64(content.expiresAt, "expiresAt", issues),
    parseBytes32(content.claimsHash, "claimsHash", issues, true),
  ];
  assertValid(issues);
  return keccak256(
    coder.encode(
      ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint64", "uint64", "bytes32"],
      [CREDENTIAL_CONTENT_TAG, ...v],
    ),
  ) as Hex;
}

// ---------------------------------------------------------------------------------------------------------------------
// Document → model
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Validates a credential document and derives its {@link CredentialModel}. Pure and deterministic: the issuer runs it
 * before signing, and any verifier holding the document runs it to check `credentialHash` and `subjectCommitment`
 * against `statusOf(credentialId)`. Reports every problem at once.
 */
export function deriveCredential(document: unknown): EnvelopeResult<CredentialModel> {
  if (typeof document !== "object" || document === null) {
    return { ok: false, issues: [{ field: "document", code: "REQUIRED", message: "document must be an object." }] };
  }
  const d = document as Record<string, unknown>;
  const issues: EnvelopeIssue[] = [];
  if (d.version !== CREDENTIAL_DOCUMENT_VERSION) {
    issues.push({
      field: "version",
      code: "UNSUPPORTED_VERSION",
      message: `Unsupported document version; this SDK supports ${CREDENTIAL_DOCUMENT_VERSION}.`,
    });
  }
  const issuerName = checkPattern(d.issuer, "issuer", ISSUER_NAME, MAX_ISSUER_NAME_BYTES, issues);
  const schema = parseSchemaDescriptor(d.schema);
  if (!schema.ok) issues.push(...schema.issues);
  const reference = checkText(d.reference, "reference", MAX_REFERENCE_BYTES, issues);
  const subject = checkSubject(d.subject, issues);
  const beforeDates = issues.length;
  const issuedAt = parseUint64(d.issuedAt, "issuedAt", issues);
  const expiresAt = parseUint64(d.expiresAt, "expiresAt", issues);
  const datesParsed = issues.length === beforeDates;
  if (datesParsed && issuedAt === 0n) {
    issues.push({ field: "issuedAt", code: "ZERO_NOT_ALLOWED", message: "issuedAt must not be zero." });
  }
  if (datesParsed && expiresAt !== 0n && expiresAt <= issuedAt) {
    issues.push({ field: "expiresAt", code: "INCONSISTENT", message: "expiresAt must be 0 or later than issuedAt." });
  }
  if (schema.ok) checkClaims(schema.value, d.claims, issues);
  if (issues.length > 0 || !schema.ok) return { ok: false, issues };

  const issuer = computeIssuerId(issuerName);
  const schemaId = computeSchemaId(d.schema as string);
  const externalCredentialId = computeExternalCredentialId(schemaId, reference);
  const subjectCommitment = computeSubjectCommitment(subject);
  const claimsHash = computeClaimsHash(schema.value, d.claims as Record<string, unknown>);
  const credentialHash = computeCredentialHash({
    issuer,
    externalCredentialId,
    schemaId,
    subjectCommitment,
    issuedAt,
    expiresAt,
    claimsHash,
  });
  return {
    ok: true,
    value: {
      issuer,
      credentialId: computeCredentialId(issuer, externalCredentialId),
      externalCredentialId,
      credentialHash,
      subjectCommitment,
      schemaId,
      issuedAt,
      expiresAt,
      claimsHash,
    },
  };
}

/** The v1 signed wire struct (`CredentialRegistry.issue`, HCS issuance message) carrying a credential model. */
export function toCredentialEvent(model: CredentialModel, window: IssuanceWindow): CredentialEvent {
  return {
    version: CREDENTIAL_EVENT_VERSION,
    issuer: model.issuer,
    externalCredentialId: model.externalCredentialId,
    credentialHash: model.credentialHash,
    subjectCommitment: model.subjectCommitment,
    schemaId: model.schemaId,
    signedAt: window.signedAt,
    validUntil: window.validUntil,
    submitter: getAddress(window.submitter).toLowerCase() as Hex,
  };
}

/** Whether a credential model is past its `expiresAt` at `nowSeconds`. Independent of the on-chain status. */
export function isCredentialExpired(model: Pick<CredentialModel, "expiresAt">, nowSeconds: bigint): boolean {
  return model.expiresAt !== 0n && nowSeconds >= model.expiresAt;
}
