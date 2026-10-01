/**
 * The issuer console's form layer: which credential schemas it offers, how what an issuer types becomes a
 * `CredentialDocument`, and the drafts of an issuance and a revocation. Pure (no I/O, no clock unless injected) and
 * browser-safe: the console runs it in the browser so personal data never leaves the device.
 *
 * Every identifier and hash comes from `./schema` (`deriveCredential`, `toCredentialEvent`), the single implementation
 * of docs/credential-schema.md (#38). This module only parses form strings into typed document fields; it never
 * hashes. #41 extends it.
 */
import { ZeroAddress, ZeroHash, getAddress, isHexString, keccak256, toUtf8Bytes } from "ethers";
import { CREDENTIAL_REVOCATION_VERSION } from "../hcs/credential-envelope";
import type { CredentialEvent, CredentialRevocation } from "../hcs/credential-envelope";
import type { Hex } from "../hcs/envelope";
import {
  CREDENTIAL_DOCUMENT_VERSION,
  deriveCredential,
  generateSubjectSalt,
  schemaDescriptor,
  toCredentialEvent,
} from "./schema";
import type { CredentialDocument, CredentialSchema } from "./schema";

// ---------------------------------------------------------------------------------------------------------------------
// What the console offers
// ---------------------------------------------------------------------------------------------------------------------

/** How a claim is typed in the form. `date` is `YYYY-MM-DD`, stored as Unix seconds (UTC midnight) in a `uint64`. */
export type ClaimInput = "text" | "date" | "number" | "bytes32";

export interface ClaimField {
  name: string;
  label: string;
  input: ClaimInput;
  /** A concrete example value. */
  placeholder: string;
}

export interface IssuerSchemaPreset {
  /** Canonical descriptor: `schemaId = keccak256(bytes(descriptor))`. */
  descriptor: string;
  label: string;
  schema: CredentialSchema;
  claims: readonly ClaimField[];
  referencePlaceholder: string;
}

function preset(
  label: string,
  name: string,
  claims: readonly (ClaimField & { type: CredentialSchema["fields"][number]["type"] })[],
  referencePlaceholder: string,
): IssuerSchemaPreset {
  const schema: CredentialSchema = { name, version: 1, fields: claims.map(c => ({ name: c.name, type: c.type })) };
  return {
    descriptor: schemaDescriptor(schema),
    label,
    schema,
    claims: claims.map(({ name: field, label: l, input, placeholder }) => ({
      name: field,
      label: l,
      input,
      placeholder,
    })),
    referencePlaceholder,
  };
}

/** The example credential types of docs/credential-schema.md §6, with the same descriptors (so the same `schemaId`). */
export const CREDENTIAL_SCHEMA_PRESETS: readonly IssuerSchemaPreset[] = [
  preset(
    "Event attendance",
    "event-attendance",
    [
      {
        name: "eventName",
        type: "string",
        label: "Event name",
        input: "text",
        placeholder: "Hedera Hackathon São Paulo 2026",
      },
      { name: "eventDate", type: "uint64", label: "Event date", input: "date", placeholder: "2026-09-12" },
      { name: "role", type: "string", label: "Role", input: "text", placeholder: "participant" },
    ],
    "HH-2026-ATT-000123",
  ),
  preset(
    "Course completion",
    "course-completion",
    [
      { name: "courseCode", type: "string", label: "Course code", input: "text", placeholder: "CS-301" },
      { name: "courseName", type: "string", label: "Course name", input: "text", placeholder: "Distributed Ledgers" },
      { name: "completedOn", type: "uint64", label: "Completed on", input: "date", placeholder: "2026-09-21" },
      { name: "hours", type: "uint64", label: "Hours", input: "number", placeholder: "60" },
      { name: "grade", type: "string", label: "Grade", input: "text", placeholder: "A" },
    ],
    "ENR-2026-0042",
  ),
  preset(
    "Professional certification",
    "professional-certification",
    [
      {
        name: "certification",
        type: "string",
        label: "Certification",
        input: "text",
        placeholder: "Cloud Solutions Architect",
      },
      { name: "level", type: "string", label: "Level", input: "text", placeholder: "professional" },
      { name: "examPassedOn", type: "uint64", label: "Exam passed on", input: "date", placeholder: "2026-09-22" },
      {
        name: "examResultHash",
        type: "bytes32",
        label: "Exam result hash",
        input: "bytes32",
        placeholder: "0x4444444444444444444444444444444444444444444444444444444444444444",
      },
    ],
    "CC-ARCH-2026-9F3K",
  ),
];

