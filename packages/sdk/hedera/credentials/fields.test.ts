import { describe, expect, it } from "vitest";
import { TypedDataEncoder, ZeroAddress, ZeroHash, keccak256, recoverAddress, toUtf8Bytes } from "ethers";
import { CREDENTIAL_EVENT_TYPES, computeCredentialDigest, validateCredentialEvent } from "../hcs/credential-envelope";
import {
  CREDENTIAL_SCHEMA_PRESETS,
  buildCredentialDraft,
  buildRevocationDraft,
  normalizeSubjectId,
  parseIsoDate,
  revocationReasonCode,
} from "./fields";
import type { CredentialDraftInput } from "./fields";
import { deriveCredential, parseSchemaDescriptor } from "./schema";
import { credentialEventTypedData, credentialRevocationTypedData, serializeCredentialEvent } from "./signing";
import { CHAIN_ID, DRAFT_INPUT, ISSUER_ADDRESS, ISSUER_WALLET, NOW_MS, REGISTRY_ADDRESS } from "./issuer-test-fixtures";
import { CREDENTIAL_EXAMPLES, EVENT_ATTENDANCE } from "./test-fixtures";

const NOW = NOW_MS / 1000;
const OPTIONS = { nowSeconds: NOW, submitter: ISSUER_ADDRESS };

/** docs/credential-schema.md §6, event attendance, typed into the console form. */
const EVENT_ATTENDANCE_FORM: CredentialDraftInput = {
  issuerName: "hedera-hackathon",
  schema: "event-attendance.v1(string eventName,uint64 eventDate,string role)",
  reference: "HH-2026-ATT-000123",
  subjectIdType: "email",
  subjectIdValue: "  Alice@Example.com ",
  issuedOn: "2026-09-12",
  expiresOn: "",
  claims: { eventName: "Hedera Hackathon São Paulo 2026", eventDate: "2026-09-12", role: "participant" },
  validitySeconds: 600,
};

describe("issuer form presets", () => {
  it("offers canonical descriptors identical to the spec's example schemas", () => {
    const specSchemas = Object.values(CREDENTIAL_EXAMPLES).map(d => d.schema);
    for (const preset of CREDENTIAL_SCHEMA_PRESETS) {
      expect(parseSchemaDescriptor(preset.descriptor).ok).toBe(true);
      expect(preset.claims.map(c => c.name)).toEqual(preset.schema.fields.map(f => f.name));
      expect(preset.claims.every(c => c.placeholder.length > 0)).toBe(true);
    }
    expect(specSchemas).toContain(CREDENTIAL_SCHEMA_PRESETS[0].descriptor);
  });

  it("normalizes holder identifiers per type before they are committed", () => {
    expect(normalizeSubjectId("email", " Maria.Silva@Example.COM ")).toBe("maria.silva@example.com");
    expect(normalizeSubjectId("email", "not-an-email")).toBeNull();
    expect(normalizeSubjectId("cpf", "123.456.789-09")).toBe("12345678909");
    expect(normalizeSubjectId("cpf", "1234")).toBeNull();
    expect(normalizeSubjectId("student-id", " 2026-000777 ")).toBe("2026-000777");
    expect(normalizeSubjectId("did", "   ")).toBeNull();
  });

  it("parses calendar dates as UTC midnight and rejects impossible ones", () => {
    expect(parseIsoDate("2026-09-12")).toBe(1_789_171_200);
    expect(parseIsoDate("2026-02-30")).toBeNull();
    expect(parseIsoDate("12/09/2026")).toBeNull();
  });
});