export const findSchemaPreset = (descriptor: string) =>
  CREDENTIAL_SCHEMA_PRESETS.find(p => p.descriptor === descriptor);

/** Kinds of holder identifier (`subject.idType`), with how the console normalizes each before hashing (spec §4.1). */
export const SUBJECT_ID_TYPES = [
  { name: "email", label: "E-mail", placeholder: "maria.silva@example.com" },
  { name: "cpf", label: "CPF", placeholder: "123.456.789-09" },
  { name: "student-id", label: "Student ID", placeholder: "2026-000777" },
  { name: "employee-id", label: "Employee ID", placeholder: "EMP-00421" },
  { name: "did", label: "DID", placeholder: "did:example:123456789abcdefghi" },
] as const;
export type SubjectIdType = (typeof SUBJECT_ID_TYPES)[number]["name"];

export const REVOCATION_REASONS = [
  { name: "unspecified", label: "Unspecified" },
  { name: "issued_in_error", label: "Issued in error" },
  { name: "superseded", label: "Superseded by a new credential" },
  { name: "holder_request", label: "Requested by the holder" },
  { name: "key_compromise", label: "Issuer key compromise" },
] as const;
export type RevocationReason = (typeof REVOCATION_REASONS)[number]["name"];

/** Bounds of the signed issuance window (`validUntil - signedAt`); the registry caps it per issuer (≤ 30 days). */
export const MIN_SIGNATURE_WINDOW_SECONDS = 60;
export const MAX_SIGNATURE_WINDOW_SECONDS = 30 * 24 * 3600;
export const DEFAULT_SIGNATURE_WINDOW_SECONDS = 600;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CredentialFieldIssue {
  /** Name of the form field (`claims.<name>` for a claim), so a form can show the message next to it. */
  field: string;
  message: string;
}

export type FieldsResult<T> = { ok: true; value: T } | { ok: false; issues: CredentialFieldIssue[] };

// ---------------------------------------------------------------------------------------------------------------------
// Form parsing (no hashing)
// ---------------------------------------------------------------------------------------------------------------------

const clean = (value: string | undefined) => (value ?? "").normalize("NFC").trim();

/** `YYYY-MM-DD` → Unix seconds at UTC midnight; `null` when it is not a real calendar date. */
export function parseIsoDate(value: string): number | null {
  const m = ISO_DATE.exec(value.trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    return null;
  }
  return ms > 0 ? ms / 1000 : null;
}

/**
 * The issuer's normalization of a holder identifier for its type (spec §4.1: `idValue` is hashed exactly as given).
 * E-mail is lowercased; a CPF keeps its 11 digits; everything is NFC and trimmed. `null` when it cannot be valid.
 */
export function normalizeSubjectId(idType: string, value: string): string | null {
  const v = clean(value);
  if (!v) return null;
  if (idType === "email") return /^[^\s@]+@[^\s@]+$/.test(v) ? v.toLowerCase() : null;
  if (idType === "cpf") {
    const digits = v.replace(/[.\-\s]/g, "");
    return /^\d{11}$/.test(digits) ? digits : null;
  }
  return v;
}

export function revocationReasonCode(reason: RevocationReason): Hex {
  return reason === "unspecified" ? (ZeroHash as Hex) : (keccak256(toUtf8Bytes(reason)) as Hex);
}

export function isCredentialId(value: string): boolean {
  return isHexString(value.trim(), 32) && value.trim().toLowerCase() !== ZeroHash;
}

// ---------------------------------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------------------------------

/** What the issuer types. `subjectIdValue` is personal data: it only ever enters the salted commitment. */
export interface CredentialDraftInput {
  /** Registered issuer namespace, e.g. `acme-university`. */
  issuerName: string;
  /** Descriptor of one of {@link CREDENTIAL_SCHEMA_PRESETS}. */
  schema: string;
  reference: string;
  subjectIdType: string;
  subjectIdValue: string;
  /** `YYYY-MM-DD`: the date printed on the credential (`issuedAt`). */
  issuedOn: string;
  /** `YYYY-MM-DD`, or empty for a credential that never expires (`expiresAt = 0`). */
  expiresOn: string;
  /** Raw form values keyed by claim name. */
  claims: Record<string, string>;
  /** `validUntil - signedAt` of this signature; not the credential's expiry. */
  validitySeconds: number;
}

export interface CredentialDraft {
  event: CredentialEvent;
  credentialId: Hex;
  /** Give it to the holder with the credential: it opens `subjectCommitment`. Never stored by the console. */
  subjectSalt: Hex;
  /**
   * The holder's credential document (spec §5), from which any verifier recomputes every identifier. It contains the
   * holder identifier: it exists only in memory, for the issuer to hand to the holder, and is never sent or stored.
   */
  document: CredentialDocument;
}

export interface DraftOptions {
  /** Unix seconds of `signedAt`. */
  nowSeconds: number;
  /**
   * The account that will send `issue` (the connected issuer wallet or the issuer's relayer). Required and never the
   * zero address: the signed event is public on HCS before `issue` runs, so an unpinned event can be front-run with a
   * forged `HcsRef` (docs/security.md T-5/F-1).
   */
  submitter: string;
  /** Fixed salt, for deterministic tests. Defaults to a fresh random one. */
  salt?: Hex;
}

/** Spec field (from `deriveCredential`) → form field. */
function formFieldOf(field: string): string {
  if (field.startsWith("claims.")) return field;
  if (field === "issuer") return "issuerName";
  if (field.startsWith("schema")) return "schema";
  if (field === "subject.idType") return "subjectIdType";
  if (field.startsWith("subject")) return "subjectIdValue";
  if (field === "issuedAt") return "issuedOn";
  if (field === "expiresAt") return "expiresOn";
  return field;
}

/** Normalizes the pin; `null` when it is missing, malformed or the zero address. */
export function pinnedSubmitter(submitter: string | undefined): Hex | null {
  if (!submitter || !isHexString(submitter, 20)) return null;
  try {
    const address = getAddress(submitter).toLowerCase();
    return address === ZeroAddress ? null : (address as Hex);
  } catch {
    return null;
  }
}