describe("buildCredentialDraft (over schema.ts)", () => {
  it("reproduces the spec's test vector exactly: same credentialId, hashes and commitment as deriveCredential", () => {
    const draft = buildCredentialDraft(EVENT_ATTENDANCE_FORM, {
      ...OPTIONS,
      salt: EVENT_ATTENDANCE.subject.salt as never,
    });
    if (!draft.ok) throw new Error(JSON.stringify(draft.issues));
    const spec = deriveCredential(EVENT_ATTENDANCE);
    if (!spec.ok) throw new Error("spec vector invalid");
    expect(draft.value.credentialId).toBe(spec.value.credentialId);
    expect(draft.value.event.issuer).toBe(spec.value.issuer);
    expect(draft.value.event.externalCredentialId).toBe(spec.value.externalCredentialId);
    expect(draft.value.event.schemaId).toBe(spec.value.schemaId);
    expect(draft.value.event.subjectCommitment).toBe(spec.value.subjectCommitment);
    expect(draft.value.event.credentialHash).toBe(spec.value.credentialHash);
    expect(draft.value.credentialId.startsWith("0xe0b511e6")).toBe(true);
    expect(draft.value.document.subject.idValue).toBe("alice@example.com");
  });

  it("builds a valid event whose identity does not depend on the salt, the clock or the content", () => {
    const a = buildCredentialDraft(DRAFT_INPUT, OPTIONS);
    const b = buildCredentialDraft(
      { ...DRAFT_INPUT, claims: { ...DRAFT_INPUT.claims, grade: "B" } },
      { ...OPTIONS, nowSeconds: NOW + 100 },
    );
    if (!a.ok || !b.ok) throw new Error("draft failed");
    expect(validateCredentialEvent(a.value.event).ok).toBe(true);
    expect(b.value.credentialId).toBe(a.value.credentialId);
    expect(b.value.event.credentialHash).not.toBe(a.value.event.credentialHash);
    expect(b.value.subjectSalt).not.toBe(a.value.subjectSalt);
    expect(a.value.event.validUntil - a.value.event.signedAt).toBe(600n);
    expect(JSON.stringify(serializeCredentialEvent(a.value.event))).not.toContain("maria");
  });

  it("commits the expiry date: a credential that expires has another credentialHash, same credentialId", () => {
    const salt = `0x${"5a".repeat(32)}` as const;
    const never = buildCredentialDraft(DRAFT_INPUT, { ...OPTIONS, salt });
    const expiring = buildCredentialDraft({ ...DRAFT_INPUT, expiresOn: "2028-09-21" }, { ...OPTIONS, salt });
    if (!never.ok || !expiring.ok) throw new Error("draft failed");
    expect(expiring.value.document.expiresAt).toBe(parseIsoDate("2028-09-21"));
    expect(expiring.value.credentialId).toBe(never.value.credentialId);
    expect(expiring.value.event.credentialHash).not.toBe(never.value.event.credentialHash);
  });

  describe("submitter pin (docs/security.md T-5/F-1)", () => {
    it("pins the event to the account that sends issue()", () => {
      const draft = buildCredentialDraft(DRAFT_INPUT, { ...OPTIONS, submitter: ISSUER_WALLET.address });
      expect(draft.ok && draft.value.event.submitter).toBe(ISSUER_ADDRESS);
    });

    it.each([
      ["missing", undefined],
      ["the zero address", ZeroAddress],
      ["malformed", "0x1234"],
    ])("refuses to build an unpinned issuance when the submitter is %s", (_label, submitter) => {
      const draft = buildCredentialDraft(DRAFT_INPUT, { nowSeconds: NOW, submitter: submitter as string });
      expect(draft.ok).toBe(false);
      expect(!draft.ok && draft.issues.map(i => i.field)).toEqual(["submitter"]);
    });
  });

  it("reports every invalid field at once, keyed by the form field", () => {
    const result = buildCredentialDraft(
      {
        issuerName: "",
        schema: CREDENTIAL_SCHEMA_PRESETS[1].descriptor,
        reference: " ",
        subjectIdType: "cpf",
        subjectIdValue: "123",
        issuedOn: "21/09/2026",
        expiresOn: "soon",
        claims: { courseCode: "CS-301", completedOn: "2026-13-01", hours: "sixty", grade: "A" },
        validitySeconds: 5,
      },
      OPTIONS,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map(i => i.field).sort()).toEqual(
      [
        "issuerName",
        "reference",
        "subjectIdValue",
        "issuedOn",
        "expiresOn",
        "claims.courseName",
        "claims.completedOn",
        "claims.hours",
        "validitySeconds",
      ].sort(),
    );
  });

  it("maps the spec's own validation back to form fields", () => {
    const result = buildCredentialDraft({ ...DRAFT_INPUT, issuerName: "Acme University" }, OPTIONS);
    expect(!result.ok && result.issues.map(i => i.field)).toEqual(["issuerName"]);
  });
});

describe("revocation drafts", () => {
  it("builds revocation evidence with a reason code and validates the credential id", () => {
    const ok = buildRevocationDraft({
      credentialId: `0x${"AB".repeat(32)}`,
      issuer: `0x${"44".repeat(32)}`,
      reason: "superseded",
      nowSeconds: NOW,
    });
    expect(ok.ok && ok.value.reasonCode).toBe(keccak256(toUtf8Bytes("superseded")));
    expect(ok.ok && ok.value.credentialId).toBe(`0x${"ab".repeat(32)}`);
    expect(revocationReasonCode("unspecified")).toBe(ZeroHash);
    const bad = buildRevocationDraft({
      credentialId: "0x12",
      issuer: ZeroHash,
      reason: "nope" as never,
      nowSeconds: 0,
    });
    expect(!bad.ok && bad.issues.map(i => i.field)).toEqual(["credentialId", "reason"]);
  });
});

describe("EIP-712 payloads for wallets", () => {
  const domain = { chainId: CHAIN_ID, verifyingContract: REGISTRY_ADDRESS };

  it("is exactly what the registry verifies: same digest, recoverable by a wallet signature", async () => {
    const draft = buildCredentialDraft(DRAFT_INPUT, OPTIONS);
    if (!draft.ok) throw new Error("draft failed");
    const payload = credentialEventTypedData(draft.value.event, domain);
    expect(payload.primaryType).toBe("CredentialEvent");
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    const types = { ...payload.types };
    delete types.EIP712Domain;
    expect(types).toEqual(CREDENTIAL_EVENT_TYPES);
    expect(TypedDataEncoder.hash(payload.domain, types, payload.message)).toBe(
      computeCredentialDigest(draft.value.event, domain),
    );
    const signature = await ISSUER_WALLET.signTypedData(payload.domain, types, payload.message);
    expect(recoverAddress(computeCredentialDigest(draft.value.event, domain), signature).toLowerCase()).toBe(
      ISSUER_ADDRESS,
    );
  });

  it("builds the revocation payload under the same domain", () => {
    const revocation = buildRevocationDraft({
      credentialId: `0x${"ab".repeat(32)}`,
      issuer: `0x${"44".repeat(32)}`,
      reason: "unspecified",
      nowSeconds: NOW,
    });
    if (!revocation.ok) throw new Error("revocation failed");
    const payload = credentialRevocationTypedData(revocation.value, domain);
    expect(payload.primaryType).toBe("CredentialRevocation");
    expect(payload.domain).toEqual({
      name: "HederaVerifiableCredentials",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: REGISTRY_ADDRESS,
    });
    expect(payload.message.signedAt).toBe(String(NOW));
  });
});