/** Validates the form, builds the document and derives the signed event. Reports every problem at once. */
export function buildCredentialDraft(
  input: CredentialDraftInput,
  options: DraftOptions,
): FieldsResult<CredentialDraft> {
  const issues: CredentialFieldIssue[] = [];
  const issuerName = clean(input.issuerName);
  if (!issuerName) issues.push({ field: "issuerName", message: "Enter the registered issuer namespace." });

  const schemaPreset = findSchemaPreset(input.schema);
  if (!schemaPreset) issues.push({ field: "schema", message: "Select a credential schema." });

  const reference = clean(input.reference);
  if (!reference) issues.push({ field: "reference", message: "Enter your permanent credential reference." });

  const idType = SUBJECT_ID_TYPES.some(t => t.name === input.subjectIdType) ? input.subjectIdType : null;
  if (!idType) issues.push({ field: "subjectIdType", message: "Select the kind of holder identifier." });
  const idValue = idType ? normalizeSubjectId(idType, input.subjectIdValue) : clean(input.subjectIdValue) || null;
  if (!idValue) {
    issues.push({
      field: "subjectIdValue",
      message:
        idType === "email"
          ? "Enter the holder's e-mail address (it is hashed, never sent)."
          : idType === "cpf"
            ? "Enter the holder's CPF: 11 digits (it is hashed, never sent)."
            : "Enter the holder identifier (it is hashed, never sent).",
    });
  }

  const issuedAt = parseIsoDate(input.issuedOn ?? "");
  if (issuedAt === null) issues.push({ field: "issuedOn", message: "Enter the issue date as YYYY-MM-DD." });
  let expiresAt = 0;
  if (clean(input.expiresOn)) {
    const parsed = parseIsoDate(input.expiresOn);
    if (parsed === null)
      issues.push({ field: "expiresOn", message: "Enter the expiry date as YYYY-MM-DD, or leave it empty." });
    else expiresAt = parsed;
  }

  const claims: Record<string, string | number> = {};
  for (const field of schemaPreset?.claims ?? []) {
    const raw = clean(input.claims?.[field.name]);
    const key = `claims.${field.name}`;
    if (!raw) {
      issues.push({ field: key, message: `Enter ${field.label.toLowerCase()}.` });
      continue;
    }
    if (field.input === "date") {
      const seconds = parseIsoDate(raw);
      if (seconds === null) issues.push({ field: key, message: `Enter ${field.label.toLowerCase()} as YYYY-MM-DD.` });
      else claims[field.name] = seconds;
    } else if (field.input === "number") {
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
        issues.push({ field: key, message: `${field.label} must be a whole number.` });
      } else claims[field.name] = Number(raw);
    } else if (field.input === "bytes32") {
      if (!isHexString(raw, 32))
        issues.push({ field: key, message: `${field.label} must be 0x followed by 64 hex characters.` });
      else claims[field.name] = raw.toLowerCase();
    } else {
      claims[field.name] = raw;
    }
  }

  const validity = input.validitySeconds;
  if (
    !Number.isInteger(validity) ||
    validity < MIN_SIGNATURE_WINDOW_SECONDS ||
    validity > MAX_SIGNATURE_WINDOW_SECONDS
  ) {
    issues.push({
      field: "validitySeconds",
      message: `The signature window must be between ${MIN_SIGNATURE_WINDOW_SECONDS / 60} minute and 30 days.`,
    });
  }

  const submitter = pinnedSubmitter(options.submitter);
  if (!submitter) {
    issues.push({
      field: "submitter",
      message: "The issuance must be pinned to the account that sends it (connect the issuer wallet).",
    });
  }
  if (issues.length > 0 || !schemaPreset || !idType || !idValue || issuedAt === null || !submitter) {
    return { ok: false, issues };
  }

  const salt = options.salt ?? generateSubjectSalt();
  const document: CredentialDocument = {
    version: CREDENTIAL_DOCUMENT_VERSION,
    issuer: issuerName,
    schema: schemaPreset.descriptor,
    reference,
    subject: { idType, idValue, salt },
    issuedAt,
    expiresAt,
    claims,
  };
  const model = deriveCredential(document);
  if (!model.ok) {
    return { ok: false, issues: model.issues.map(i => ({ field: formFieldOf(i.field), message: i.message })) };
  }
  const signedAt = BigInt(Math.floor(options.nowSeconds));
  const event = toCredentialEvent(model.value, { signedAt, validUntil: signedAt + BigInt(validity), submitter });
  return { ok: true, value: { event, credentialId: model.value.credentialId, subjectSalt: salt as Hex, document } };
}

export function buildRevocationDraft(input: {
  credentialId: string;
  issuer: string;
  reason: RevocationReason;
  nowSeconds: number;
}): FieldsResult<CredentialRevocation> {
  const issues: CredentialFieldIssue[] = [];
  if (!isCredentialId(input.credentialId)) {
    issues.push({ field: "credentialId", message: "Enter a credential ID (0x followed by 64 hex characters)." });
  }
  if (!REVOCATION_REASONS.some(r => r.name === input.reason)) {
    issues.push({ field: "reason", message: "Select a revocation reason." });
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      version: CREDENTIAL_REVOCATION_VERSION,
      credentialId: input.credentialId.trim().toLowerCase() as Hex,
      issuer: input.issuer.toLowerCase() as Hex,
      reasonCode: revocationReasonCode(input.reason),
      signedAt: BigInt(Math.floor(input.nowSeconds)),
    },
  };
}
